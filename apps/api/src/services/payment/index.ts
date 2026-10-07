import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import type { PaymentProvider } from "../../generated/prisma/client.js";
import { randomToken } from "../../utils/crypto.js";

/**
 * Payment gateways sit behind one interface so the booking code never talks to
 * Razorpay directly (and tests can use a fake). Amounts are always minor units
 * (paise).
 */

export interface GatewayOrder {
  id: string;
  amount: number;
  currency: string;
}

export interface GatewayRefund {
  id: string;
  /** Razorpay refunds are usually "pending" at first and finish via webhook. */
  status: "pending" | "processed" | "failed";
}

export interface PaymentGateway {
  readonly provider: PaymentProvider;
  createOrder(input: {
    amountMinor: number;
    currency: string;
    /** Our reference (the appointment id), echoed back by the provider. */
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  refund(input: {
    paymentId: string;
    amountMinor: number;
    /** Same key => same refund, so a retry can never refund twice. */
    idempotencyKey: string;
    notes: Record<string, string>;
  }): Promise<GatewayRefund>;
}

/** A provider call failed. `retryable` tells the refund job whether trying again can help. */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// ---------------------------------------------------------------------------
// Razorpay (REST API over HTTPS, no SDK)
// ---------------------------------------------------------------------------

const RAZORPAY_API = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 15_000;

export class RazorpayGateway implements PaymentGateway {
  readonly provider = "RAZORPAY" as const;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchImpl(`${RAZORPAY_API}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout: the request may or may not have arrived. Safe to retry
      // because refunds carry an idempotency key and orders are re-checked before use.
      throw new GatewayError(`Razorpay unreachable: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => null)) as
      (T & { error?: { code?: string; description?: string } }) | null;
    if (!res.ok || !json) {
      const description = json?.error?.description ?? `HTTP ${res.status}`;
      // 4xx (except rate limiting) will fail the same way again; 5xx and 429 may not.
      const retryable = res.status >= 500 || res.status === 429;
      throw new GatewayError(`Razorpay: ${description}`, retryable, res.status);
    }
    return json;
  }

  async createOrder(input: Parameters<PaymentGateway["createOrder"]>[0]): Promise<GatewayOrder> {
    const order = await this.call<{ id: string; amount: number; currency: string }>("/orders", {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return { id: order.id, amount: order.amount, currency: order.currency };
  }

  async refund(input: Parameters<PaymentGateway["refund"]>[0]): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>(
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      { amount: input.amountMinor, speed: "normal", notes: input.notes },
      { "X-Refund-Idempotency": input.idempotencyKey },
    );
    const status =
      refund.status === "processed"
        ? "processed"
        : refund.status === "failed"
          ? "failed"
          : "pending";
    return { id: refund.id, status };
  }
}

// ---------------------------------------------------------------------------
// Mock (development and tests): everything succeeds instantly
// ---------------------------------------------------------------------------

export class MockGateway implements PaymentGateway {
  readonly provider = "MOCK" as const;

  async createOrder(input: Parameters<PaymentGateway["createOrder"]>[0]): Promise<GatewayOrder> {
    return {
      id: `order_mock_${randomToken(8)}`,
      amount: input.amountMinor,
      currency: input.currency,
    };
  }

  async refund(): Promise<GatewayRefund> {
    return { id: `rfnd_mock_${randomToken(8)}`, status: "processed" };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let razorpay: RazorpayGateway | null = null;
const mock = new MockGateway();
const overrides = new Map<PaymentProvider, PaymentGateway>();

/** The gateway that handles a given provider's payments (refunds always go back through the original one). */
export function gatewayFor(provider: PaymentProvider): PaymentGateway {
  const override = overrides.get(provider);
  if (override) return override;
  if (provider === "MOCK") return mock;
  if (provider === "RAZORPAY") {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new GatewayError("Razorpay keys are not configured", false);
    }
    razorpay ??= new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
    return razorpay;
  }
  throw new GatewayError(`No online gateway for ${provider}`, false);
}

/** Which gateway creates orders for new bookings. */
export function activeGateway(): PaymentGateway {
  return gatewayFor(env.PAYMENT_MODE === "razorpay" ? "RAZORPAY" : "MOCK");
}

/** Tests inject a fake Razorpay. Pass null to remove it. */
export function setGatewayOverride(
  provider: PaymentProvider,
  gateway: PaymentGateway | null,
): void {
  if (gateway) overrides.set(provider, gateway);
  else overrides.delete(provider);
}

// ---------------------------------------------------------------------------
// Webhook signature (Razorpay signs the raw body with the webhook secret, HMAC-SHA256 hex)
// ---------------------------------------------------------------------------

export function razorpayWebhookSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time check of the X-Razorpay-Signature header against the raw request body. */
export function verifyRazorpayWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = Buffer.from(razorpayWebhookSignature(rawBody, secret), "hex");
  const given = Buffer.from(signatureHeader, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
