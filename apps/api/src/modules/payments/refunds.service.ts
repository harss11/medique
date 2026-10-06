import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma, type DbClient, type TxClient } from "../../lib/prisma.js";
import { GatewayError, gatewayFor } from "../../services/payment/index.js";
import { audit } from "../../utils/audit.js";

/**
 * Refunds are two steps, so money is never lost or paid back twice:
 *
 *  1. `queueRefund` writes a PENDING Refund row inside the database transaction of
 *     whatever caused it (a cancellation, a payment for a lost slot, ...). If that
 *     transaction rolls back, so does the refund; if it commits, the refund exists.
 *  2. `processRefund` calls the gateway afterwards. It can be retried freely: the
 *     refund id is the idempotency key, a lease stops two workers doing it at once,
 *     and a job (`processDueRefunds`) picks up anything left PENDING.
 */

export const MAX_REFUND_ATTEMPTS = 8;
const LEASE_SECONDS = 120;

export interface QueueRefundOptions {
  reason: string;
  /** Policy result, 0-100, kept for display and audit. */
  percent: number;
  initiatedById: string | null;
}

/**
 * Queues a refund of up to `amountMinor`, never more than what is still refundable
 * on the payment. Returns the refund id, or null when there is nothing to refund.
 */
export async function queueRefund(
  tx: TxClient,
  paymentId: string,
  amountMinor: number,
  options: QueueRefundOptions,
): Promise<string | null> {
  if (amountMinor <= 0) return null;

  // Serialise refunds on one payment so concurrent requests can't over-refund.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
  if (locked.length === 0) return null;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (!["CAPTURED", "PARTIALLY_REFUNDED"].includes(payment.status)) return null;

  const committed = await tx.refund.aggregate({
    where: { paymentId, status: { in: ["PENDING", "PROCESSED"] } },
    _sum: { amount: true },
  });
  const refundable = payment.amount - (committed._sum.amount ?? 0);
  const amount = Math.min(amountMinor, refundable);
  if (amount <= 0) return null;

  const refund = await tx.refund.create({
    data: {
      paymentId,
      amount,
      status: "PENDING",
      reason: options.reason,
      percent: options.percent,
      initiatedById: options.initiatedById,
    },
    select: { id: true },
  });
  await audit(tx, {
    actor: null,
    action: "refund.queued",
    entityType: "Refund",
    entityId: refund.id,
    hospitalId: payment.hospitalId,
    after: { paymentId, amount, percent: options.percent },
    metadata: {
      reason: options.reason,
      appointmentId: payment.appointmentId,
      initiatedById: options.initiatedById,
    },
  });
  return refund.id;
}

/** Marks a refund as done and updates the payment totals. Safe to call twice (webhook and API both do). */
export async function applyRefundProcessed(
  tx: TxClient,
  refundId: string,
  gatewayRefundId: string | null,
): Promise<boolean> {
  const found = await tx.refund.findUnique({
    where: { id: refundId },
    select: { paymentId: true },
  });
  if (!found) return false;
  await tx.$queryRaw`SELECT id::text AS id FROM "Payment" WHERE id = ${found.paymentId}::uuid FOR UPDATE`;

  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status === "PROCESSED") return false;

  await tx.refund.update({
    where: { id: refundId },
    data: {
      status: "PROCESSED",
      razorpayRefundId: gatewayRefundId ?? refund.razorpayRefundId,
      processedAt: new Date(),
      error: null,
      nextAttemptAt: null,
    },
  });
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
  const done = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: "PROCESSED" },
    _sum: { amount: true },
  });
  const refundedAmount = done._sum.amount ?? 0;
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      refundedAmount,
      status: refundedAmount >= payment.amount ? "REFUNDED" : "PARTIALLY_REFUNDED",
    },
  });
  await audit(tx, {
    actor: null,
    action: "refund.processed",
    entityType: "Refund",
    entityId: refundId,
    hospitalId: payment.hospitalId,
    after: { amount: refund.amount, refundedAmount, gatewayRefundId },
    metadata: { appointmentId: payment.appointmentId },
  });
  return true;
}

