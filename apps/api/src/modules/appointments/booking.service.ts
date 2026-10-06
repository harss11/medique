import { env } from "../../config/env.js";
import type {
  AppointmentStatus,
  PaymentMethod,
  PaymentProvider,
} from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { audit, type AuditActor } from "../../utils/audit.js";
import { AppError, formatMoneyText } from "../../utils/http.js";
import { paginate, toSkipTake, type PaginationQuery } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/request.js";
import { toLocalDate } from "../../utils/time.js";
import {
  enqueueAppointmentMessage,
  kickDispatcher,
} from "../notifications/notifications.service.js";
import type { RefundNote } from "../notifications/templates.js";
import { refundDecision, type RefundDecision } from "../payments/refund-policy.js";
import { kickRefund, queueRefund } from "../payments/refunds.service.js";
import { assertBookingsOpen } from "../subscriptions/subscription.service.js";
import { markWaitlistBooked } from "../waitlist/waitlist.service.js";
import { appointmentInclude, toAppointmentDto } from "./appointments.dto.js";
import {
  CHANGEABLE_STATUSES,
  commissionAmount,
  generateCheckInCode,
  holdExpiry,
  isBookable,
  isChangeable,
  pickSeat,
} from "./booking-rules.js";

/**
 * Booking engine. The rules that keep it correct under concurrency:
 *
 * 1. Every change to a slot's seats runs in ONE transaction that first locks the
 *    `Slot` row (`SELECT ... FOR UPDATE`). Competing bookings for the same slot
 *    queue behind it and re-check capacity after it commits.
 * 2. Lock order is always: patient advisory locks -> Slot rows (sorted by id) ->
 *    Appointment row -> DoctorDay row. A fixed order means no deadlocks.
 * 3. An appointment holds a seat iff `seatNumber` is not null; `Slot.bookedCount`
 *    is recomputed from that, never incremented blindly (it self-heals).
 * 4. The database unique constraints `(slotId, seatNumber)` and
 *    `(doctorId, appointmentDate, tokenNumber)` are the last line of defence.
 * 5. Expired holds are released lazily inside the booking transaction, so
 *    correctness never depends on the cleanup job running on time.
 */

export const TX = { maxWait: 30_000, timeout: 30_000 } as const;

const actorOf = (auth: AuthContext): AuditActor => ({ userId: auth.userId, role: auth.role });

// ---------------------------------------------------------------------------
// Low-level locking helpers
// ---------------------------------------------------------------------------

export interface SlotRow {
  id: string;
  hospitalId: string;
  doctorId: string;
  /** local calendar day, "YYYY-MM-DD" */
  dateStr: string;
  startAt: Date;
  endAt: Date;
  capacity: number;
  status: "OPEN" | "BLOCKED";
}

export async function lockSlotRow(tx: TxClient, slotId: string): Promise<SlotRow | null> {
  const rows = await tx.$queryRaw<SlotRow[]>`
    SELECT id::text AS id, "hospitalId"::text AS "hospitalId", "doctorId"::text AS "doctorId",
           to_char(date, 'YYYY-MM-DD') AS "dateStr", "startAt", "endAt", capacity, status::text AS status
    FROM "Slot" WHERE id = ${slotId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Locks several slots in a fixed (sorted) order so concurrent reschedules can't deadlock. */
export async function lockSlotRows(tx: TxClient, slotIds: string[]): Promise<Map<string, SlotRow>> {
  const out = new Map<string, SlotRow>();
  for (const id of [...new Set(slotIds)].sort()) {
    const row = await lockSlotRow(tx, id);
    if (row) out.set(id, row);
  }
  return out;
}

export async function lockAppointmentRow(tx: TxClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "Appointment" WHERE id = ${id}::uuid FOR UPDATE`;
  return rows.length > 0;
}

