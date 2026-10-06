import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startBloodExpiryJob } from "./jobs/blood-expiry.job.js";
import { startHoldReleaseJob } from "./jobs/hold-release.job.js";
import { startOutboxJob } from "./jobs/outbox.job.js";
import { startSlotGenerationJob } from "./jobs/slot-generation.job.js";
import { startWaitlistJob } from "./jobs/waitlist.job.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { captureServerError, flushSentry, initSentry } from "./lib/sentry.js";

initSentry();
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

const stopJobs: Array<() => void> = [];
if (env.JOBS_ENABLED) {
  stopJobs.push(startSlotGenerationJob());
  stopJobs.push(startHoldReleaseJob());
  stopJobs.push(startOutboxJob());
  stopJobs.push(startBloodExpiryJob());
  stopJobs.push(startWaitlistJob());
}

/** Finish in-flight requests and close the DB pool before exiting (deploys, Ctrl+C). */
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  stopJobs.forEach((stop) => stop());
  server.close(async () => {
    await prisma.$disconnect();
    await flushSentry();
    process.exit(0);
  });
  // Force exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
  captureServerError(reason, { method: "process", route: "unhandledRejection" });
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  captureServerError(err, { method: "process", route: "uncaughtException" });
  // The process state is unknown after this: report, then let the platform restart us.
  void flushSentry().finally(() => process.exit(1));
});
