import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { Language } from "../../utils/language.js";

/**
 * SMS/WhatsApp providers sit behind this interface so they can be swapped
 * (MSG91, Twilio, ...) without touching business code.
 */
export type MessageChannel = "SMS" | "WHATSAPP";

export interface SmsMessage {
  /** E.164 phone number */
  to: string;
  /** Full message text. Used by providers that send free text (Twilio, the console mock). */
  body: string;
  /** Logical template name, e.g. "booking_confirmed". Template-based providers (MSG91, DLT) map it to an approved template id. */
  template: string;
  /** Values for the template's placeholders. Template-based providers send these instead of `body`. */
  variables?: Record<string, string>;
  channel?: MessageChannel;
  /** Language of `body`. A template-based provider uses its Hindi template for "hi" when it has one. */
  language?: Language;
}

export interface SmsResult {
  providerMessageId?: string;
}

export interface SmsProvider {
  readonly name: string;
  readonly supportsWhatsApp: boolean;
  send(message: SmsMessage): Promise<SmsResult>;
}

/** A provider call failed (the dispatcher records it and retries later). */
export class SmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsError";
  }
}

const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Mock: prints to the API console in development, records in memory for tests
// ---------------------------------------------------------------------------

export const mockOutbox: SmsMessage[] = [];

class MockSmsProvider implements SmsProvider {
  readonly name = "mock";
  readonly supportsWhatsApp = true;

  async send(message: SmsMessage): Promise<SmsResult> {
    mockOutbox.push(message);
    if (mockOutbox.length > 500) mockOutbox.shift();
    if (env.NODE_ENV !== "test") {
      // Intentionally console, not the logger: the logger redacts codes.
      console.warn(
        `\n┌─ MOCK ${message.channel ?? "SMS"} ─────────────────────────────\n│ to:   ${message.to}\n│ text: ${message.body}\n└──────────────────────────────────────────\n`,
      );
    }
    return { providerMessageId: `mock-${Date.now()}` };
  }
}

// ---------------------------------------------------------------------------
// MSG91 (India). Messages are DLT-registered templates; we send the template id
// and the variable values, never free text.
// https://docs.msg91.com/sms/send-sms (Flow API)
// ---------------------------------------------------------------------------

const MSG91_FLOW_URL = "https://control.msg91.com/api/v5/flow";
/** DLT variables are limited to 30 characters. */
const MSG91_MAX_VAR = 30;

export class Msg91Provider implements SmsProvider {
  readonly name = "msg91";
  readonly supportsWhatsApp = false;

  constructor(
    private readonly authKey: string,
    private readonly templateIds: Record<string, string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
    /** DLT template ids of the Hindi texts. A message without one is sent in English. */
    private readonly hindiTemplateIds: Record<string, string | undefined> = {},
  ) {}

