import { env } from "../src/config/env.js";
import type { GatewayError } from "../src/services/payment/index.js";
import {
  razorpayWebhookSignature,
  setGatewayOverride,
  type GatewayOrder,
  type GatewayRefund,
  type PaymentGateway,
} from "../src/services/payment/index.js";
import { randomToken } from "../src/utils/crypto.js";

export const WEBHOOK_SECRET = "whsec_integration_secret";
export const RAZORPAY_KEY = "rzp_test_integration";

/** Razorpay without the network: records every call and can be told to fail. */
export class FakeRazorpay implements PaymentGateway {
  readonly provider = "RAZORPAY" as const;
  orders: Array<{ id: string; amountMinor: number; receipt: string }> = [];
  refunds: Array<{ paymentId: string; amountMinor: number; idempotencyKey: string }> = [];
  /** What a refund answers: finished at once, or "pending" until the webhook says so. */
  refundStatus: GatewayRefund["status"] = "processed";
  refundError: GatewayError | null = null;
  /** Widens race windows so concurrency tests mean something. */
  delayMs = 0;

  async createOrder(input: Parameters<PaymentGateway["createOrder"]>[0]): Promise<GatewayOrder> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const id = `order_fake_${randomToken(8)}`;
    this.orders.push({ id, amountMinor: input.amountMinor, receipt: input.receipt });
    return { id, amount: input.amountMinor, currency: input.currency };
  }

  async refund(input: Parameters<PaymentGateway["refund"]>[0]): Promise<GatewayRefund> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.refundError) throw this.refundError;
    this.refunds.push({
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
    });
    return { id: `rfnd_fake_${randomToken(8)}`, status: this.refundStatus };
  }
}

/** Switches the API into Razorpay mode with a fake gateway. Call once per test file. */
export function useFakeRazorpay(): FakeRazorpay {
  env.PAYMENT_MODE = "razorpay";
  env.RAZORPAY_KEY_ID = RAZORPAY_KEY;
  env.RAZORPAY_KEY_SECRET = "secret_integration";
  env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const fake = new FakeRazorpay();
  setGatewayOverride("RAZORPAY", fake);
  return fake;
}

export function paymentEvent(
  event: "payment.captured" | "order.paid" | "payment.failed",
  p: {
    orderId: string;
    paymentId?: string;
    amount: number;
    currency?: string;
    method?: string;
    error?: string;
  },
) {
  return {
    event,
    payload: {
      payment: {
        entity: {
          id: p.paymentId ?? `pay_fake_${randomToken(8)}`,
          order_id: p.orderId,
          amount: p.amount,
          currency: p.currency ?? "INR",
          method: p.method ?? "upi",
          status: event === "payment.failed" ? "failed" : "captured",
          ...(p.error ? { error_code: "BAD_REQUEST_ERROR", error_description: p.error } : {}),
        },
      },
    },
  };
}

export function refundEvent(
  event: "refund.processed" | "refund.failed",
  r: { refundId: string; paymentId?: string; amount?: number; notes?: unknown },
) {
  return {
    event,
    payload: {
      refund: {
        entity: {
          id: r.refundId,
          payment_id: r.paymentId ?? "pay_x",
          amount: r.amount ?? 0,
          notes: r.notes ?? [],
        },
      },
    },
  };
}

export interface WebhookReply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** Sends a webhook the way Razorpay does: raw JSON body, signed with the shared secret. */
export async function postWebhook(
  base: string,
  event: unknown,
  options: { eventId?: string; secret?: string; rawBody?: string; signature?: string | null } = {},
): Promise<WebhookReply> {
  const raw = options.rawBody ?? JSON.stringify(event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Razorpay-Event-Id": options.eventId ?? `evt_${randomToken(10)}`,
  };
  if (options.signature !== null) {
    headers["X-Razorpay-Signature"] =
      options.signature ?? razorpayWebhookSignature(raw, options.secret ?? WEBHOOK_SECRET);
  }
  const res = await fetch(`${base}/webhooks/razorpay`, { method: "POST", headers, body: raw });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

/** Polls until `read` returns something truthy (background work like refunds settles asynchronously). */
export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}
