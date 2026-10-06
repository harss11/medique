import type { Gender } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { toLocalDate } from "../../utils/time.js";
import { generateCheckInCode } from "../appointments/booking-rules.js";
import {
  TX,
  advisoryLock,
  freeSeat,
  lockSlotRow,
  nextToken,
  recountSlot,
  releaseExpiredHolds,
} from "../appointments/booking.service.js";
import {
  enqueueAppointmentMessage,
  kickDispatcher,
} from "../notifications/notifications.service.js";
import { dateOfBirthFromAge } from "../queue/queue-rules.js";
import { clearQueueCache } from "../queue/queue.service.js";
import type { DeskScope } from "./desk-scope.js";

export interface WalkInInput {
  slotId: string;
  patient: {
    fullName: string;
    /** E.164 mobile; used for the confirmation SMS and to recognise a returning walk-in. */
    phone: string | null;
    ageYears: number | null;
    gender: Gender | null;
  };
  reasonForVisit: string | null;
  /** CASH: the fee was taken at the desk. PAY_LATER: book now, record cash afterwards. */
  payment: "CASH" | "PAY_LATER";
  /** The patient is standing at the desk, so they are checked in straight away. */
  checkIn: boolean;
  sendSms: boolean;
}

/**
 * A returning walk-in (same name and phone, booked at this hospital before) reuses their
 * profile instead of creating a duplicate. Only this hospital's own desk records are
 * searched: a receptionist can never look up patients of other hospitals or online accounts.
 */
async function findOrCreateProfile(
  tx: TxClient,
  hospitalId: string,
  p: WalkInInput["patient"],
  now: Date,
) {
  const dateOfBirth = p.ageYears != null ? dateOfBirthFromAge(p.ageYears, now) : undefined;
  if (p.phone) {
    const previous = await tx.appointment.findFirst({
      where: {
        hospitalId,
        source: "WALK_IN",
        patientProfile: {
          userId: null,
          deletedAt: null,
          phone: p.phone,
          fullName: { equals: p.fullName, mode: "insensitive" },
        },
      },
      orderBy: { createdAt: "desc" },
      select: { patientProfileId: true },
    });
    if (previous) {
      return tx.patientProfile.update({
        where: { id: previous.patientProfileId },
        data: {
          ...(dateOfBirth ? { dateOfBirth } : {}),
          ...(p.gender ? { gender: p.gender } : {}),
        },
      });
    }
  }
  return tx.patientProfile.create({
    data: {
      userId: null,
      relation: "SELF",
      fullName: p.fullName,
      phone: p.phone,
      dateOfBirth: dateOfBirth ?? null,
      gender: p.gender,
    },
  });
}

/**
 * Books a patient at the front desk and returns the new appointment's id. Same engine as
 * online booking: the slot row is locked, capacity is checked, a seat and the next token
 * are assigned in one transaction, so a receptionist and an online patient can never take
 * the same seat. Desk bookings are confirmed at once (no payment window).
 */
export async function bookWalkIn(
  scope: DeskScope,
  input: WalkInInput,
  meta: RequestMeta,
): Promise<string> {
  const now = new Date();

  const appointmentId = await prisma.$transaction(async (tx) => {
    const preview = await tx.slot.findUnique({
      where: { id: input.slotId },
      select: { hospitalId: true },
    });
    // A slot of another hospital looks exactly like one that does not exist.
    if (!preview || preview.hospitalId !== scope.hospitalId) {
      throw AppError.notFound("This slot does not exist", "SLOT_NOT_FOUND");
    }

    // Lock order is the same as online booking: patient-level lock, then the slot row.
    await advisoryLock(
      tx,
      `walkin:${scope.hospitalId}:${input.patient.fullName.toLowerCase()}:${input.patient.phone ?? ""}`,
    );
    const slot = await lockSlotRow(tx, input.slotId);
    if (!slot) throw AppError.notFound("This slot does not exist", "SLOT_NOT_FOUND");

    const detail = await tx.slot.findUniqueOrThrow({
      where: { id: slot.id },
      select: {
        date: true,
        doctor: { select: { isActive: true, consultationFee: true, departmentId: true } },
        hospital: { select: { status: true, currency: true } },
      },
    });
    // The desk may book a slot that has started (the patient is here now), but not one that has ended.
    if (
      slot.status !== "OPEN" ||
      !detail.doctor.isActive ||
      detail.hospital.status !== "ACTIVE" ||
      slot.endAt <= now
    ) {
      throw AppError.conflict("This slot is not available", "SLOT_UNAVAILABLE");
    }

    await releaseExpiredHolds(tx, slot.id, now);
    const profile = await findOrCreateProfile(tx, scope.hospitalId, input.patient, now);

    const existing = await tx.appointment.findFirst({
      where: {
        patientProfileId: profile.id,
        doctorId: slot.doctorId,
        appointmentDate: detail.date,
        seatNumber: { not: null },
        OR: [{ status: { not: "PENDING_PAYMENT" } }, { holdExpiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (existing) {
      throw AppError.conflict(
        "This patient already has an appointment with this doctor that day",
        "ALREADY_BOOKED",
      );
    }

    const seat = await freeSeat(tx, slot);
    if (seat === null) throw AppError.conflict("This slot is full", "SLOT_FULL");
    const tokenNumber = await nextToken(tx, slot.doctorId, slot.dateStr);
    const fee = detail.doctor.consultationFee;

    const created = await tx.appointment.create({
      data: {
        hospitalId: slot.hospitalId,
        departmentId: detail.doctor.departmentId,
        doctorId: slot.doctorId,
        slotId: slot.id,
        patientProfileId: profile.id,
        bookedById: scope.userId,
        source: "WALK_IN",
        status: input.checkIn ? "CHECKED_IN" : "CONFIRMED",
        appointmentDate: detail.date,
        slotStart: slot.startAt,
        slotEnd: slot.endAt,
        seatNumber: seat,
        tokenNumber,
        feeAmount: fee,
        currency: detail.hospital.currency,
        // The platform commission applies to online bookings only.
        commissionPercent: 0,
        checkInCode: generateCheckInCode(),
        reasonForVisit: input.reasonForVisit,
        confirmedAt: now,
        checkedInAt: input.checkIn ? now : null,
      },
      select: { id: true },
    });

    const takeCash = fee > 0 && input.payment === "CASH";
    if (takeCash) {
      await tx.payment.create({
        data: {
          appointmentId: created.id,
          hospitalId: slot.hospitalId,
          method: "CASH",
          provider: "CASH",
          status: "CAPTURED",
          amount: fee,
          currency: detail.hospital.currency,
          commissionAmount: 0,
          collectedById: scope.userId,
          paidAt: now,
        },
      });
    }
    await recountSlot(tx, slot.id);
    await audit(tx, {
      actor: scope.actor,
      action: "appointment.walk_in_booked",
      entityType: "Appointment",
      entityId: created.id,
      hospitalId: slot.hospitalId,
      after: {
        status: input.checkIn ? "CHECKED_IN" : "CONFIRMED",
        tokenNumber,
        slotStart: slot.startAt,
      },
      metadata: {
        cashTaken: takeCash,
        amount: fee,
        date: toLocalDate(detail.date),
        doctorId: slot.doctorId,
      },
      meta,
    });
    if (input.sendSms && profile.phone)
      await enqueueAppointmentMessage(tx, created.id, "booking_confirmed");
    return created.id;
  }, TX);

  clearQueueCache();
  kickDispatcher();
  return appointmentId;
}
