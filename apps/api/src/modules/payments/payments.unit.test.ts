import { describe, expect, it, vi } from "vitest";
import {
  GatewayError,
  MockGateway,
  RazorpayGateway,
  razorpayWebhookSignature,
  verifyRazorpayWebhookSignature,
} from "../../services/payment/index.js";
import { Msg91Provider, SmsError, TwilioProvider } from "../../services/sms/index.js";
import {
  dltText,
  pickVariables,
  renderBody,
  TEMPLATE_VARIABLES,
} from "../notifications/templates.js";
import { describePolicy, refundDecision, type RefundPolicy } from "./refund-policy.js";

const POLICY: RefundPolicy = { fullRefundHours: 24, partialPercent: 50 };
const NOW = new Date("2026-10-05T10:00:00Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const decide = (hours: number, overrides: Partial<Parameters<typeof refundDecision>[0]> = {}) =>
  refundDecision({
    paidAmount: 50_000,
    slotStart: inHours(hours),
    now: NOW,
    policy: POLICY,
    initiator: "PATIENT",
    ...overrides,
  });

describe("refund policy", () => {
  it("refunds in full when cancelled at least 24 hours before", () => {
    expect(decide(48)).toEqual({ amount: 50_000, percent: 100 });
    expect(decide(24)).toEqual({ amount: 50_000, percent: 100 });
  });

  it("refunds the partial share when cancelled later", () => {
    expect(decide(23.99)).toEqual({ amount: 25_000, percent: 50 });
    expect(decide(2)).toEqual({ amount: 25_000, percent: 50 });
  });

  it("refunds nothing for a no-show", () => {
    expect(decide(-1, { initiator: "NO_SHOW" })).toEqual({ amount: 0, percent: 0 });
  });

  it("always refunds in full when the hospital or the system cancels", () => {
    expect(decide(1, { initiator: "HOSPITAL" })).toEqual({ amount: 50_000, percent: 100 });
    expect(decide(0.1, { initiator: "SYSTEM" })).toEqual({ amount: 50_000, percent: 100 });
  });

  it("follows the hospital's own settings", () => {
    const strict: RefundPolicy = { fullRefundHours: 72, partialPercent: 20 };
    expect(decide(48, { policy: strict })).toEqual({ amount: 10_000, percent: 20 });
    expect(decide(48, { policy: { fullRefundHours: 0, partialPercent: 0 } })).toEqual({
      amount: 50_000,
      percent: 100,
    });
    expect(decide(0.5, { policy: { fullRefundHours: 24, partialPercent: 0 } })).toEqual({
      amount: 0,
      percent: 0,
    });
  });

  it("rounds to a whole paisa and never exceeds what was paid", () => {
    expect(
      decide(2, { paidAmount: 33_333, policy: { fullRefundHours: 24, partialPercent: 33 } }).amount,
    ).toBe(11_000);
    expect(
      decide(2, { paidAmount: 1, policy: { fullRefundHours: 24, partialPercent: 100 } }).amount,
    ).toBe(1);
    expect(decide(2, { policy: { fullRefundHours: 24, partialPercent: 250 } }).amount).toBe(50_000);
  });

  it("describes the policy for patients", () => {
    expect(describePolicy(POLICY)).toBe(
      "Full refund if you cancel at least 24 hours before; 50% refund after that.",
    );
    expect(describePolicy({ fullRefundHours: 12, partialPercent: 0 })).toBe(
      "Full refund if you cancel at least 12 hours before; no refund after that.",
    );
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test_secret";
  const body = Buffer.from('{"event":"payment.captured","payload":{}}');

  it("accepts the correct signature", () => {
    expect(
      verifyRazorpayWebhookSignature(body, razorpayWebhookSignature(body, secret), secret),
    ).toBe(true);
  });

  it("rejects missing, malformed, wrong-secret and tampered requests", () => {
    const good = razorpayWebhookSignature(body, secret);
    expect(verifyRazorpayWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, "", secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, "not-hex", secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, good.slice(0, 20), secret)).toBe(false);
    expect(
      verifyRazorpayWebhookSignature(body, razorpayWebhookSignature(body, "other-secret"), secret),
    ).toBe(false);
    expect(
      verifyRazorpayWebhookSignature(
        Buffer.from(body.toString().replace("captured", "failed")),
        good,
        secret,
      ),
    ).toBe(false);
  });
});

function fakeFetch(status: number, json: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("RazorpayGateway", () => {
  it("creates an order with basic auth and the amount in paise", async () => {
    const f = fakeFetch(200, { id: "order_X", amount: 50_000, currency: "INR" });
    const order = await new RazorpayGateway("rzp_test_key", "secret", f).createOrder({
      amountMinor: 50_000,
      currency: "INR",
      receipt: "a".repeat(60),
      notes: { appointmentId: "abc" },
    });
    expect(order).toEqual({ id: "order_X", amount: 50_000, currency: "INR" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("rzp_test_key:secret").toString("base64")}`,
    );
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      amount: 50_000,
      currency: "INR",
      notes: { appointmentId: "abc" },
    });
    expect(sent.receipt).toHaveLength(40); // Razorpay's limit
  });

  it("refunds with the refund id as idempotency key", async () => {
    const f = fakeFetch(200, { id: "rfnd_1", status: "processed" });
    const result = await new RazorpayGateway("k", "s", f).refund({
      paymentId: "pay_1",
      amountMinor: 25_000,
      idempotencyKey: "refund-row-id",
      notes: {},
    });
    expect(result).toEqual({ id: "rfnd_1", status: "processed" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/payments/pay_1/refund");
    expect((init.headers as Record<string, string>)["X-Refund-Idempotency"]).toBe("refund-row-id");
    expect(JSON.parse(init.body as string)).toMatchObject({ amount: 25_000, speed: "normal" });
  });

  it("maps statuses and tells retryable errors from permanent ones", async () => {
    const refund = (f: typeof fetch) =>
      new RazorpayGateway("k", "s", f).refund({
        paymentId: "p",
        amountMinor: 1,
        idempotencyKey: "i",
        notes: {},
      });
    expect(
      (await refund(fakeFetch(200, { id: "r", status: "created" }) as unknown as typeof fetch))
        .status,
    ).toBe("pending");

    const permanent = await refund(
      fakeFetch(400, {
        error: { description: "Refund amount too high" },
      }) as unknown as typeof fetch,
    ).catch((e) => e);
    expect(permanent).toBeInstanceOf(GatewayError);
    expect(permanent).toMatchObject({ retryable: false, status: 400 });
    expect(permanent.message).toContain("Refund amount too high");

    for (const status of [500, 502, 429]) {
      const e = await refund(fakeFetch(status, {}) as unknown as typeof fetch).catch((x) => x);
      expect(e).toMatchObject({ retryable: true, status });
    }
    const network = await refund((async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch).catch((e) => e);
    expect(network).toMatchObject({ retryable: true });
  });

  it("the mock gateway succeeds instantly", async () => {
    const mock = new MockGateway();
    expect((await mock.refund()).status).toBe("processed");
    expect(
      (await mock.createOrder({ amountMinor: 100, currency: "INR", receipt: "r", notes: {} }))
        .amount,
    ).toBe(100);
  });
});

describe("message templates", () => {
  const vars = {
    name: "Aarav",
    doctor: "Dr. Mehta",
    hospital: "Sunrise",
    date: "Mon, 12 Oct",
    time: "9:30 am",
    token: "7",
    refund: "Refund of Rs.500.",
  };

  it("render every placeholder", () => {
    expect(renderBody("booking_confirmed", vars)).toBe(
      "MediQ: Booking confirmed. Aarav with Dr. Mehta at Sunrise on Mon, 12 Oct, 9:30 am. Token 7. Show your QR code at reception.",
    );
    expect(renderBody("appointment_cancelled", vars)).toContain("Refund of Rs.500.");
    for (const template of Object.keys(TEMPLATE_VARIABLES) as Array<
      keyof typeof TEMPLATE_VARIABLES
    >) {
      expect(renderBody(template, vars)).not.toMatch(/[{}]/);
    }
  });

  it("only pass the variables a template declares", () => {
    expect(Object.keys(pickVariables("appointment_cancelled", vars)).sort()).toEqual([
      "date",
      "doctor",
      "refund",
      "time",
    ]);
  });

  it("give the exact text to register with the SMS regulator (DLT)", () => {
    expect(dltText("appointment_reminder")).toBe(
      "MediQ reminder: ##name##'s appointment with ##doctor## at ##hospital## is today at ##time##. Token ##token##.",
    );
  });
});

describe("Msg91Provider", () => {
  const templates = { booking_confirmed: "tpl_1" };

  it("sends the template id and variables, with the number in MSG91's format", async () => {
    const f = fakeFetch(200, { type: "success", message: "req-123" });
    const result = await new Msg91Provider("auth", templates, f).send({
      to: "+919876543210",
      template: "booking_confirmed",
      body: "ignored free text",
      variables: {
        doctor: "Dr. A very long hospital or doctor name that exceeds thirty characters",
      },
    });
    expect(result.providerMessageId).toBe("req-123");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.msg91.com/api/v5/flow");
    expect((init.headers as Record<string, string>).authkey).toBe("auth");
    const sent = JSON.parse(init.body as string);
    expect(sent.template_id).toBe("tpl_1");
    expect(sent.recipients[0].mobiles).toBe("919876543210");
    expect(sent.recipients[0].doctor).toHaveLength(30); // DLT variable limit
    expect(JSON.stringify(sent)).not.toContain("ignored free text");
  });

  it("fails clearly when misconfigured or rejected", async () => {
    const p = new Msg91Provider(
      "auth",
      templates,
      fakeFetch(200, { type: "error", message: "Invalid template" }),
    );
    await expect(p.send({ to: "+919876543210", template: "nope", body: "" })).rejects.toThrow(
      /No MSG91 template/,
    );
    await expect(
      p.send({ to: "+919876543210", template: "booking_confirmed", body: "" }),
    ).rejects.toThrow(/Invalid template/);
    await expect(
      p.send({ to: "+919876543210", template: "booking_confirmed", body: "", channel: "WHATSAPP" }),
    ).rejects.toThrow(SmsError);
  });
});

describe("TwilioProvider", () => {
  it("sends SMS and WhatsApp as free text from the right sender", async () => {
    const f = fakeFetch(201, { sid: "SM123" });
    const p = new TwilioProvider("AC1", "token", "+15005550006", "+14155238886", f);
    expect(
      (await p.send({ to: "+919876543210", template: "x", body: "Hello" })).providerMessageId,
    ).toBe("SM123");
    await p.send({ to: "+919876543210", template: "x", body: "Hello", channel: "WHATSAPP" });

    const [url, sms] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(
      Object.fromEntries(new URLSearchParams((sms.body as URLSearchParams).toString())),
    ).toEqual({
      To: "+919876543210",
      From: "+15005550006",
      Body: "Hello",
    });
    const [, wa] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(
      Object.fromEntries(new URLSearchParams((wa.body as URLSearchParams).toString())),
    ).toMatchObject({
      To: "whatsapp:+919876543210",
      From: "whatsapp:+14155238886",
    });
  });

  it("reports provider errors and a missing WhatsApp sender", async () => {
    const rejected = new TwilioProvider(
      "AC1",
      "t",
      "+1",
      "+2",
      fakeFetch(400, { message: "Invalid 'To' number", code: 21211 }),
    );
    await expect(rejected.send({ to: "+91", template: "x", body: "b" })).rejects.toThrow(
      /Invalid 'To' number \(code 21211\)/,
    );
    const noWa = new TwilioProvider("AC1", "t", "+1", undefined, fakeFetch(201, { sid: "x" }));
    await expect(
      noWa.send({ to: "+91", template: "x", body: "b", channel: "WHATSAPP" }),
    ).rejects.toThrow(/WHATSAPP_FROM/);
  });
});
