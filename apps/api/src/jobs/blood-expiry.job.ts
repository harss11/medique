import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { expireBloodRequests, purgeOldBloodRequests } from "../modules/blood/request-expiry.js";

/**
 * Closes blood requests that ran out of time, and (once an hour) removes the requester details
 * from old closed ones. Correctness does not depend on the first (every read also checks the
 * time); it keeps the status honest for the admin list and the dashboards.
 */
export function startBloodExpiryJob(): () => void {
  let running = false;
  let lastPurge = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const expired = await expireBloodRequests();
      if (expired > 0) {
        logger.info({ job: "blood-expiry", expired }, "closed expired blood requests");
      }
      if (Date.now() - lastPurge > 3_600_000) {
        lastPurge = Date.now();
        const purged = await purgeOldBloodRequests(new Date(), env.BLOOD_REQUEST_RETENTION_DAYS);
        if (purged > 0) {
          logger.info({ job: "blood-expiry", purged }, "removed old blood request details");
        }
      }
    } catch (err) {
      logger.error({ err }, "blood request expiry job failed");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(run, 60_000);
  interval.unref();
  return () => clearInterval(interval);
}
