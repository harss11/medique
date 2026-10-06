import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { toLocalDate } from "../../utils/time.js";
import { refundDecision } from "../payments/refund-policy.js";
import { reviewEditable, reviewWindowOpen } from "../reviews/review-rules.js";
import { CHANGEABLE_STATUSES, isChangeable } from "./booking-rules.js";

/** Everything the patient screens need, loaded in one query. */
export const appointmentInclude = {
  hospital: {
    select: {
      id: true,
      name: true,
      slug: true,
      phone: true,
      emergencyPhone: true,
      addressLine1: true,
      city: true,
      state: true,
      latitude: true,
      longitude: true,
      timezone: true,
      refundFullHours: true,
      refundPartialPercent: true,
    },
  },
  doctor: {
    select: {
      id: true,
      name: true,
      photoUrl: true,
      qualification: true,
      specialization: true,
      qrToken: true,
    },
  },
  department: { select: { id: true, name: true } },
  patientProfile: { select: { id: true, fullName: true, relation: true } },
  payments: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      status: true,
      method: true,
      provider: true,
      providerMethod: true,
      amount: true,
      refundedAmount: true,
      paidAt: true,
      refunds: {
        orderBy: { createdAt: "asc" },
        select: { amount: true, status: true, percent: true },
      },
    },
  },
  rescheduledTo: { select: { id: true } },
  review: { select: { rating: true, comment: true, createdAt: true, hiddenAt: true } },
} satisfies Prisma.AppointmentInclude;

export type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

/** Statuses where the patient holds a valid ticket (shows the check-in QR). */
const TICKET_STATUSES = new Set(["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"]);

export function toAppointmentDto(a: AppointmentRow, now: Date = new Date()) {
  const holdValid = a.status === "PENDING_PAYMENT" && !!a.holdExpiresAt && a.holdExpiresAt > now;
  const changeable = CHANGEABLE_STATUSES.includes(a.status) && isChangeable(a.slotStart, now);
  const payment = a.payments[0] ?? null;
  const policy = {
    fullRefundHours: a.hospital.refundFullHours,
    partialPercent: a.hospital.refundPartialPercent,
  };
  // What cancelling right now would refund, shown before the patient confirms.
  const cancelRefund =
    changeable && payment?.status === "CAPTURED"
      ? refundDecision({
          paidAmount: payment.amount,
          slotStart: a.slotStart,
          now,
          policy,
          initiator: "PATIENT",
        })
      : null;
  return {
    id: a.id,
    // A hold whose time ran out is reported as EXPIRED even before the cleanup job runs.
    status: a.status === "PENDING_PAYMENT" && !holdValid ? ("EXPIRED" as const) : a.status,
    source: a.source,
    appointmentDate: toLocalDate(a.appointmentDate),
    slotStart: a.slotStart,
    slotEnd: a.slotEnd,
    tokenNumber: a.tokenNumber,
    holdExpiresAt: holdValid ? a.holdExpiresAt : null,
    feeAmount: a.feeAmount,
    currency: a.currency,
    reasonForVisit: a.reasonForVisit,
    // Only a valid ticket shows its check-in code.
    checkInCode: TICKET_STATUSES.has(a.status) ? a.checkInCode : null,
    canCancel: changeable || holdValid,
    canReschedule: changeable,
    checkedInAt: a.checkedInAt,
    cancelledAt: a.cancelledAt,
    cancelReason: a.cancelReason,
    rescheduledFromId: a.rescheduledFromId,
    rescheduledToId: a.rescheduledTo?.id ?? null,
    hospital: a.hospital,
    doctor: {
      id: a.doctor.id,
      name: a.doctor.name,
      photoUrl: a.doctor.photoUrl,
      qualification: a.doctor.qualification,
      specialization: a.doctor.specialization,
    },
    // Only someone holding a valid ticket gets the link to that doctor's live queue.
    queueToken: TICKET_STATUSES.has(a.status) ? a.doctor.qrToken : null,
    department: a.department,
    patient: a.patientProfile,
    payment,
    refundPolicy: policy,
    cancelRefund,
    // Only a completed visit booked online can be reviewed (once, for a limited time).
    canReview:
      a.status === "COMPLETED" &&
      a.source === "ONLINE" &&
      !a.review &&
      reviewWindowOpen(a.completedAt ?? a.slotEnd, now, env.REVIEW_WINDOW_DAYS),
    review: a.review
      ? {
          rating: a.review.rating,
          comment: a.review.comment,
          createdAt: a.review.createdAt,
          hidden: a.review.hiddenAt !== null,
          canEdit:
            a.review.hiddenAt === null &&
            reviewEditable(a.review.createdAt, now, env.REVIEW_EDIT_DAYS),
        }
      : null,
    createdAt: a.createdAt,
  };
}

export type AppointmentDto = ReturnType<typeof toAppointmentDto>;
