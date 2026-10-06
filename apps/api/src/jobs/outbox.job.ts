import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  dispatchNotifications,
  enqueueDueReminders,
} from "../modules/notifications/notifications.service.js";
import { processDueRefunds } from "../modules/payments/refunds.service.js";

/**
 * One tick every NOTIFY_INTERVAL_SECONDS does the periodic money-and-messages work:
 *   1. queue reminders for appointments starting soon,
 *   2. send queued and retry failed messages,
 *   3. send queued refunds to the gateway (including retries).
 * Each step is idempotent and safe to run on several API instances at once.
 */
export function startOutboxJob(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const reminders = await enqueueDueReminders();
      const { sent, failed } = await dispatchNotifications();
      const refunds = await processDueRefunds();
      if (reminders + sent + failed + refunds > 0) {
        logger.info({ job: "outbox", reminders, sent, failed, refunds }, "outbox tick");
      }
    } catch (err) {
      logger.error({ err }, "outbox job failed");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(run, env.NOTIFY_INTERVAL_SECONDS * 1000);
  interval.unref();
  return () => clearInterval(interval);
}
