import type { Role } from "../../generated/prisma/client.js";
import type { DbClient } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
import { firstAvailable, generateTempPassword, slugify } from "../../utils/credentials.js";
import { hashPassword } from "../../utils/password.js";
import { revokeAllForUser } from "../auth/tokens.js";

/**
 * Credentials are returned to the caller exactly once and never stored in
 * plain text or written to logs/audit entries.
 */
export interface IssuedCredentials {
  loginId: string;
  temporaryPassword: string;
}

export type StaffRole = Extract<Role, "HOSPITAL_ADMIN" | "RECEPTIONIST" | "DOCTOR">;

export const staffUserSelect = {
  id: true,
  role: true,
  status: true,
  name: true,
  loginId: true,
  contactPhone: true,
  email: true,
  mustChangePassword: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
} as const;

/** Suggests a free login ID like "sunrise.reception" or "sunrise.reception2". */
export async function suggestLoginId(db: DbClient, base: string): Promise<string> {
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 56);
  return firstAvailable(
    clean.length >= 3 ? clean : `user.${clean}`,
    async (candidate) => (await db.user.count({ where: { loginId: candidate } })) > 0,
    "",
  );
}

/** First word of the hospital slug, used as a login-ID prefix ("sunrise"). */
export function loginPrefix(hospitalSlug: string): string {
  return slugify(hospitalSlug).split("-")[0] ?? "staff";
}

export async function createStaffAccount(
  db: DbClient,
  input: {
    role: StaffRole;
    hospitalId: string;
    name: string;
    /** Explicit login ID; when omitted one is generated from `loginIdBase`. */
    loginId?: string;
    loginIdBase: string;
    contactPhone?: string | null;
    email?: string | null;
    createdById: string;
  },
) {
  let loginId: string;
  if (input.loginId) {
    if ((await db.user.count({ where: { loginId: input.loginId } })) > 0) {
      throw AppError.conflict("That login ID is already taken", "LOGIN_ID_TAKEN");
    }
    loginId = input.loginId;
  } else {
    loginId = await suggestLoginId(db, input.loginIdBase);
  }

  const temporaryPassword = generateTempPassword();
  const user = await db.user.create({
    data: {
      role: input.role,
      hospitalId: input.hospitalId,
      name: input.name,
      loginId,
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      contactPhone: input.contactPhone ?? null,
      email: input.email ?? null,
      createdById: input.createdById,
    },
    select: staffUserSelect,
  });

  const credentials: IssuedCredentials = { loginId, temporaryPassword };
  return { user, credentials };
}

/**
 * Issues a new temporary password. The user must change it at next login, and
 * every existing session is ended immediately.
 */
export async function resetStaffPassword(db: DbClient, userId: string): Promise<IssuedCredentials> {
  const temporaryPassword = generateTempPassword();
  const user = await db.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
    select: { loginId: true },
  });
  await revokeAllForUser(db, userId);
  return { loginId: user.loginId!, temporaryPassword };
}

/** Blocks or unblocks a staff user; blocking ends their sessions immediately. */
export async function setStaffStatus(db: DbClient, userId: string, blocked: boolean) {
  const user = await db.user.update({
    where: { id: userId },
    data: blocked
      ? { status: "BLOCKED", tokenVersion: { increment: 1 } }
      : { status: "ACTIVE", failedLoginCount: 0, lockedUntil: null },
    select: staffUserSelect,
  });
  if (blocked) await revokeAllForUser(db, userId);
  return user;
}