  async send(message: SmsMessage): Promise<SmsResult> {
    if (message.channel === "WHATSAPP") throw new SmsError("MSG91 provider does not send WhatsApp");
    const templateId =
      (message.language === "hi" ? this.hindiTemplateIds[message.template] : undefined) ??
      this.templateIds[message.template];
    if (!templateId)
      throw new SmsError(`No MSG91 template id configured for "${message.template}"`);

    const variables = Object.fromEntries(
      Object.entries(message.variables ?? {}).map(([k, v]) => [
        k,
        v.length > MSG91_MAX_VAR ? `${v.slice(0, MSG91_MAX_VAR - 1)}…` : v,
      ]),
    );
    let res: Response;
    try {
      res = await this.fetchImpl(MSG91_FLOW_URL, {
        method: "POST",
        headers: {
          authkey: this.authKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          template_id: templateId,
          short_url: "0",
          // MSG91 wants the number without "+", country code first.
          recipients: [{ mobiles: message.to.replace(/^\+/, ""), ...variables }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SmsError(`MSG91 unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as { type?: string; message?: string } | null;
    if (!res.ok || json?.type !== "success") {
      throw new SmsError(`MSG91: ${json?.message ?? `HTTP ${res.status}`}`);
    }
    return { providerMessageId: json.message };
  }
}

// ---------------------------------------------------------------------------
// Twilio: SMS and WhatsApp, free text.
// https://www.twilio.com/docs/messaging/api/message-resource
// ---------------------------------------------------------------------------

export class TwilioProvider implements SmsProvider {
  readonly name = "twilio";
  readonly supportsWhatsApp = true;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly smsFrom: string,
    private readonly whatsappFrom: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<SmsResult> {
    const whatsapp = message.channel === "WHATSAPP";
    if (whatsapp && !this.whatsappFrom)
      throw new SmsError("TWILIO_WHATSAPP_FROM is not configured");
    const form = new URLSearchParams({
      To: whatsapp ? `whatsapp:${message.to}` : message.to,
      From: whatsapp ? `whatsapp:${this.whatsappFrom}` : this.smsFrom,
      Body: message.body,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch (err) {
      throw new SmsError(`Twilio unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as {
      sid?: string;
      message?: string;
      code?: number;
    } | null;
    if (!res.ok || !json?.sid) {
      throw new SmsError(
        `Twilio: ${json?.message ?? `HTTP ${res.status}`}${json?.code ? ` (code ${json.code})` : ""}`,
      );
    }
    return { providerMessageId: json.sid };
  }
}

// ---------------------------------------------------------------------------

function createSmsProvider(name: typeof env.SMS_PROVIDER): SmsProvider {
  switch (name) {
    case "mock":
      return new MockSmsProvider();
    case "msg91":
      return new Msg91Provider(
        env.MSG91_AUTH_KEY!,
        {
          otp_login: env.MSG91_TEMPLATE_OTP_LOGIN,
          otp_verify: env.MSG91_TEMPLATE_OTP_VERIFY ?? env.MSG91_TEMPLATE_OTP_LOGIN,
          blood_request_alert: env.MSG91_TEMPLATE_BLOOD_REQUEST_ALERT,
          blood_request_bank_alert: env.MSG91_TEMPLATE_BLOOD_REQUEST_BANK_ALERT,
          blood_request_answered: env.MSG91_TEMPLATE_BLOOD_REQUEST_ANSWERED,
          donation_recorded: env.MSG91_TEMPLATE_DONATION_RECORDED,
          booking_confirmed: env.MSG91_TEMPLATE_BOOKING_CONFIRMED,
          appointment_reminder: env.MSG91_TEMPLATE_APPOINTMENT_REMINDER,
          appointment_cancelled: env.MSG91_TEMPLATE_APPOINTMENT_CANCELLED,
          appointment_rescheduled: env.MSG91_TEMPLATE_APPOINTMENT_RESCHEDULED,
          waitlist_slot_open: env.MSG91_TEMPLATE_WAITLIST_SLOT_OPEN,
        },
        fetch,
        env.MSG91_HINDI_TEMPLATE_IDS,
      );
    case "twilio":
      return new TwilioProvider(
        env.TWILIO_ACCOUNT_SID!,
        env.TWILIO_AUTH_TOKEN!,
        env.TWILIO_FROM!,
        env.TWILIO_WHATSAPP_FROM,
      );
  }
}

const baseProvider = createSmsProvider(env.SMS_PROVIDER);
let override: SmsProvider | null = null;

/** The provider the app sends through. Delegates, so tests can swap the real one for a fake. */
export const sms: SmsProvider = {
  get name() {
    return (override ?? baseProvider).name;
  },
  get supportsWhatsApp() {
    return (override ?? baseProvider).supportsWhatsApp;
  },
  send: (message) => (override ?? baseProvider).send(message),
};

/** Tests only: replace the provider (null restores the configured one). */
export function setSmsProviderOverride(provider: SmsProvider | null): void {
  override = provider;
}

logger.debug({ provider: baseProvider.name }, "sms provider ready");
