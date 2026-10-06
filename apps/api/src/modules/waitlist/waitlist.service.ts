import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { logger } from "../../lib/logger.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { addDays, dateOnly, formatDateShort, todayInZone, toLocalDate } from "../../utils/time.js";
import { ACTIVE_STATUSES, isBookable } from "../appointments/booking-rules.js";
import { advisoryLock } from "../appointments/booking.service.js";
import { enqueueGroupMessages, kickDispatcher } from "../notifications/notifications.service.js";
import { acceptingBookingsFor, assertBookingsOpen } from "../subscriptions/subscription.service.js";
import {
  dateInWaitWindow,
  noticeEndsAt,
  patientsToTell,
  positionInLine,
} from "./waitlist-rules.js";

/**
 * The waitlist. When a doctor's day is fully booked a patient can ask to be told if a seat opens
 * (somebody cancels, a hold runs out). `notifyWaitlists` (the job) tells the oldest waiting
 * patients by SMS. The seat is not reserved for them: whoever books first gets it.
 */

const LIVE = ["WAITING", "NOTIFIED"] as const;

/** Seats that can be booked online right now on one day of one doctor, and whether the day has any slots. */
export async function daySeats(db: DbClient, doctorId: string, date: string, now: Date) {
  const slots = await db.slot.findMany({
    where: { doctorId, date: dateOnly(date), status: "OPEN", startAt: { gt: now } },
    select: { startAt: true, capacity: true, bookedCount: true },
  });
  const bookable = slots.filter((s) => isBookable(s.startAt, now));
  return {
    slots: bookable.length,
    free: bookable.reduce((n, s) => n + Math.max(0, s.capacity - s.bookedCount), 0),
  };
}

export async function joinWaitlist(
  auth: AuthContext,
  input: { doctorId: string; date: string; patientProfileId: string },
  meta: RequestMeta,
) {
  const doctor = await prisma.doctor.findFirst({
    where: {
      id: input.doctorId,
      isActive: true,
      department: { isActive: true },
      hospital: { status: "ACTIVE" },
    },
    select: { id: true, hospitalId: true, hospital: { select: { timezone: true } } },
  });
  if (!doctor) throw AppError.notFound("Doctor not found");

  await assertBookingsOpen(prisma, doctor.hospitalId);

  const now = new Date();
  const today = todayInZone(doctor.hospital.timezone, now);
  if (!dateInWaitWindow(input.date, today, addDays(today, env.SLOT_WINDOW_DAYS))) {
    throw AppError.badRequest("Choose a day in the booking window", "DATE_OUT_OF_RANGE");
  }

  return prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `patient:${auth.userId}`);

    const profile = await tx.patientProfile.findFirst({
      where: { id: input.patientProfileId, userId: auth.userId, deletedAt: null },
      select: { id: true },
    });
    if (!profile)
      throw AppError.badRequest("Choose who the appointment is for", "PROFILE_NOT_FOUND");

    const seats = await daySeats(tx, doctor.id, input.date, now);
    if (seats.slots === 0) {
      throw AppError.conflict("The doctor has no bookable slots on this day.", "NO_SLOTS");
    }
    if (seats.free > 0) {
      throw AppError.conflict(
        "Seats are still available on this day. You can book one now.",
        "SLOTS_AVAILABLE",
      );
    }

    const booked = await tx.appointment.findFirst({
      where: {
        doctorId: doctor.id,
        appointmentDate: dateOnly(input.date),
        patientProfileId: profile.id,
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { id: true },
    });
    if (booked) {
      throw AppError.conflict(
        "This person already has an appointment with this doctor that day.",
        "ALREADY_BOOKED",
      );
    }

    const live = await tx.waitlistEntry.count({
      where: { userId: auth.userId, status: { in: [...LIVE] } },
    });
    const existing = await tx.waitlistEntry.findUnique({
      where: {
        doctorId_date_patientProfileId: {
          doctorId: doctor.id,
          date: dateOnly(input.date),
          patientProfileId: profile.id,
        },
      },
    });
    if (existing && (LIVE as readonly string[]).includes(existing.status)) {
      throw AppError.conflict(
        "You are already on the waitlist for this day.",
        "ALREADY_ON_WAITLIST",
      );
    }
    if (live >= env.WAITLIST_MAX_ACTIVE_PER_USER) {
      throw AppError.conflict(
        `You can wait for ${env.WAITLIST_MAX_ACTIVE_PER_USER} days at a time. Leave one to join another.`,
        "WAITLIST_LIMIT",
      );
    }

    // A place taken again after leaving, expiring or booking starts at the back of the line.
    const entry = existing
      ? await tx.waitlistEntry.update({
          where: { id: existing.id },
          data: { status: "WAITING", notifiedAt: null, createdAt: now },
        })
      : await tx.waitlistEntry.create({
          data: {
            doctorId: doctor.id,
            date: dateOnly(input.date),
            patientProfileId: profile.id,
            userId: auth.userId,
          },
        });
    await audit(tx, {
      actor: { userId: auth.userId, role: "PATIENT" },
      action: "waitlist.joined",
      entityType: "WaitlistEntry",
      entityId: entry.id,
      hospitalId: doctor.hospitalId,
      metadata: { date: input.date },
      meta,
    });
    return entry.id;
  });
}