export async function advisoryLock(tx: TxClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** bookedCount = number of appointments that hold a seat. */
export async function recountSlot(tx: TxClient, slotId: string): Promise<number> {
  const count = await tx.appointment.count({ where: { slotId, seatNumber: { not: null } } });
  await tx.slot.update({ where: { id: slotId }, data: { bookedCount: count } });
  return count;
}

/** Releases holds whose payment window has passed. Caller holds the slot lock. */
export async function releaseExpiredHolds(
  tx: TxClient,
  slotId: string,
  now: Date,
): Promise<number> {
  const { count } = await tx.appointment.updateMany({
    where: { slotId, status: "PENDING_PAYMENT", holdExpiresAt: { lt: now } },
    data: { status: "EXPIRED", seatNumber: null },
  });
  return count;
}

export async function freeSeat(tx: TxClient, slot: SlotRow): Promise<number | null> {
  const used = await tx.appointment.findMany({
    where: { slotId: slot.id, seatNumber: { not: null } },
    select: { seatNumber: true },
  });
  return pickSeat(
    used.map((u) => u.seatNumber!),
    slot.capacity,
  );
}

/**
 * Next token for a doctor on a date: one atomic upsert-and-increment. Concurrent
 * confirmations queue on the DoctorDay row, so tokens are unique and gap-free.
 */
export async function nextToken(tx: TxClient, doctorId: string, dateStr: string): Promise<number> {
  const rows = await tx.$queryRaw<{ lastToken: number }[]>`
    INSERT INTO "DoctorDay" ("doctorId", "date", "lastToken", "updatedAt")
    VALUES (${doctorId}::uuid, ${dateStr}::date, 1, now())
    ON CONFLICT ("doctorId", "date")
    DO UPDATE SET "lastToken" = "DoctorDay"."lastToken" + 1, "updatedAt" = now()
    RETURNING "lastToken"`;
  return rows[0]!.lastToken;
}

// ---------------------------------------------------------------------------
// Lock a slot (start of a booking)
// ---------------------------------------------------------------------------

export interface LockInput {
  slotId: string;
  patientProfileId: string;
  reasonForVisit?: string | null;
}

/**
 * Holds one seat for the patient for BOOKING_HOLD_MINUTES while they pay. Free
 * consultations (fee 0) are confirmed immediately instead.
 */
export async function lockSlot(auth: AuthContext, input: LockInput, meta: RequestMeta) {
  const now = new Date();
  let confirmedFree = false;

  const appointmentId = await prisma.$transaction(async (tx) => {
    const preview = await tx.slot.findUnique({
      where: { id: input.slotId },
      select: { doctorId: true, date: true },
    });
    if (!preview) throw AppError.notFound("This slot does not exist", "SLOT_NOT_FOUND");

    // Serialise this patient's own bookings so the limits below can't be raced.
    await advisoryLock(tx, `patient:${auth.userId}`);
    await advisoryLock(
      tx,
      `profile:${input.patientProfileId}:${preview.doctorId}:${toLocalDate(preview.date)}`,
    );
    const slot = await lockSlotRow(tx, input.slotId);
    if (!slot) throw AppError.notFound("This slot does not exist", "SLOT_NOT_FOUND");

    const profile = await tx.patientProfile.findFirst({
      where: { id: input.patientProfileId, userId: auth.userId, deletedAt: null },
      select: { id: true },
    });
    if (!profile)
      throw AppError.badRequest("Choose who the appointment is for", "PROFILE_NOT_FOUND");

    const detail = await tx.slot.findUniqueOrThrow({
      where: { id: slot.id },
      select: {
        date: true,
        doctor: { select: { isActive: true, consultationFee: true, departmentId: true } },
        hospital: { select: { status: true, currency: true, commissionPercent: true } },
      },
    });
    if (
      slot.status !== "OPEN" ||
      !detail.doctor.isActive ||
      detail.hospital.status !== "ACTIVE" ||
      !isBookable(slot.startAt, now)
    ) {
      throw AppError.conflict("This slot is no longer available", "SLOT_UNAVAILABLE");
    }

    await releaseExpiredHolds(tx, slot.id, now);

    // The same person can't hold two seats with one doctor on one day.
    const existing = await tx.appointment.findFirst({
      where: {
        patientProfileId: profile.id,
        doctorId: slot.doctorId,
        appointmentDate: detail.date,
        seatNumber: { not: null },
        OR: [{ status: { not: "PENDING_PAYMENT" } }, { holdExpiresAt: { gt: now } }],
      },
      select: { id: true, slotId: true, status: true },
    });
    if (existing) {
      // Double-click or page reload: hand back the hold they already have.
      if (existing.slotId === slot.id && existing.status === "PENDING_PAYMENT") return existing.id;
      throw AppError.conflict(
        "This patient already has an appointment with this doctor on that day",
        "ALREADY_BOOKED",
      );
    }

    // The hospital's subscription must be in good standing and under its monthly limit.
    await assertBookingsOpen(tx, slot.hospitalId, { lock: true });

    const pending = await tx.appointment.count({
      where: { bookedById: auth.userId, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
    });
    if (pending >= env.MAX_PENDING_HOLDS_PER_PATIENT) {
      throw AppError.tooMany(
        "Finish or cancel your pending bookings before starting another",
        "TOO_MANY_HOLDS",
      );
    }

    const seat = await freeSeat(tx, slot);
    if (seat === null) throw AppError.conflict("This slot has just been booked", "SLOT_FULL");

    const fee = detail.doctor.consultationFee;
    const created = await tx.appointment.create({
      data: {
        hospitalId: slot.hospitalId,
        departmentId: detail.doctor.departmentId,
        doctorId: slot.doctorId,
        slotId: slot.id,
        patientProfileId: profile.id,
        bookedById: auth.userId,
        source: "ONLINE",
        status: "PENDING_PAYMENT",
        appointmentDate: detail.date,
        slotStart: slot.startAt,
        slotEnd: slot.endAt,
        seatNumber: seat,
        holdExpiresAt: holdExpiry(now),
        feeAmount: fee,
        currency: detail.hospital.currency,
        commissionPercent: detail.hospital.commissionPercent,
        checkInCode: generateCheckInCode(),
        reasonForVisit: input.reasonForVisit ?? null,
      },
      select: { id: true },
    });
    await recountSlot(tx, slot.id);

    if (fee === 0) {
      await confirmInTx(tx, created.id, slot, null, actorOf(auth), meta, now);
      confirmedFree = true;
    }
    return created.id;
  }, TX);

  if (confirmedFree) kickDispatcher();
  return getOwnedAppointment(auth, appointmentId);
}

// ---------------------------------------------------------------------------
// Confirm (called after payment is verified; never from the browser's word alone)
// ---------------------------------------------------------------------------

export interface PaymentInput {
  provider: PaymentProvider;
  method: PaymentMethod;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  /** "upi", "card", ... as reported by the provider. */
  providerMethod?: string;
}

export type ConfirmOutcome =
  /** Seat confirmed, token issued. */
  | "CONFIRMED"
  /** Called again for an appointment that was already confirmed (idempotent). */
  | "ALREADY_CONFIRMED"
  /** Hold expired and someone else took the seat: the payment is refunded in full. */
  | "SLOT_LOST"
  /** The appointment was cancelled before payment arrived: the payment is refunded in full. */
  | "CANCELLED"
  /** A second payment arrived for an appointment that is already paid: refunded in full. */
  | "DUPLICATE_PAYMENT";

interface ConfirmResult {
  outcome: ConfirmOutcome;
  /** A refund queued in this transaction; send it to the gateway after commit. */
  refundId: string | null;
}

const PAID_STATUSES = ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

interface RecordedCapture {
  paymentId: string;
  amount: number;
  /** First time we see this payment (a redelivered webhook is not fresh). */
  fresh: boolean;
  /** The appointment already had a different paid payment. */
  duplicate: boolean;
}

/**
 * Records that money arrived, exactly once per gateway payment id. Money received
 * is a fact, so this happens whatever becomes of the booking.
 */
async function recordCapture(
  tx: TxClient,
  appt: {
    id: string;
    hospitalId: string;
    feeAmount: number;
    currency: string;
    commissionPercent: unknown;
  },
  payment: PaymentInput,
  now: Date,
): Promise<RecordedCapture> {
  const seen = async (id: string, amount: number): Promise<RecordedCapture> => ({
    paymentId: id,
    amount,
    fresh: false,
    duplicate: false,
  });

  if (payment.razorpayPaymentId) {
    const existing = await tx.payment.findUnique({
      where: { razorpayPaymentId: payment.razorpayPaymentId },
    });
    if (existing) return seen(existing.id, existing.amount);
  } else {
    // No gateway id (test payments): one payment per appointment, however often this is called.
    const existing = await tx.payment.findFirst({
      where: { appointmentId: appt.id, status: { in: [...PAID_STATUSES] } },
    });
    if (existing) return seen(existing.id, existing.amount);
  }

  const commission = commissionAmount(appt.feeAmount, Number(appt.commissionPercent));
  const captured = {
    status: "CAPTURED" as const,
    paidAt: now,
    commissionAmount: commission,
    razorpayPaymentId: payment.razorpayPaymentId ?? null,
    providerMethod: payment.providerMethod ?? null,
    failureReason: null,
  };

  // Another paid payment on this appointment means this one is a duplicate.
  const other = await tx.payment.findFirst({
    where: { appointmentId: appt.id, status: { in: [...PAID_STATUSES] } },
    select: { id: true },
  });

  // Normally the order was created earlier and is waiting in CREATED/FAILED state.
  const byOrder = payment.razorpayOrderId
    ? await tx.payment.findUnique({ where: { razorpayOrderId: payment.razorpayOrderId } })
    : null;
  if (byOrder && ["CREATED", "FAILED", "AUTHORIZED"].includes(byOrder.status)) {
    const updated = await tx.payment.update({ where: { id: byOrder.id }, data: captured });
    return { paymentId: updated.id, amount: updated.amount, fresh: true, duplicate: !!other };
  }

  const created = await tx.payment.create({
    data: {
      appointmentId: appt.id,
      hospitalId: appt.hospitalId,
      method: payment.method,
      provider: payment.provider,
      amount: appt.feeAmount,
      currency: appt.currency,
      // The order id is unique; a second payment on an already-paid order keeps no order link.
      razorpayOrderId: byOrder ? null : (payment.razorpayOrderId ?? null),
      ...captured,
    },
  });
  return { paymentId: created.id, amount: created.amount, fresh: true, duplicate: !!other };
}

/**
 * Assigns the token, marks the appointment CONFIRMED and records the payment.
 * Caller holds the slot lock and runs inside the transaction. Any payment that
 * can't be turned into a booking is refunded in full, durably, in this transaction.
 */
async function confirmInTx(
  tx: TxClient,
  appointmentId: string,
  slot: SlotRow,
  payment: PaymentInput | null,
  actor: AuditActor | null,
  meta: RequestMeta | undefined,
  now: Date,
): Promise<ConfirmResult> {
  await lockAppointmentRow(tx, appointmentId);
  const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  const recorded = payment ? await recordCapture(tx, appt, payment, now) : null;

  const refundInFull = async (reason: string): Promise<string | null> =>
    recorded?.fresh
      ? queueRefund(tx, recorded.paymentId, recorded.amount, {
          reason,
          percent: 100,
          initiatedById: null,
        })
      : null;

  if (recorded?.fresh && recorded.duplicate) {
    return { outcome: "DUPLICATE_PAYMENT", refundId: await refundInFull("Duplicate payment") };
  }
  if (["CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED"].includes(appt.status)) {
    return { outcome: "ALREADY_CONFIRMED", refundId: null };
  }
  if (appt.status === "CANCELLED" || appt.status === "NO_SHOW") {
    return {
      outcome: "CANCELLED",
      refundId: await refundInFull("Booking was cancelled before payment arrived"),
    };
  }

  let seat = appt.seatNumber;
  if (appt.status === "EXPIRED" || seat === null) {
    // The hold was released while the patient was paying. Take a seat again if one is left.
    const gone = slot.status !== "OPEN" || slot.startAt <= now;
    if (!gone) {
      await releaseExpiredHolds(tx, slot.id, now);
      seat = await freeSeat(tx, slot);
    }
    if (gone || seat === null) {
      return { outcome: "SLOT_LOST", refundId: await refundInFull("Slot was no longer available") };
    }
  }

  const tokenNumber = await nextToken(tx, appt.doctorId, slot.dateStr);
  await tx.appointment.update({
    where: { id: appt.id },
    data: {
      status: "CONFIRMED",
      seatNumber: seat,
      tokenNumber,
      holdExpiresAt: null,
      confirmedAt: now,
    },
  });

  await recountSlot(tx, slot.id);
  await markWaitlistBooked(tx, appt.doctorId, appt.appointmentDate, appt.patientProfileId);
  await audit(tx, {
    actor,
    action: "appointment.confirmed",
    entityType: "Appointment",
    entityId: appt.id,
    hospitalId: appt.hospitalId,
    after: { status: "CONFIRMED", tokenNumber, slotStart: appt.slotStart },
    metadata: {
      provider: payment?.provider ?? "NONE",
      amount: appt.feeAmount,
      reacquiredSeat: appt.status === "EXPIRED",
    },
    meta,
  });
  await enqueueAppointmentMessage(tx, appt.id, "booking_confirmed");
  return { outcome: "CONFIRMED", refundId: null };
}

/**
 * Confirms an appointment after its payment is verified (by the Razorpay webhook,
 * or by the test payment in development). Idempotent: a webhook may be delivered
 * several times for the same payment and only the first has any effect.
 */
export async function confirmAppointment(
  appointmentId: string,
  payment: PaymentInput,
  actor: AuditActor | null,
  meta?: RequestMeta,
): Promise<ConfirmResult> {
  const found = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { slotId: true },
  });
  if (!found) throw AppError.notFound("Appointment not found");

  const result = await prisma.$transaction(async (tx) => {
    const slot = await lockSlotRow(tx, found.slotId);
    if (!slot) throw AppError.notFound("Slot not found");
    return confirmInTx(tx, appointmentId, slot, payment, actor, meta, new Date());
  }, TX);

  kickRefund(result.refundId);
  if (result.outcome === "CONFIRMED") kickDispatcher();
  return result;
}

