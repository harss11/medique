import { z } from "zod";
import { env } from "../../config/env.js";
import { Prisma } from "../../generated/prisma/client.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { verifyRazorpayWebhookSignature } from "../../services/payment/index.js";
import { audit } from "../../utils/audit.js";
import { sha256 } from "../../utils/crypto.js";
import { AppError } from "../../utils/http.js";
import {
  confirmAppointment,
  releaseHoldAfterPaymentFailure,
} from "../appointments/booking.service.js";
import { applyRefundProcessed, markRefundFailed } from "./refunds.service.js";

/**
 * Razorpay webhooks: the ONLY thing that confirms an online booking.
 *
 *  - The signature is checked against the raw request body with the webhook secret;
 *    anything unsigned or tampered with is rejected before it is even parsed.
 *  - Every event is stored once, keyed by Razorpay's event id (WebhookEvent). A
 *    replayed event finds its row and does nothing, so duplicates are harmless.
 *  - Handlers are also idempotent in themselves, so a retry after a crash is safe.
 *  - If processing fails we answer 5xx and Razorpay retries (it keeps trying for ~24h).
 */

export type WebhookResult = "processed" | "ignored" | "duplicate";

interface HandlerResult {
  status: "processed" | "ignored";
  note?: string;
}

// Razorpay's JSON is loose (empty `notes` arrive as [] rather than {}), so parse only what we use.
const paymentEntity = z.object({
  id: z.string(),
  order_id: z.string().nullish(),
  amount: z.number().int(),
  currency: z.string(),
  method: z.string().nullish(),
  error_code: z.string().nullish(),
  error_description: z.string().nullish(),
});
const refundEntity = z.object({
  id: z.string(),
  payment_id: z.string().nullish(),
  amount: z.number().int().optional(),
  notes: z.unknown().optional(),
});
const envelope = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: paymentEntity }).optional(),
    refund: z.object({ entity: refundEntity }).optional(),
  }),
});

/** A previous attempt that never finished (process crashed) is retried after this long. */
const STALE_MS = 2 * 60_000;

export async function processRazorpayWebhook(
  rawBody: Buffer,
  headers: { signature?: string; eventId?: string },
): Promise<WebhookResult> {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret)
    throw new AppError(503, "WEBHOOK_NOT_CONFIGURED", "Razorpay webhooks are not configured");
  if (rawBody.length === 0 || !verifyRazorpayWebhookSignature(rawBody, headers.signature, secret)) {
    logger.warn("rejected a webhook with a missing or invalid signature");
    throw new AppError(401, "INVALID_SIGNATURE", "Invalid signature");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw AppError.badRequest("Body is not valid JSON", "INVALID_JSON");
  }
  const eventType =
    typeof (json as { event?: unknown })?.event === "string"
      ? (json as { event: string }).event
      : "unknown";
  // Razorpay sends a unique id per event; if it were ever missing, the body hash still dedupes exact replays.
  const eventId = headers.eventId || `sha256:${sha256(rawBody.toString("utf8"))}`;

  // Record the event. The unique key (provider, eventId) is what makes duplicates harmless.
  let eventRowId: string;
  try {
    const row = await prisma.webhookEvent.create({
      data: { provider: "RAZORPAY", eventId, eventType, payload: json as Prisma.InputJsonValue },
      select: { id: true },
    });
    eventRowId = row.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Seen before. Reprocess only if that attempt failed or got stuck; otherwise it's a duplicate.
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        provider: "RAZORPAY",
        eventId,
        OR: [
          { status: "FAILED" },
          { status: "RECEIVED", receivedAt: { lt: new Date(Date.now() - STALE_MS) } },
        ],
      },
      data: { status: "RECEIVED", receivedAt: new Date(), error: null },
    });
    if (claimed.count === 0) return "duplicate";
    eventRowId = (
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: "RAZORPAY", eventId } },
        select: { id: true },
      })
    ).id;
  }

  try {
    const result = await dispatch(json);
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: {
        status: result.status === "ignored" ? "IGNORED" : "PROCESSED",
        processedAt: new Date(),
        error: result.note ?? null,
      },
    });
    return result.status;
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: {
        status: "FAILED",
        error: (err instanceof Error ? err.message : "unknown error").slice(0, 500),
      },
    });
    throw err; // 5xx: Razorpay will deliver it again
  }
}

