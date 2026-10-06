import type { Appointment, AppointmentStatus } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError, formatMoneyText } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { todayInZone, toLocalDate } from "../../utils/time.js";
import { normalizeCheckInCode } from "../appointments/booking-rules.js";
import {
  TX,
  advisoryLock,
  lockAppointmentRow,
  lockSlotRow,
  recountSlot,
} from "../appointments/booking.service.js";
import {
  enqueueAppointmentMessage,
  kickDispatcher,
} from "../notifications/notifications.service.js";
import type { RefundNote } from "../notifications/templates.js";
import { refundDecision } from "../payments/refund-policy.js";
import { applyRefundProcessed, kickRefund, queueRefund } from "../payments/refunds.service.js";
import { clearQueueCache } from "../queue/queue.service.js";
import { assertDoctorAllowed, requireFrontDesk, type DeskScope } from "./desk-scope.js";
import { staffAppointmentInclude, toStaffAppointmentDto } from "./desk.dto.js";

/**
 * The work done on appointments at the desk and in the consulting room.
 *
 * Every action runs in one transaction that first takes a per-doctor-per-day lock, so two
 * people tapping buttons for the same doctor (reception and the doctor, or two receptionists)
 * can never leave the queue in an impossible state, e.g. two patients "with the doctor".
 * A doctor can only act on their own patients; the hospital always comes from the login.
 */

export async function getStaffAppointment(scope: DeskScope, id: string) {
  const row = await prisma.appointment.findFirst({
    where: {
      id,
      hospitalId: scope.hospitalId,
      ...(scope.doctorId ? { doctorId: scope.doctorId } : {}),
    },
    include: staffAppointmentInclude,
  });
  if (!row) throw AppError.notFound("Appointment not found");
  return toStaffAppointmentDto(row);
}

interface Locked {
  appt: Appointment;
  now: Date;
  /** Today's date in the hospital's own timezone. */
  today: string;
}

async function withAppointment<T>(
  scope: DeskScope,
  id: string,
  options: { lockSlot?: boolean },
  fn: (tx: TxClient, ctx: Locked) => Promise<T>,
): Promise<T> {
  const found = await prisma.appointment.findFirst({
    where: {
      id,
      hospitalId: scope.hospitalId,
      ...(scope.doctorId ? { doctorId: scope.doctorId } : {}),
    },
    select: {
      doctorId: true,
      appointmentDate: true,
      slotId: true,
      hospital: { select: { timezone: true } },
    },
  });
  if (!found) throw AppError.notFound("Appointment not found");
  assertDoctorAllowed(scope, found.doctorId);

  const result = await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `queue:${found.doctorId}:${toLocalDate(found.appointmentDate)}`);
    // Lock order everywhere: slot row, then appointment row.
    if (options.lockSlot) await lockSlotRow(tx, found.slotId);
    await lockAppointmentRow(tx, id);
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id } });
    const now = new Date();
    return fn(tx, { appt, now, today: todayInZone(found.hospital.timezone, now) });
  }, TX);
  clearQueueCache();
  return result;
}

const STATUS_WORDS: Partial<Record<AppointmentStatus, string>> = {
  PENDING_PAYMENT: "is waiting for payment",
  CONFIRMED: "has not checked in",
  CHECKED_IN: "is already checked in",
  IN_PROGRESS: "is with the doctor",
  COMPLETED: "has already been seen",
  NO_SHOW: "was marked as not attending",
  CANCELLED: "was cancelled",
  EXPIRED: "expired before it was paid",
};

function wrongStatus(appt: Appointment, what: string): AppError {
  return AppError.conflict(
    `This appointment ${STATUS_WORDS[appt.status] ?? appt.status.toLowerCase()}, so you can't ${what}.`,
    "INVALID_STATUS",
  );
}

function mustBeToday(appt: Appointment, today: string, what: string): void {
  const day = toLocalDate(appt.appointmentDate);
  if (day !== today) {
    throw AppError.conflict(
      `This appointment is for ${day}, not today, so you can't ${what}.`,
      "WRONG_DAY",
    );
  }
}

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

export async function checkIn(scope: DeskScope, id: string, meta: RequestMeta) {
  requireFrontDesk(scope);
  const alreadyCheckedIn = await withAppointment(
    scope,
    id,
    {},
    async (tx, { appt, now, today }) => {
      if (appt.status === "CHECKED_IN") return true;
      // A patient marked absent who then turns up can be checked in again.
      if (appt.status !== "CONFIRMED" && appt.status !== "NO_SHOW")
        throw wrongStatus(appt, "check in");
      mustBeToday(appt, today, "check in");
      await tx.appointment.update({
        where: { id },
        data: { status: "CHECKED_IN", checkedInAt: now },
      });
      await audit(tx, {
        actor: scope.actor,
        action: "appointment.checked_in",
        entityType: "Appointment",
        entityId: id,
        hospitalId: appt.hospitalId,
        before: { status: appt.status },
        after: { status: "CHECKED_IN" },
        meta,
      });
      return false;
    },
  );
  return { appointment: await getStaffAppointment(scope, id), alreadyCheckedIn };
}

