import { env } from "../../config/env.js";
import { toLanguage, type Language } from "../../utils/language.js";
import {
  Prisma,
  type BloodBankStatus,
  type HospitalStatus,
  type Role,
} from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { audit, auditSafe } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../../utils/password.js";
import { normalizeMobile } from "../../utils/phone.js";
import type { RequestMeta } from "../../utils/request.js";
import type {
  ChangePasswordInput,
  OtpVerifyInput,
  PatientSignupInput,
  StaffLoginInput,
} from "./auth.schemas.js";
import { consumeLoginOtp, sendLoginOtp } from "./otp.service.js";
import {
  issueRefreshToken,
  revokeAllForUser,
  revokeFamily,
  rotateRefreshToken,
  signAccessToken,
  signSignupToken,
  verifySignupToken,
  type IssuedRefreshToken,
} from "./tokens.js";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

// ---------------------------------------------------------------------------
// Public user shape: the only user representation that leaves the API
// ---------------------------------------------------------------------------

const publicUserSelect = {
  id: true,
  role: true,
  status: true,
  name: true,
  loginId: true,
  phone: true,
  email: true,
  hospitalId: true,
  tokenVersion: true,
  mustChangePassword: true,
  language: true,
  hospital: { select: { id: true, name: true, slug: true, status: true } },
  bloodBankId: true,
  bloodBank: { select: { id: true, name: true, status: true } },
} satisfies Prisma.UserSelect;

type UserForSession = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

export interface PublicUser {
  id: string;
  role: Role;
  name: string;
  loginId: string | null;
  phone: string | null;
  email: string | null;
  hospitalId: string | null;
  hospital: { id: string; name: string; slug: string; status: HospitalStatus } | null;
  bloodBankId: string | null;
  bloodBank: { id: string; name: string; status: BloodBankStatus } | null;
  mustChangePassword: boolean;
  /** The language the person chose for MediQ and its messages ("en" or "hi"). */
  language: Language;
}

export function toPublicUser(u: UserForSession): PublicUser {
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    loginId: u.loginId,
    phone: u.phone,
    email: u.email,
    hospitalId: u.hospitalId,
    hospital: u.hospital
      ? {
          id: u.hospital.id,
          name: u.hospital.name,
          slug: u.hospital.slug,
          status: u.hospital.status,
        }
      : null,
    bloodBankId: u.bloodBankId,
    bloodBank: u.bloodBank,
    mustChangePassword: u.mustChangePassword,
    language: toLanguage(u.language),
  };
}

export interface Session {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: PublicUser;
}

function buildSession(user: UserForSession, refresh: IssuedRefreshToken): Session {
  const access = signAccessToken(user);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    user: toPublicUser(user),
  };
}

async function startSession(user: UserForSession, meta: RequestMeta): Promise<Session> {
  const refresh = await issueRefreshToken(prisma, user.id, meta);
  return buildSession(user, refresh);
}

function assertCanSignIn(user: UserForSession): void {
  if (user.status === "BLOCKED") {
    throw AppError.forbidden("This account has been blocked. Contact support.", "ACCOUNT_BLOCKED");
  }
  if (user.hospital?.status === "BLOCKED") {
    throw AppError.forbidden(
      "This hospital has been blocked. Contact support.",
      "HOSPITAL_BLOCKED",
    );
  }
  if (user.bloodBank?.status === "BLOCKED") {
    throw AppError.forbidden(
      "This blood bank has been blocked. Contact support.",
      "BLOOD_BANK_BLOCKED",
    );
  }
}

// ---------------------------------------------------------------------------
// Staff: login ID + password (admin, hospital admin, receptionist, doctor)
// ---------------------------------------------------------------------------