async function dispatch(json: unknown): Promise<HandlerResult> {
  const parsed = envelope.safeParse(json);
  if (!parsed.success) return { status: "ignored", note: "unrecognised payload" };
  const { event, payload } = parsed.data;

  switch (event) {
    case "payment.captured":
    case "order.paid":
      return payload.payment
        ? onPaymentCaptured(payload.payment.entity)
        : { status: "ignored", note: "no payment" };
    case "payment.failed":
      return payload.payment
        ? onPaymentFailed(payload.payment.entity)
        : { status: "ignored", note: "no payment" };
    case "refund.processed":
      return payload.refund
        ? onRefundProcessed(payload.refund.entity)
        : { status: "ignored", note: "no refund" };
    case "refund.failed":
      return payload.refund
        ? onRefundFailed(payload.refund.entity)
        : { status: "ignored", note: "no refund" };
    default:
      return { status: "ignored", note: `event ${event} not used` };
  }
}

type PaymentEntity = z.infer<typeof paymentEntity>;
type RefundEntity = z.infer<typeof refundEntity>;

async function onPaymentCaptured(p: PaymentEntity): Promise<HandlerResult> {
  if (!p.order_id) return { status: "ignored", note: "payment has no order" };
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: p.order_id } });
  if (!payment) return { status: "ignored", note: "unknown order" };

  // The order amount was fixed by us when the order was created. If what was captured
  // differs, something is wrong: do not confirm, flag it for a human.
  if (p.amount !== payment.amount || p.currency !== payment.currency) {
    await audit(prisma, {
      actor: null,
      action: "payment.amount_mismatch",
      entityType: "Payment",
      entityId: payment.id,
      hospitalId: payment.hospitalId,
      metadata: {
        expected: payment.amount,
        got: p.amount,
        currency: p.currency,
        gatewayPaymentId: p.id,
      },
    });
    return { status: "ignored", note: "amount mismatch" };
  }

  const { outcome } = await confirmAppointment(
    payment.appointmentId,
    {
      provider: "RAZORPAY",
      method: "ONLINE",
      razorpayOrderId: p.order_id,
      razorpayPaymentId: p.id,
      providerMethod: p.method ?? undefined,
    },
    null,
  );
  return { status: "processed", note: outcome };
}

async function onPaymentFailed(p: PaymentEntity): Promise<HandlerResult> {
  if (!p.order_id) return { status: "ignored", note: "payment has no order" };
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: p.order_id } });
  if (!payment) return { status: "ignored", note: "unknown order" };

  const reason = p.error_description ?? p.error_code ?? "Payment failed";
  // Never downgrade a payment that already succeeded (events can arrive out of order).
  const { count } = await prisma.payment.updateMany({
    where: { id: payment.id, status: { in: ["CREATED", "FAILED"] } },
    data: { status: "FAILED", failureReason: reason.slice(0, 300) },
  });
  if (count === 0) return { status: "ignored", note: "payment already settled" };

  await audit(prisma, {
    actor: null,
    action: "payment.failed",
    entityType: "Payment",
    entityId: payment.id,
    hospitalId: payment.hospitalId,
    metadata: { reason, appointmentId: payment.appointmentId },
  });
  const released = env.RELEASE_HOLD_ON_PAYMENT_FAILURE
    ? await releaseHoldAfterPaymentFailure(payment.appointmentId)
    : false;
  return { status: "processed", note: released ? "hold released" : "hold kept" };
}

async function findRefund(r: RefundEntity) {
  const byGatewayId = await prisma.refund.findUnique({ where: { razorpayRefundId: r.id } });
  if (byGatewayId) return byGatewayId;
  // Our own refund id travels in the notes (Razorpay sends [] when there are none).
  const notes =
    r.notes && typeof r.notes === "object" && !Array.isArray(r.notes)
      ? (r.notes as Record<string, unknown>)
      : {};
  const ours = typeof notes.refundId === "string" ? notes.refundId : null;
  return ours && z.uuid().safeParse(ours).success
    ? prisma.refund.findUnique({ where: { id: ours } })
    : null;
}

async function onRefundProcessed(r: RefundEntity): Promise<HandlerResult> {
  const refund = await findRefund(r);
  if (!refund) return { status: "ignored", note: "refund not made by us" };
  const changed = await prisma.$transaction((tx) => applyRefundProcessed(tx, refund.id, r.id));
  return { status: "processed", note: changed ? "refund completed" : "already completed" };
}

async function onRefundFailed(r: RefundEntity): Promise<HandlerResult> {
  const refund = await findRefund(r);
  if (!refund) return { status: "ignored", note: "refund not made by us" };
  if (refund.status === "PROCESSED") return { status: "ignored", note: "already completed" };
  await markRefundFailed(prisma, refund.id, "The bank or gateway reported the refund as failed");
  return { status: "processed", note: "refund marked failed" };
}