/** Check in by the code on the patient's QR (scanned or typed). Only this hospital's codes are found. */
export async function checkInByCode(scope: DeskScope, rawCode: string, meta: RequestMeta) {
  requireFrontDesk(scope);
  const code = normalizeCheckInCode(rawCode);
  const appt = await prisma.appointment.findFirst({
    where: { checkInCode: code, hospitalId: scope.hospitalId },
    select: { id: true },
  });
  if (!code || !appt) {
    throw AppError.notFound(
      "No appointment with that code at this hospital. Check the code and try again.",
      "CODE_NOT_FOUND",
    );
  }
  return checkIn(scope, appt.id, meta);
}

// ---------------------------------------------------------------------------
// In the consulting room
// ---------------------------------------------------------------------------

export async function startConsultation(
  scope: DeskScope,
  id: string,
  completeCurrent: boolean,
  meta: RequestMeta,
) {
  await withAppointment(scope, id, {}, async (tx, { appt, now, today }) => {
    if (appt.status !== "CHECKED_IN" && appt.status !== "CONFIRMED")
      throw wrongStatus(appt, "start the consultation");
    mustBeToday(appt, today, "start the consultation");

    // Only one patient can be with a doctor at a time.
    const current = await tx.appointment.findFirst({
      where: {
        doctorId: appt.doctorId,
        appointmentDate: appt.appointmentDate,
        status: "IN_PROGRESS",
        id: { not: id },
      },
    });
    if (current) {
      if (!completeCurrent) {
        throw new AppError(
          409,
          "IN_PROGRESS_EXISTS",
          `Token ${current.tokenNumber} is still with the doctor. Complete that consultation first.`,
          {
            currentToken: current.tokenNumber,
          },
        );
      }
      await tx.appointment.update({
        where: { id: current.id },
        data: { status: "COMPLETED", completedAt: now },
      });
      await audit(tx, {
        actor: scope.actor,
        action: "appointment.completed",
        entityType: "Appointment",
        entityId: current.id,
        hospitalId: current.hospitalId,
        before: { status: "IN_PROGRESS" },
        after: { status: "COMPLETED" },
        metadata: { completedByNextStart: true },
        meta,
      });
    }

    await tx.appointment.update({
      where: { id },
      // A patient who walked straight in without checking in is checked in by starting.
      data: { status: "IN_PROGRESS", startedAt: now, checkedInAt: appt.checkedInAt ?? now },
    });
    if (appt.tokenNumber != null) {
      await tx.doctorDay.upsert({
        where: { doctorId_date: { doctorId: appt.doctorId, date: appt.appointmentDate } },
        update: { currentToken: appt.tokenNumber },
        create: {
          doctorId: appt.doctorId,
          date: appt.appointmentDate,
          lastToken: appt.tokenNumber,
          currentToken: appt.tokenNumber,
        },
      });
    }
    await audit(tx, {
      actor: scope.actor,
      action: "appointment.started",
      entityType: "Appointment",
      entityId: id,
      hospitalId: appt.hospitalId,
      before: { status: appt.status },
      after: { status: "IN_PROGRESS", tokenNumber: appt.tokenNumber },
      meta,
    });
  });
  return getStaffAppointment(scope, id);
}

export async function completeConsultation(scope: DeskScope, id: string, meta: RequestMeta) {
  await withAppointment(scope, id, {}, async (tx, { appt, now }) => {
    if (appt.status !== "IN_PROGRESS") throw wrongStatus(appt, "complete it");
    await tx.appointment.update({ where: { id }, data: { status: "COMPLETED", completedAt: now } });
    await audit(tx, {
      actor: scope.actor,
      action: "appointment.completed",
      entityType: "Appointment",
      entityId: id,
      hospitalId: appt.hospitalId,
      before: { status: "IN_PROGRESS" },
      after: { status: "COMPLETED" },
      meta,
    });
  });
  return getStaffAppointment(scope, id);
}

/** The patient did not come. By policy there is no refund for a no-show. */
export async function markNoShow(scope: DeskScope, id: string, meta: RequestMeta) {
  await withAppointment(scope, id, {}, async (tx, { appt, today }) => {
    if (appt.status !== "CONFIRMED" && appt.status !== "CHECKED_IN")
      throw wrongStatus(appt, "mark it as not attending");
    mustBeToday(appt, today, "mark it as not attending");
    await tx.appointment.update({ where: { id }, data: { status: "NO_SHOW" } });
    await audit(tx, {
      actor: scope.actor,
      action: "appointment.no_show",
      entityType: "Appointment",
      entityId: id,
      hospitalId: appt.hospitalId,
      before: { status: appt.status },
      after: { status: "NO_SHOW" },
      meta,
    });
  });
  return getStaffAppointment(scope, id);
}

// ---------------------------------------------------------------------------
// Money at the desk
// ---------------------------------------------------------------------------

