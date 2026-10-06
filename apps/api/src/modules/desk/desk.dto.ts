import type { Prisma } from "../../generated/prisma/client.js";
import { toLocalDate } from "../../utils/time.js";
import { ageInYears } from "../queue/queue-rules.js";

/** What the desk and doctor screens need about an appointment, in one query. */
export const staffAppointmentInclude = {
  doctor: { select: { id: true, name: true, avgConsultMinutes: true } },
  department: { select: { id: true, name: true } },
  patientProfile: {
    select: { id: true, fullName: true, phone: true, dateOfBirth: true, gender: true },
  },
  payments: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { status: true, method: true, provider: true, amount: true, refundedAmount: true },
  },
} satisfies Prisma.AppointmentInclude;

export type StaffAppointmentRow = Prisma.AppointmentGetPayload<{
  include: typeof staffAppointmentInclude;
}>;

/**
 * The staff view of an appointment. It deliberately leaves out the check-in code (patients
 * show it; staff look appointments up by name or token) and anything about commission.
 */
export function toStaffAppointmentDto(a: StaffAppointmentRow, now: Date = new Date()) {
  const payment = a.payments[0] ?? null;
  return {
    id: a.id,
    status: a.status,
    source: a.source,
    appointmentDate: toLocalDate(a.appointmentDate),
    slotStart: a.slotStart,
    slotEnd: a.slotEnd,
    tokenNumber: a.tokenNumber,
    feeAmount: a.feeAmount,
    currency: a.currency,
    reasonForVisit: a.reasonForVisit,
    checkedInAt: a.checkedInAt,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    cancelledAt: a.cancelledAt,
    cancelReason: a.cancelReason,
    doctor: { id: a.doctor.id, name: a.doctor.name },
    department: a.department,
    patient: {
      id: a.patientProfile.id,
      fullName: a.patientProfile.fullName,
      phone: a.patientProfile.phone,
      ageYears: ageInYears(a.patientProfile.dateOfBirth, now),
      gender: a.patientProfile.gender,
    },
    /** What is still owed at the desk: a paid, refunded or unpaid appointment. */
    payment: payment
      ? {
          status: payment.status,
          method: payment.method,
          amount: payment.amount,
          refundedAmount: payment.refundedAmount,
        }
      : null,
    paid: !!payment && ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(payment.status),
  };
}

export type StaffAppointmentDto = ReturnType<typeof toStaffAppointmentDto>;
