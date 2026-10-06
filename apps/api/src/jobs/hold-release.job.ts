import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { expireStaleHolds } from "../modules/appointments/booking.service.js";

/**
 * Releases unpaid holds after BOOKING_HOLD_MINUTES. Booking correctness does not
 * depend on this job (expired holds are also released inside the booking
 * transaction); it keeps availability pages accurate and the table tidy.
 */
export function startHoldReleaseJob(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const released = await expireStaleHolds();
      if (released > 0) logger.info({ job: "hold-release", released }, "released expired holds");
    } catch (err) {
      logger.error({ err }, "hold release job failed");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(run, env.HOLD_RELEASE_INTERVAL_SECONDS * 1000);
  interval.unref();
  return () => clearInterval(interval);
}
