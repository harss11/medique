import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { activeGateway } from "../../services/payment/index.js";
import { AppError } from "../../utils/http.js";

/**
 * What the browser needs to start paying. The browser only ever *starts* a payment;
 * the booking is confirmed solely by the verified webhook (see webhook.service.ts).
 */
export type PaymentOrderDto =
  | { mode: "mock"; amount: number; currency: string; holdExpiresAt: Date }
  | {
      mode: "razorpay";
      keyId: string;
      orderId: string;
      amount: number;
      currency: string;
      /** Shown in the Razorpay checkout header. */
      name: string;
      description: string;
      prefill: { name: string; contact: string };
      holdExpiresAt: Date;
    };

/**
 * Creates (or returns the existing) payment order for an appointment that is
 * waiting for payment. Calling it again, e.g. after a page reload, returns the same
 * order rather than creating a second one.
 */
export async function createPaymentOrder(
  auth: AuthContext,
  appointmentId: string,
): Promise<PaymentOrderDto> {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, bookedById: auth.userId },
    include: {
      hospital: { select: { name: true } },
      doctor: { select: { name: true } },
      patientProfile: { select: { fullName: true } },
      bookedBy: { select: { phone: true } },
    },
  });
  if (!appt) throw AppError.notFound("Appointment not found");
  if (appt.status === "CONFIRMED")
    throw AppError.conflict("This appointment is already paid", "ALREADY_PAID");
  const now = new Date();
  if (appt.status !== "PENDING_PAYMENT" || !appt.holdExpiresAt || appt.holdExpiresAt <= now) {
    throw AppError.conflict("This booking is no longer waiting for payment", "HOLD_EXPIRED");
  }
  if (appt.feeAmount <= 0) {
    throw AppError.conflict("This appointment needs no payment", "NO_PAYMENT_NEEDED");
  }
  const holdExpiresAt = appt.holdExpiresAt;

  if (env.PAYMENT_MODE === "mock") {
    return { mode: "mock", amount: appt.feeAmount, currency: appt.currency, holdExpiresAt };
  }

  const toDto = (orderId: string): PaymentOrderDto => ({
    mode: "razorpay",
    keyId: env.RAZORPAY_KEY_ID!,
    orderId,
    amount: appt.feeAmount,
    currency: appt.currency,
    name: appt.hospital.name,
    description: `Consultation with ${appt.doctor.name}`,
    prefill: { name: appt.patientProfile.fullName, contact: appt.bookedBy.phone ?? "" },
    holdExpiresAt,
  });

  const existing = () =>
    prisma.payment.findFirst({
      where: {
        appointmentId,
        provider: "RAZORPAY",
        status: { in: ["CREATED", "FAILED"] },
        razorpayOrderId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { razorpayOrderId: true },
    });
  const reuse = await existing();
  if (reuse?.razorpayOrderId) return toDto(reuse.razorpayOrderId);

  // Talk to Razorpay outside any database transaction.
  const order = await activeGateway().createOrder({
    amountMinor: appt.feeAmount,
    currency: appt.currency,
    receipt: appt.id,
    notes: { appointmentId: appt.id, hospitalId: appt.hospitalId },
  });

  // Two simultaneous calls may both have created an order; keep exactly one.
  const orderId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${appointmentId}`}))`;
    const again = await tx.payment.findFirst({
      where: {
        appointmentId,
        provider: "RAZORPAY",
        status: { in: ["CREATED", "FAILED"] },
        razorpayOrderId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { razorpayOrderId: true },
    });
    if (again?.razorpayOrderId) return again.razorpayOrderId;
    await tx.payment.create({
      data: {
        appointmentId,
        hospitalId: appt.hospitalId,
        method: "ONLINE",
        provider: "RAZORPAY",
        status: "CREATED",
        amount: appt.feeAmount,
        currency: appt.currency,
        razorpayOrderId: order.id,
      },
    });
    return order.id;
  });
  return toDto(orderId);
}
