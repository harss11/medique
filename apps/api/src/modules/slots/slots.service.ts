import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { dateOnly, todayInZone, toLocalDate, addDays, zonedTimeToUtc } from "../../utils/time.js";
import { planSlots } from "./slot-plan.js";

export interface SlotSyncSummary {
  created: number;
  updated: number;
  removed: number;
  /**
   * Slots that should no longer exist (leave added, schedule changed) but
   * already have bookings, so they were kept. The hospital must handle these
   * (cancel/reschedule) — from Phase 3 on they are real patients.
   */
  conflicts: Array<{ slotId: string; startAt: Date; bookedCount: number }>;
}

/**
 * Makes the doctor's future Slot rows match their schedule for the next
 * SLOT_WINDOW_DAYS days. Idempotent and safe to run concurrently:
 *
 * - creates missing slots, updates changed ones without bookings,
 * - deletes slots that are no longer scheduled only if nothing is booked,
 * - never touches past slots, keeps manual BLOCKED status,
 * - a per-doctor advisory lock serialises concurrent runs (job + API edit).
 */
export async function syncDoctorSlots(
  doctorId: string,
  options: { now?: Date; days?: number } = {},
): Promise<SlotSyncSummary> {
  const now = options.now ?? new Date();
  const days = options.days ?? env.SLOT_WINDOW_DAYS;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`slots:${doctorId}`}))`;

      const doctor = await tx.doctor.findUniqueOrThrow({
        where: { id: doctorId },
        select: {
          id: true,
          hospitalId: true,
          isActive: true,
          hospital: { select: { timezone: true, status: true } },
          schedules: { where: { isActive: true } },
        },
      });
      const tz = doctor.hospital.timezone;
      const fromDate = todayInZone(tz, now);
      const windowEnd = zonedTimeToUtc(addDays(fromDate, days), 0, tz);

      const leaves = await tx.doctorLeave.findMany({
        where: { doctorId, endDate: { gte: dateOnly(fromDate) } },
        select: { startDate: true, endDate: true },
      });

      const bookable = doctor.isActive && doctor.hospital.status !== "BLOCKED";
      const plan = bookable
        ? planSlots({
            schedules: doctor.schedules,
            leaves: leaves.map((l) => ({
              startDate: toLocalDate(l.startDate),
              endDate: toLocalDate(l.endDate),
            })),
            timezone: tz,
            fromDate,
            days,
          }).filter((s) => s.startAt > now)
        : [];

      const existing = await tx.slot.findMany({
        where: { doctorId, startAt: { gt: now, lt: windowEnd } },
        select: { id: true, startAt: true, endAt: true, capacity: true, bookedCount: true },
      });

      const planned = new Map(plan.map((p) => [p.startAt.getTime(), p]));
      const current = new Map(existing.map((e) => [e.startAt.getTime(), e]));

      const toCreate = plan.filter((p) => !current.has(p.startAt.getTime()));
      const toRemove: string[] = [];
      const conflicts: SlotSyncSummary["conflicts"] = [];
      let updated = 0;

      for (const slot of existing) {
        const target = planned.get(slot.startAt.getTime());
        if (!target) {
          if (slot.bookedCount === 0) toRemove.push(slot.id);
          else
            conflicts.push({
              slotId: slot.id,
              startAt: slot.startAt,
              bookedCount: slot.bookedCount,
            });
          continue;
        }
        // Booked slots keep their times; capacity may grow but never drop below bookings.
        const capacity = Math.max(target.capacity, slot.bookedCount);
        const endAt = slot.bookedCount === 0 ? target.endAt : slot.endAt;
        if (capacity !== slot.capacity || endAt.getTime() !== slot.endAt.getTime()) {
          await tx.slot.update({ where: { id: slot.id }, data: { capacity, endAt } });
          updated++;
        }
      }

      // `bookedCount: 0` is re-checked under the row lock, so a slot booked
      // concurrently (Phase 3 locks the row) is never deleted.
      const removed = toRemove.length
        ? (await tx.slot.deleteMany({ where: { id: { in: toRemove }, bookedCount: 0 } })).count
        : 0;

      const created = toCreate.length
        ? (
            await tx.slot.createMany({
              data: toCreate.map((p) => ({
                hospitalId: doctor.hospitalId,
                doctorId,
                date: dateOnly(p.date),
                startAt: p.startAt,
                endAt: p.endAt,
                capacity: p.capacity,
              })),
              skipDuplicates: true,
            })
          ).count
        : 0;

      return { created, updated, removed, conflicts };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