/**
 * A payment attempt failed: free the held seat (the rule: "if payment fails or
 * times out, release it"). If the patient pays successfully afterwards, the seat
 * is re-taken when still free, or the payment is refunded.
 */
export async function releaseHoldAfterPaymentFailure(appointmentId: string): Promise<boolean> {
  const found = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { slotId: true },
  });
  if (!found) return false;
  return prisma.$transaction(async (tx) => {
    const slot = await lockSlotRow(tx, found.slotId);
    if (!slot) return false;
    await lockAppointmentRow(tx, appointmentId);
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    if (appt.status !== "PENDING_PAYMENT") return false;
    await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: "EXPIRED", seatNumber: null, holdExpiresAt: null },
    });
    await recountSlot(tx, slot.id);
    await audit(tx, {
      actor: null,
      action: "appointment.hold_released",
      entityType: "Appointment",
      entityId: appointmentId,
      hospitalId: appt.hospitalId,
      metadata: { reason: "payment_failed" },
    });
    return true;
  }, TX);
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Cancels the patient's own appointment, or abandons an unpaid hold. The seat is
 * freed at once, and the refund the hospital's policy allows is queued in the same
 * transaction (so it can't be lost) and sent to the gateway right after.
 */
export async function cancelAppointment(
  auth: AuthContext,
  appointmentId: string,
  reason: string | null,
  meta: RequestMeta,
) {
  const found = await prisma.appointment.findFirst({
    where: { id: appointmentId, bookedById: auth.userId },
    select: { slotId: true },
  });
  if (!found) throw AppError.notFound("Appointment not found");

  const refundId = await prisma.$transaction(async (tx) => {
    const slot = await lockSlotRow(tx, found.slotId);
    if (!slot) throw AppError.notFound("Slot not found");
    await lockAppointmentRow(tx, appointmentId);
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    const now = new Date();

    const unpaidHold = appt.status === "PENDING_PAYMENT";
    if (!unpaidHold && !CHANGEABLE_STATUSES.includes(appt.status)) {
      throw AppError.conflict(
        appt.status === "CANCELLED"
          ? "Already cancelled"
          : "This appointment can no longer be cancelled",
        "INVALID_STATUS",
      );
    }
    if (!unpaidHold && !isChangeable(appt.slotStart, now)) {
      throw AppError.conflict(
        `Cancellation closes ${env.CHANGE_CLOSES_MINUTES_BEFORE} minutes before the appointment`,
        "CHANGE_CLOSED",
      );
    }

    await tx.appointment.update({
      where: { id: appt.id },
      data: {
        status: "CANCELLED",
        seatNumber: null,
        holdExpiresAt: null,
        cancelledAt: now,
        cancelledById: auth.userId,
        cancelReason: reason ?? (unpaidHold ? "Payment not completed" : null),
      },
    });
    await recountSlot(tx, slot.id);

    let queuedRefundId: string | null = null;
    let decision: RefundDecision | null = null;
    if (!unpaidHold) {
      const paid = await tx.payment.findFirst({
        where: { appointmentId: appt.id, status: "CAPTURED" },
        orderBy: { createdAt: "desc" },
      });
      if (paid) {
        const hospital = await tx.hospital.findUniqueOrThrow({
          where: { id: appt.hospitalId },
          select: { refundFullHours: true, refundPartialPercent: true },
        });
        decision = refundDecision({
          paidAmount: paid.amount,
          slotStart: appt.slotStart,
          now,
          policy: {
            fullRefundHours: hospital.refundFullHours,
            partialPercent: hospital.refundPartialPercent,
          },
          initiator: "PATIENT",
        });
        queuedRefundId = await queueRefund(tx, paid.id, decision.amount, {
          reason: "Cancelled by patient",
          percent: decision.percent,
          initiatedById: auth.userId,
        });
      }
      const refundNote: RefundNote | null = !decision
        ? null
        : decision.amount > 0
          ? { kind: "ONLINE", amountText: formatMoneyText(decision.amount, appt.currency) }
          : { kind: "POLICY_NONE" };
      await enqueueAppointmentMessage(tx, appt.id, "appointment_cancelled", {}, refundNote);
    }

    await audit(tx, {
      actor: actorOf(auth),
      action: unpaidHold ? "appointment.hold_cancelled" : "appointment.cancelled",
      entityType: "Appointment",
      entityId: appt.id,
      hospitalId: appt.hospitalId,
      before: { status: appt.status, tokenNumber: appt.tokenNumber },
      after: { status: "CANCELLED" },
      metadata: {
        reason,
        refundAmount: decision?.amount ?? null,
        refundPercent: decision?.percent ?? null,
      },
      meta,
    });
    return queuedRefundId;
  }, TX);

  kickRefund(refundId);
  kickDispatcher();
  return getOwnedAppointment(auth, appointmentId);
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

async function rescheduleDepth(tx: TxClient, appointmentId: string): Promise<number> {
  let depth = 0;
  let current: string | null = appointmentId;
  while (current && depth <= 20) {
    const row: { rescheduledFromId: string | null } | null = await tx.appointment.findUnique({
      where: { id: current },
      select: { rescheduledFromId: true },
    });
    current = row?.rescheduledFromId ?? null;
    if (current) depth++;
  }
  return depth;
}

/**
 * Moves a confirmed appointment to another slot of the same doctor, with no new
 * payment. Creates a fresh confirmed appointment (new token and check-in code)
 * and cancels the old one in the same transaction, so the patient is never
 * left without a seat.
 */
export async function rescheduleAppointment(
  auth: AuthContext,
  appointmentId: string,
  newSlotId: string,
  meta: RequestMeta,
) {
  const found = await prisma.appointment.findFirst({
    where: { id: appointmentId, bookedById: auth.userId },
    select: { slotId: true, doctorId: true, patientProfileId: true },
  });
  if (!found) throw AppError.notFound("Appointment not found");
  if (found.slotId === newSlotId) {
    throw AppError.badRequest("Choose a different slot", "SAME_SLOT");
  }

  const newId = await prisma.$transaction(async (tx) => {
    const target = await tx.slot.findUnique({
      where: { id: newSlotId },
      select: { doctorId: true, date: true },
    });
    if (!target) throw AppError.notFound("This slot does not exist", "SLOT_NOT_FOUND");
    if (target.doctorId !== found.doctorId) {
      throw AppError.badRequest(
        "You can only reschedule to another slot of the same doctor",
        "SAME_DOCTOR_ONLY",
      );
    }

    await advisoryLock(tx, `patient:${auth.userId}`);
    await advisoryLock(
      tx,
      `profile:${found.patientProfileId}:${found.doctorId}:${toLocalDate(target.date)}`,
    );
    const slots = await lockSlotRows(tx, [found.slotId, newSlotId]);
    const newSlot = slots.get(newSlotId);
    if (!newSlot) throw AppError.notFound("This slot does not exist", "SLOT_NOT_FOUND");

    await lockAppointmentRow(tx, appointmentId);
    const old = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    const now = new Date();

    if (!CHANGEABLE_STATUSES.includes(old.status)) {
      throw AppError.conflict("Only confirmed appointments can be rescheduled", "INVALID_STATUS");
    }
    if (!isChangeable(old.slotStart, now)) {
      throw AppError.conflict(
        `Rescheduling closes ${env.CHANGE_CLOSES_MINUTES_BEFORE} minutes before the appointment`,
        "CHANGE_CLOSED",
      );
    }
    if ((await rescheduleDepth(tx, old.id)) >= env.MAX_RESCHEDULES_PER_APPOINTMENT) {
      throw AppError.conflict(
        `An appointment can be rescheduled at most ${env.MAX_RESCHEDULES_PER_APPOINTMENT} times`,
        "MAX_RESCHEDULES",
      );
    }

    const hospital = await tx.hospital.findUniqueOrThrow({
      where: { id: newSlot.hospitalId },
      select: { status: true },
    });
    const doctor = await tx.doctor.findUniqueOrThrow({
      where: { id: newSlot.doctorId },
      select: { isActive: true },
    });
    if (
      newSlot.status !== "OPEN" ||
      !doctor.isActive ||
      hospital.status !== "ACTIVE" ||
      !isBookable(newSlot.startAt, now)
    ) {
      throw AppError.conflict("This slot is no longer available", "SLOT_UNAVAILABLE");
    }

    await releaseExpiredHolds(tx, newSlot.id, now);
    const clash = await tx.appointment.findFirst({
      where: {
        id: { not: old.id },
        patientProfileId: old.patientProfileId,
        doctorId: old.doctorId,
        appointmentDate: target.date,
        seatNumber: { not: null },
        OR: [{ status: { not: "PENDING_PAYMENT" } }, { holdExpiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (clash) {
      throw AppError.conflict(
        "This patient already has an appointment with this doctor on that day",
        "ALREADY_BOOKED",
      );
    }

    const seat = await freeSeat(tx, newSlot);
    if (seat === null) throw AppError.conflict("This slot has just been booked", "SLOT_FULL");
    const tokenNumber = await nextToken(tx, newSlot.doctorId, newSlot.dateStr);

    // Free the old seat first so a same-slot-group move can never exceed capacity.
    await tx.appointment.update({
      where: { id: old.id },
      data: {
        status: "CANCELLED",
        seatNumber: null,
        cancelledAt: now,
        cancelledById: auth.userId,
        cancelReason: "Rescheduled",
      },
    });
    const created = await tx.appointment.create({
      data: {
        hospitalId: old.hospitalId,
        departmentId: old.departmentId,
        doctorId: old.doctorId,
        slotId: newSlot.id,
        patientProfileId: old.patientProfileId,
        bookedById: old.bookedById,
        source: old.source,
        status: "CONFIRMED",
        appointmentDate: target.date,
        slotStart: newSlot.startAt,
        slotEnd: newSlot.endAt,
        seatNumber: seat,
        tokenNumber,
        feeAmount: old.feeAmount,
        currency: old.currency,
        commissionPercent: old.commissionPercent,
        confirmedAt: now,
        checkInCode: generateCheckInCode(),
        reasonForVisit: old.reasonForVisit,
        rescheduledFromId: old.id,
      },
      select: { id: true },
    });
    // The payment follows the appointment (refund rules apply to the new time).
    await tx.payment.updateMany({
      where: { appointmentId: old.id },
      data: { appointmentId: created.id },
    });

    await recountSlot(tx, old.slotId);
    await recountSlot(tx, newSlot.id);
    await audit(tx, {
      actor: actorOf(auth),
      action: "appointment.rescheduled",
      entityType: "Appointment",
      entityId: created.id,
      hospitalId: old.hospitalId,
      before: { appointmentId: old.id, slotStart: old.slotStart, tokenNumber: old.tokenNumber },
      after: { appointmentId: created.id, slotStart: newSlot.startAt, tokenNumber },
      meta,
    });
    await enqueueAppointmentMessage(tx, created.id, "appointment_rescheduled");
    return created.id;
  }, TX);

  kickDispatcher();
  return getOwnedAppointment(auth, newId);
}

// ---------------------------------------------------------------------------
// Hold expiry job
// ---------------------------------------------------------------------------

/** Releases every unpaid hold whose time ran out. Safe to run on several instances. */
export async function expireStaleHolds(now: Date = new Date()): Promise<number> {
  const slots = await prisma.appointment.findMany({
    where: { status: "PENDING_PAYMENT", holdExpiresAt: { lt: now } },
    select: { slotId: true },
    distinct: ["slotId"],
    take: 500,
  });
  let released = 0;
  for (const { slotId } of slots) {
    await prisma.$transaction(async (tx) => {
      const slot = await lockSlotRow(tx, slotId);
      if (!slot) return;
      const n = await releaseExpiredHolds(tx, slotId, now);
      if (n > 0) await recountSlot(tx, slotId);
      released += n;
    }, TX);
  }
  return released;
}

// ---------------------------------------------------------------------------
// Reads (always scoped to the signed-in patient)
// ---------------------------------------------------------------------------

export async function getOwnedAppointment(auth: AuthContext, id: string) {
  const row = await prisma.appointment.findFirst({
    where: { id, bookedById: auth.userId },
    include: appointmentInclude,
  });
  if (!row) throw AppError.notFound("Appointment not found");
  return toAppointmentDto(row);
}

export type AppointmentScope = "upcoming" | "past" | "all";

export async function listAppointments(
  auth: AuthContext,
  scope: AppointmentScope,
  page: PaginationQuery,
) {
  const now = new Date();
  const live: AppointmentStatus[] = ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];
  const validHold = { status: "PENDING_PAYMENT" as const, holdExpiresAt: { gt: now } };
  const notExpired = {
    status: { notIn: ["EXPIRED", "PENDING_PAYMENT"] as AppointmentStatus[] },
  };

  const where =
    scope === "upcoming"
      ? {
          bookedById: auth.userId,
          slotEnd: { gt: now },
          OR: [{ status: { in: live } }, validHold],
        }
      : scope === "past"
        ? {
            bookedById: auth.userId,
            ...notExpired,
            OR: [
              { slotEnd: { lte: now } },
              { status: { in: ["CANCELLED", "COMPLETED", "NO_SHOW"] as AppointmentStatus[] } },
            ],
          }
        : { bookedById: auth.userId, OR: [notExpired, validHold] };

  const [rows, total] = await prisma.$transaction([
    prisma.appointment.findMany({
      where,
      orderBy: { slotStart: scope === "upcoming" ? "asc" : "desc" },
      ...toSkipTake(page),
      include: appointmentInclude,
    }),
    prisma.appointment.count({ where }),
  ]);
  return paginate(
    rows.map((r) => toAppointmentDto(r, now)),
    total,
    page,
  );
}