export async function staffLogin(input: StaffLoginInput, meta: RequestMeta): Promise<Session> {
  const invalid = AppError.unauthorized("Invalid login ID or password", "INVALID_CREDENTIALS");

  const user = await prisma.user.findUnique({
    where: { loginId: input.loginId },
    select: { ...publicUserSelect, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });

  if (!user || !user.passwordHash || user.role === "PATIENT") {
    await burnPasswordCheck(input.password);
    throw invalid;
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw AppError.tooMany(
      `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
      "ACCOUNT_LOCKED",
      { retryAfterSeconds },
    );
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const { failedLoginCount } = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount >= MAX_FAILED_LOGINS) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000),
        },
      });
      await auditSafe(prisma, {
        action: "auth.account_locked",
        entityType: "User",
        entityId: user.id,
        hospitalId: user.hospitalId,
        metadata: { failedAttempts: failedLoginCount, lockMinutes: LOCKOUT_MINUTES },
        meta,
      });
    }
    throw invalid;
  }

  // Only reveal blocked status to someone who knows the password.
  assertCanSignIn(user);

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await auditSafe(prisma, {
    actor: { userId: user.id, role: user.role },
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
    hospitalId: user.hospitalId,
    metadata: { method: "password" },
    meta,
  });

  return startSession(user, meta);
}

// ---------------------------------------------------------------------------
// Patients: phone OTP (sign up and log in are the same flow)
// ---------------------------------------------------------------------------

function requirePhone(input: string): string {
  const phone = normalizeMobile(input);
  if (!phone) throw AppError.badRequest("Enter a valid mobile number", "INVALID_PHONE");
  return phone;
}

export async function requestPatientOtp(phoneInput: string, meta: RequestMeta) {
  return sendLoginOtp(requirePhone(phoneInput), meta);
}

export type OtpVerifyResult =
  | { status: "AUTHENTICATED"; session: Session }
  | { status: "SIGNUP_REQUIRED"; signupToken: string };

/**
 * Verifies the OTP. Existing patients get a session. New numbers get a
 * short-lived sign-up token instead: they must give their name and accept the
 * privacy policy and terms (DPDP consent) before an account is created.
 */
export async function verifyPatientOtp(
  input: OtpVerifyInput,
  meta: RequestMeta,
): Promise<OtpVerifyResult> {
  const phone = requirePhone(input.phone);
  await consumeLoginOtp(phone, input.code);

  const user = await prisma.user.findUnique({ where: { phone }, select: publicUserSelect });
  if (!user) return { status: "SIGNUP_REQUIRED", signupToken: signSignupToken(phone) };

  if (user.role !== "PATIENT") throw AppError.forbidden();
  assertCanSignIn(user);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { status: "AUTHENTICATED", session: await startSession(user, meta) };
}

export async function completePatientSignup(
  input: PatientSignupInput,
  meta: RequestMeta,
): Promise<Session> {
  const { phone } = verifySignupToken(input.signupToken);

  // Idempotent: a double-submitted form just logs the user in.
  const existing = await prisma.user.findUnique({ where: { phone }, select: publicUserSelect });
  if (existing) {
    assertCanSignIn(existing);
    return startSession(existing, meta);
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          role: "PATIENT",
          name: input.name,
          phone,
          lastLoginAt: new Date(),
          patientProfiles: { create: { relation: "SELF", fullName: input.name, phone } },
          consents: {
            create: [
              {
                type: "PRIVACY_POLICY",
                version: env.PRIVACY_POLICY_VERSION,
                ip: meta.ip,
                userAgent: meta.userAgent,
              },
              {
                type: "TERMS_OF_SERVICE",
                version: env.TERMS_VERSION,
                ip: meta.ip,
                userAgent: meta.userAgent,
              },
            ],
          },
        },
        select: publicUserSelect,
      });
      await audit(tx, {
        actor: { userId: created.id, role: "PATIENT" },
        action: "patient.signed_up",
        entityType: "User",
        entityId: created.id,
        metadata: {
          privacyPolicyVersion: env.PRIVACY_POLICY_VERSION,
          termsVersion: env.TERMS_VERSION,
        },
        meta,
      });
      return created;
    });
    return startSession(user, meta);
  } catch (err) {
    // Two sign-ups for the same phone raced; the other one won, so log in.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const user = await prisma.user.findUniqueOrThrow({
        where: { phone },
        select: publicUserSelect,
      });
      return startSession(user, meta);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function refreshSession(rawToken: string, meta: RequestMeta): Promise<Session> {
  const { userId, next } = await rotateRefreshToken(rawToken, meta);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
  if (!user) throw AppError.unauthorized("Please log in again", "INVALID_REFRESH_TOKEN");
  try {
    assertCanSignIn(user);
  } catch (err) {
    await revokeFamily(next.familyId);
    throw err;
  }
  return buildSession(user, next);
}

export async function getCurrentUser(auth: AuthContext): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: publicUserSelect,
  });
  if (!user) throw AppError.unauthorized();
  return toPublicUser(user);
}

/**
 * Changes a staff password (also used for the forced first-login reset).
 * Signs out every other device: all refresh tokens are revoked and tokenVersion
 * is bumped so existing access tokens stop working immediately.
 */
export async function changePassword(
  auth: AuthContext,
  input: ChangePasswordInput,
  meta: RequestMeta,
): Promise<Session> {
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: {
      id: true,
      role: true,
      loginId: true,
      hospitalId: true,
      mustChangePassword: true,
      passwordHash: true,
    },
  });
  if (!user?.passwordHash) {
    throw AppError.badRequest("This account does not use a password", "NO_PASSWORD");
  }

  // 400, not 401: a wrong current password must not look like an expired session to the client.
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw AppError.badRequest("Current password is incorrect", "INVALID_CURRENT_PASSWORD");
  }
  if (input.newPassword === input.currentPassword) {
    throw AppError.badRequest(
      "New password must be different from the current one",
      "PASSWORD_REUSED",
    );
  }
  if (user.loginId && input.newPassword.toLowerCase().includes(user.loginId)) {
    throw AppError.badRequest("Password must not contain your login ID", "WEAK_PASSWORD");
  }

  const passwordHash = await hashPassword(input.newPassword);

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
      select: publicUserSelect,
    });
    await revokeAllForUser(tx, user.id);
    await audit(tx, {
      actor: { userId: user.id, role: user.role },
      action: "auth.password_changed",
      entityType: "User",
      entityId: user.id,
      hospitalId: user.hospitalId,
      metadata: { forcedReset: user.mustChangePassword },
      meta,
    });
    return u;
  });

  return startSession(updated, meta);
}