export async function leaveWaitlist(auth: AuthContext, id: string, meta: RequestMeta) {
  await prisma.$transaction(async (tx) => {
    const entry = await tx.waitlistEntry.findFirst({
      where: { id, userId: auth.userId },
      select: { id: true, status: true, doctor: { select: { hospitalId: true } } },
    });
    if (!entry) throw AppError.notFound("Waitlist entry not found");
    if (!(LIVE as readonly string[]).includes(entry.status)) {
      throw AppError.conflict("This waitlist entry has already ended.", "INVALID_STATUS");
    }
    await tx.waitlistEntry.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit(tx, {
      actor: { userId: auth.userId, role: "PATIENT" },
      action: "waitlist.left",
      entityType: "WaitlistEntry",
      entityId: id,
      hospitalId: entry.doctor.hospitalId,
      meta,
    });
  });
}

export async function listMyWaitlist(
  auth: AuthContext,
  scope: "active" | "all",
  skip: number,
  take: number,
) {
  const where: Prisma.WaitlistEntryWhereInput = {
    userId: auth.userId,
    ...(scope === "active" ? { status: { in: [...LIVE] } } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.waitlistEntry.findMany({
      where,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      skip,
      take,
      select: {
        id: true,
        date: true,
        status: true,
        notifiedAt: true,
        createdAt: true,
        doctor: {
          select: {
            id: true,
            name: true,
            photoUrl: true,
            specialization: true,
            hospital: { select: { name: true, slug: true, timezone: true } },
          },
        },
        patientProfile: { select: { fullName: true } },
      },
    }),
    prisma.waitlistEntry.count({ where }),
  ]);

  const now = new Date();
  const items = await Promise.all(
    rows.map(async (r) => {
      const date = toLocalDate(r.date);
      const live = (LIVE as readonly string[]).includes(r.status);
      let position: number | null = null;
      let seatsOpen = false;
      if (live) {
        seatsOpen = (await daySeats(prisma, r.doctor.id, date, now)).free > 0;
      }
      if (r.status === "WAITING") {
        const ahead = await prisma.waitlistEntry.findMany({
          where: { doctorId: r.doctor.id, date: r.date, status: "WAITING" },
          select: { createdAt: true },
        });
        position = positionInLine(
          r.createdAt,
          ahead.map((a) => a.createdAt),
        );
      }
      return {
        id: r.id,
        date,
        status: r.status,
        position,
        seatsOpen,
        notifiedAt: r.notifiedAt,
        noticeEndsAt: noticeEndsAt(r.notifiedAt, env.WAITLIST_NOTICE_MINUTES),
        joinedAt: r.createdAt,
        doctor: {
          id: r.doctor.id,
          name: r.doctor.name,
          photoUrl: r.doctor.photoUrl,
          specialization: r.doctor.specialization,
        },
        hospital: {
          name: r.doctor.hospital.name,
          slug: r.doctor.hospital.slug,
          timezone: r.doctor.hospital.timezone,
        },
        patient: { fullName: r.patientProfile.fullName },
      };
    }),
  );
  return { items, total };
}

/** The patient booked a seat for that doctor and day: the waiting is over. Runs inside the booking transaction. */
export async function markWaitlistBooked(
  tx: DbClient,
  doctorId: string,
  appointmentDate: Date,
  patientProfileId: string,
): Promise<void> {
  await tx.waitlistEntry.updateMany({
    where: { doctorId, date: appointmentDate, patientProfileId, status: { in: [...LIVE] } },
    data: { status: "BOOKED" },
  });
}