/** Records the consultation fee taken in cash (for a booking made "pay later"). */
export async function recordCash(scope: DeskScope, id: string, meta: RequestMeta) {
  requireFrontDesk(scope);
  await withAppointment(scope, id, {}, async (tx, { appt, now }) => {
    if (!["CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED"].includes(appt.status))
      throw wrongStatus(appt, "record a payment");
    if (appt.feeAmount <= 0)
      throw AppError.conflict("This appointment has no fee to collect", "NO_FEE");
    const paid = await tx.payment.findFirst({
      where: { appointmentId: id, status: { in: ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] } },
      select: { id: true },
    });
    if (paid) throw AppError.conflict("This appointment is already paid", "ALREADY_PAID");
    const payment = await tx.payment.create({
      data: {
        appointmentId: id,
        hospitalId: appt.hospitalId,
        method: "CASH",
        provider: "CASH",
        status: "CAPTURED",
        amount: appt.feeAmount,
        currency: appt.currency,
        commissionAmount: 0,
        collectedById: scope.userId,
        paidAt: now,
      },
    });
    await audit(tx, {
      actor: scope.actor,
      action: "payment.cash_recorded",
      entityType: "Payment",
      entityId: payment.id,
      hospitalId: appt.hospitalId,
      metadata: { appointmentId: id, amount: appt.feeAmount },
      meta,
    });
  });
  return getStaffAppointment(scope, id);
}

export type CancelInitiator = "PATIENT_REQUEST" | "HOSPITAL";

export interface StaffCancelResult {
  appointment: Awaited<ReturnType<typeof getStaffAppointment>>;
  /** What goes back to the patient. For cash, the desk hands it over now. */
  refund: { amount: number; percent: number; method: "CASH" | "ONLINE" } | null;
}

/**
 * Cancels an appointment on the patient's request or because the hospital cannot see them
 * (doctor unavailable). A hospital cancellation always refunds in full; a patient's request
 * follows the hospital's policy. Online payments are refunded through the gateway; for cash the
 * desk returns the money and the refund is recorded as done.
 */
export async function staffCancel(
  scope: DeskScope,
  id: string,
  input: { initiator: CancelInitiator; reason: string | null },
  meta: RequestMeta,
): Promise<StaffCancelResult> {
  requireFrontDesk(scope);
  let refund: StaffCancelResult["refund"] = null;
  let queuedRefundId: string | null = null;

  await withAppointment(scope, id, { lockSlot: true }, async (tx, { appt, now }) => {
    if (appt.status !== "CONFIRMED" && appt.status !== "CHECKED_IN")
      throw wrongStatus(appt, "cancel it");

    await tx.appointment.update({
      where: { id },
      data: {
        status: "CANCELLED",
        seatNumber: null,
        cancelledAt: now,
        cancelledById: scope.userId,
        cancelReason:
          input.reason ??
          (input.initiator === "HOSPITAL" ? "Cancelled by the hospital" : "Cancelled at the desk"),
      },
    });
    await recountSlot(tx, appt.slotId);

    const paid = await tx.payment.findFirst({
      where: { appointmentId: id, status: "CAPTURED" },
      orderBy: { createdAt: "desc" },
    });
    if (paid) {
      const hospital = await tx.hospital.findUniqueOrThrow({
        where: { id: appt.hospitalId },
        select: { refundFullHours: true, refundPartialPercent: true },
      });
      const decision = refundDecision({
        paidAmount: paid.amount,
        slotStart: appt.slotStart,
        now,
        policy: {
          fullRefundHours: hospital.refundFullHours,
          partialPercent: hospital.refundPartialPercent,
        },
        initiator: input.initiator === "HOSPITAL" ? "HOSPITAL" : "PATIENT",
      });
      const refundId = await queueRefund(tx, paid.id, decision.amount, {
        reason:
          input.initiator === "HOSPITAL"
            ? "Cancelled by the hospital"
            : "Cancelled at the desk at the patient's request",
        percent: decision.percent,
        initiatedById: scope.userId,
      });
      if (paid.provider === "CASH") {
        // The desk hands the cash back now, so the refund is complete in this transaction.
        if (refundId) await applyRefundProcessed(tx, refundId, null);
      } else {
        queuedRefundId = refundId;
      }
      refund = {
        amount: decision.amount,
        percent: decision.percent,
        method: paid.provider === "CASH" ? "CASH" : "ONLINE",
      };
    }

    const note: RefundNote | null = !refund
      ? null
      : refund.amount === 0
        ? { kind: "POLICY_NONE" }
        : {
            kind: refund.method === "CASH" ? "CASH" : "ONLINE",
            amountText: formatMoneyText(refund.amount, appt.currency),
          };
    await enqueueAppointmentMessage(tx, id, "appointment_cancelled", {}, note);

    await audit(tx, {
      actor: scope.actor,
      action: "appointment.cancelled_by_staff",
      entityType: "Appointment",
      entityId: id,
      hospitalId: appt.hospitalId,
      before: { status: appt.status, tokenNumber: appt.tokenNumber },
      after: { status: "CANCELLED" },
      metadata: {
        initiator: input.initiator,
        reason: input.reason,
        refundAmount: refund?.amount ?? null,
        refundMethod: refund?.method ?? null,
      },
      meta,
    });
  });

  kickRefund(queuedRefundId);
  kickDispatcher();
  return { appointment: await getStaffAppointment(scope, id), refund };
}