export async function markRefundFailed(
  db: DbClient,
  refundId: string,
  message: string,
): Promise<void> {
  const refund = await db.refund.update({
    where: { id: refundId },
    data: { status: "FAILED", error: message.slice(0, 500), nextAttemptAt: null },
    include: { payment: { select: { hospitalId: true, appointmentId: true } } },
  });
  // A failed refund needs a human: it shows up in the audit log for the admin.
  await audit(db, {
    actor: null,
    action: "refund.failed",
    entityType: "Refund",
    entityId: refundId,
    hospitalId: refund.payment.hospitalId,
    metadata: {
      appointmentId: refund.payment.appointmentId,
      error: message.slice(0, 500),
      amount: refund.amount,
    },
  });
}

export type ProcessRefundResult = "processed" | "pending" | "failed" | "retry" | "skipped";

/**
 * Sends one queued refund to the gateway. Idempotent and safe to call from several
 * places at once: a lease means only one caller does the work at a time.
 */
export async function processRefund(refundId: string): Promise<ProcessRefundResult> {
  const claimed = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE "Refund"
    SET attempts = attempts + 1,
        "nextAttemptAt" = now() + ${LEASE_SECONDS}::float8 * interval '1 second'
    WHERE id = ${refundId}::uuid
      AND status = 'PENDING'
      AND "razorpayRefundId" IS NULL
      AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
    RETURNING attempts`;
  const attempts = claimed[0]?.attempts;
  if (attempts === undefined) return "skipped";

  const refund = await prisma.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { payment: true },
  });
  const { payment } = refund;

  if (payment.provider === "CASH") {
    // Cash was handed over at the desk; the hospital returns it by hand.
    await markRefundFailed(prisma, refundId, "Cash payment: refund the patient at the hospital");
    return "failed";
  }

  try {
    const result = await gatewayFor(payment.provider).refund({
      // Mock payments have no gateway payment id.
      paymentId: payment.razorpayPaymentId ?? payment.id,
      amountMinor: refund.amount,
      idempotencyKey: refund.id,
      notes: { refundId: refund.id, appointmentId: payment.appointmentId },
    });
    if (result.status === "processed") {
      await prisma.$transaction((tx) => applyRefundProcessed(tx, refundId, result.id));
      return "processed";
    }
    if (result.status === "failed") {
      await markRefundFailed(prisma, refundId, "The payment gateway rejected the refund");
      return "failed";
    }
    // Pending at the gateway: the refund.processed webhook finishes it.
    await prisma.refund.update({
      where: { id: refundId },
      data: { razorpayRefundId: result.id, nextAttemptAt: null, error: null },
    });
    return "pending";
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const retryable = err instanceof GatewayError ? err.retryable : true;
    if (!retryable || attempts >= MAX_REFUND_ATTEMPTS) {
      await markRefundFailed(prisma, refundId, message);
      return "failed";
    }
    logger.warn({ refundId, attempts, err: message }, "refund attempt failed, will retry");
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        error: message.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + attempts * env.REFUND_RETRY_MINUTES * 60_000),
      },
    });
    return "retry";
  }
}

/** Fire and forget after the transaction that queued a refund commits. Never throws. */
export function kickRefund(refundId: string | null | undefined): void {
  if (!refundId) return;
  setImmediate(() => {
    processRefund(refundId).catch((err) =>
      logger.error({ err, refundId }, "refund processing crashed"),
    );
  });
}

/** Job: sends refunds that were queued but not yet sent (crash, outage, retry delay). */
export async function processDueRefunds(limit = 25): Promise<number> {
  const due = await prisma.refund.findMany({
    where: {
      status: "PENDING",
      razorpayRefundId: null,
      attempts: { lt: MAX_REFUND_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let handled = 0;
  for (const { id } of due) {
    if ((await processRefund(id)) !== "skipped") handled++;
  }
  return handled;
}
