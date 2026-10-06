import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { notifyWaitlists } from "../modules/waitlist/waitlist.service.js";

/**
 * Tells waiting patients when a seat has opened, and ends waits that ran out. Several API
 * instances can run it: each change re-checks the entry's status, so nobody is told twice.
 */
export function startWaitlistJob(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await notifyWaitlists();
    } catch (err) {
      logger.error({ err }, "waitlist job failed");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(run, env.WAITLIST_INTERVAL_SECONDS * 1000);
  interval.unref();
  return () => clearInterval(interval);
}
