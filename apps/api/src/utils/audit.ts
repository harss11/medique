import { Prisma, type Role } from "../generated/prisma/client.js";
import type { DbClient } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { RequestMeta } from "./request.js";

/** Keys that must never be written to the audit trail, at any depth. */
const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "currentPassword",
  "newPassword",
  "tokenHash",
  "codeHash",
  "refreshToken",
  "accessToken",
  "code",
]);

/** Deep-copies a value, replacing sensitive fields and converting Dates/Decimals to strings. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.has(k) ? "[redacted]" : redact(v),
      ]),
    );
  }
  return value;
}

export interface AuditActor {
  userId: string;
  role: Role;
}

export interface AuditEntry {
  actor?: AuditActor | null;
  /** Dotted verb, e.g. "auth.password_changed" */
  action: string;
  entityType: string;
  entityId?: string | null;
  hospitalId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null
    ? Prisma.DbNull
    : (redact(value) as Prisma.InputJsonValue);
}

/**
 * Records who changed what.
 *
 * Pass the transaction client (`tx`) when auditing a data change so the audit
 * row commits or rolls back together with the change itself.
 */
export async function audit(db: DbClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actor?.userId ?? null,
      actorRole: entry.actor?.role ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      hospitalId: entry.hospitalId ?? null,
      before: toJson(entry.before),
      after: toJson(entry.after),
      metadata: toJson(entry.metadata),
      ip: entry.meta?.ip ?? null,
      userAgent: entry.meta?.userAgent ?? null,
    },
  });
}

/**
 * For security events outside a transaction (e.g. failed logins) where losing
 * the audit row must not break the request. Errors are logged, not thrown.
 */
export async function auditSafe(db: DbClient, entry: AuditEntry): Promise<void> {
  try {
    await audit(db, entry);
  } catch (err) {
    logger.error({ err, action: entry.action }, "failed to write audit log");
  }
}
