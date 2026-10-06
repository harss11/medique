import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { syncDoctorSlots } from "../modules/slots/slots.service.js";

export interface SlotJobResult {
  doctors: number;
  created: number;
  removed: number;
  failed: number;
}

/**
 * Rolls every active doctor's slot window forward (adds the new day at the end
 * of the window, cleans up removed sessions). Safe to run on several API
 * instances at once: each doctor is synced under its own advisory lock and the
 * sync is idempotent.
 */
export async function generateSlotsForAllDoctors(): Promise<SlotJobResult> {
  const doctors = await prisma.doctor.findMany({
    where: { hospital: { status: { not: "BLOCKED" } } },
    select: { id: true },
  });

  const result: SlotJobResult = { doctors: doctors.length, created: 0, removed: 0, failed: 0 };
  for (const { id } of doctors) {
    try {
      const summary = await syncDoctorSlots(id);
      result.created += summary.created;
      result.removed += summary.removed;
    } catch (err) {
      result.failed++;
      logger.error({ err, doctorId: id }, "slot generation failed for doctor");
    }
  }
  return result;
}

/** Runs shortly after boot, then every SLOT_JOB_INTERVAL_HOURS. */
export function startSlotGenerationJob(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await generateSlotsForAllDoctors();
      logger.info({ job: "slot-generation", ...result }, "slot generation finished");
    } catch (err) {
      logger.error({ err }, "slot generation job crashed");
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, 10_000);
  const interval = setInterval(run, env.SLOT_JOB_INTERVAL_HOURS * 60 * 60 * 1000);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
