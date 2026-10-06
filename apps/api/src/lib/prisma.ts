import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Every connection runs in UTC. The Prisma adapter writes timestamps as UTC digits, and a
 * server whose own TimeZone is not UTC (a self-hosted or Asia/Kolkata database) would
 * otherwise shift every stored time, breaking comparisons with now() such as hold
 * expiry, retry schedules and reminders. Forcing UTC makes the app independent of that.
 *
 * The setting is applied before the connection is handed to anyone (no query can run first).
 * It is a session setting, so use a direct database connection or a session-mode pooler: a
 * transaction-mode pooler (such as Neon's "-pooler" host) would not keep it. See docs/DEPLOYMENT.md.
 */
class UtcClient extends pg.Client {}

type ConnectFn = (this: pg.Client, callback?: (err?: Error) => void) => Promise<void> | void;
const baseConnect = pg.Client.prototype.connect as unknown as ConnectFn;
(UtcClient.prototype as unknown as { connect: ConnectFn }).connect = function (callback) {
  const ready = Promise.resolve(baseConnect.call(this))
    .then(() => this.query("SET TIME ZONE 'UTC'"))
    .then(() => undefined);
  if (!callback) return ready;
  ready.then(
    () => callback(),
    (err: Error) => callback(err),
  );
};

/**
 * Single Prisma client for the process.
 *
 * `omit.user.passwordHash` means password hashes are never selected unless a
 * query explicitly opts in with `omit: { passwordHash: false }` (only the login
 * and change-password flows do this).
 */
function createClient() {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    Client: UtcClient as unknown as typeof pg.Client,
  });
  pool.on("error", (err) => logger.error({ err }, "idle database connection error"));
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    omit: { user: { passwordHash: true } },
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Reuse the client across tsx hot reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();
if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** The client handed to `prisma.$transaction(async (tx) => ...)` callbacks. */
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
/** Anything that can run queries: the root client or a transaction client. */
export type DbClient = typeof prisma | TxClient;