export interface WaitlistRound {
  expired: number;
  told: number;
}

/**
 * One pass of the waitlist job. Ends waits for days that are over and notices nobody answered,
 * then tells the oldest waiting patients when their day has free seats. Safe to run often and
 * from several instances: every change re-checks the entry's status in the same statement.
 */
export async function notifyWaitlists(now: Date = new Date()): Promise<WaitlistRound> {
  let expired = 0;
  let told = 0;

  // Days that have passed (in the hospital's own time zone).
  const live = await prisma.waitlistEntry.findMany({
    where: { status: { in: [...LIVE] } },
    distinct: ["doctorId", "date"],
    take: 500,
    select: {
      doctorId: true,
      date: true,
      doctor: { select: { hospital: { select: { timezone: true } } } },
    },
  });
  for (const g of live) {
    if (toLocalDate(g.date) < todayInZone(g.doctor.hospital.timezone, now)) {
      const { count } = await prisma.waitlistEntry.updateMany({
        where: { doctorId: g.doctorId, date: g.date, status: { in: [...LIVE] } },
        data: { status: "EXPIRED" },
      });
      expired += count;
    }
  }

  // Patients who were told and did not book in time lose their place, so the next one is told.
  const stale = await prisma.waitlistEntry.updateMany({
    where: {
      status: "NOTIFIED",
      notifiedAt: { lte: new Date(now.getTime() - env.WAITLIST_NOTICE_MINUTES * 60_000) },
    },
    data: { status: "EXPIRED" },
  });
  expired += stale.count;

  const groups = await prisma.waitlistEntry.findMany({
    where: { status: "WAITING" },
    distinct: ["doctorId", "date"],
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      doctorId: true,
      date: true,
      doctor: {
        select: {
          hospitalId: true,
          name: true,
          isActive: true,
          department: { select: { isActive: true } },
          hospital: { select: { name: true, status: true, timezone: true } },
        },
      },
    },
  });

  const accepting = await acceptingBookingsFor(
    prisma,
    [...new Set(groups.map((g) => g.doctor.hospitalId))],
    now,
  );
  for (const g of groups) {
    const d = g.doctor;
    if (!d.isActive || !d.department.isActive || d.hospital.status !== "ACTIVE") continue;
    if (accepting.get(d.hospitalId) === false) continue; // not taking online bookings: nobody to tell
    const date = toLocalDate(g.date);
    if (date < todayInZone(d.hospital.timezone, now)) continue;

    const { free } = await daySeats(prisma, g.doctorId, date, now);
    if (free === 0) continue;
    const offered = await prisma.waitlistEntry.count({
      where: { doctorId: g.doctorId, date: g.date, status: "NOTIFIED" },
    });
    const n = patientsToTell(free, offered, env.WAITLIST_NOTIFY_BATCH);
    if (n === 0) continue;

    const next = await prisma.waitlistEntry.findMany({
      where: { doctorId: g.doctorId, date: g.date, status: "WAITING" },
      orderBy: { createdAt: "asc" },
      take: n,
      select: {
        id: true,
        user: { select: { id: true, phone: true } },
        patientProfile: { select: { fullName: true } },
      },
    });
    for (const e of next) {
      const sent = await prisma.$transaction(async (tx) => {
        // Only the instance that moves it from WAITING tells the patient.
        const { count } = await tx.waitlistEntry.updateMany({
          where: { id: e.id, status: "WAITING" },
          data: { status: "NOTIFIED", notifiedAt: now },
        });
        if (count === 0) return false;
        if (!e.user.phone) return true; // moved on: nobody to tell, the place is not held
        await enqueueGroupMessages(tx, [
          {
            groupKey: `waitlist:${e.id}`,
            to: e.user.phone,
            userId: e.user.id,
            template: "waitlist_slot_open",
            vars: {
              name: e.patientProfile.fullName,
              doctor: d.name,
              hospital: d.hospital.name,
              date: formatDateShort(dateOnly(date), "UTC"),
            },
          },
        ]);
        return true;
      });
      if (sent) told++;
    }
  }

  if (told > 0) kickDispatcher();
  if (told > 0 || expired > 0) logger.info({ job: "waitlist", told, expired }, "waitlist round");
  return { expired, told };
}
