import type { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { auditSafe } from "../../utils/audit.js";
import { randomToken, sha256 } from "../../utils/crypto.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";

const ISSUER = "mediq-api";
const ACCESS_AUDIENCE = "mediq";
const SIGNUP_AUDIENCE = "mediq-signup";

// ---------------------------------------------------------------------------
// Access tokens: short-lived JWTs sent as `Authorization: Bearer ...`
// ---------------------------------------------------------------------------

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  /** hospitalId for hospital staff */
  hid: string | null;
  /** must match User.tokenVersion, otherwise the token was revoked */
  tv: number;
}

export function signAccessToken(user: {
  id: string;
  role: Role;
  hospitalId: string | null;
  tokenVersion: number;
}) {
  const payload: Omit<AccessTokenPayload, "sub"> = {
    role: user.role,
    hid: user.hospitalId,
    tv: user.tokenVersion,
  };
  const token = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: user.id,
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_TTL_SECONDS * 1000);
  return { token, expiresAt };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
    });
    if (typeof decoded === "string" || !decoded.sub) throw new Error("malformed token");
    return decoded as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized("Access token expired", "TOKEN_EXPIRED");
    }
    throw AppError.unauthorized("Invalid access token", "INVALID_TOKEN");
  }
}

// ---------------------------------------------------------------------------
// Sign-up tokens: prove a phone number was verified by OTP, for new patients
// ---------------------------------------------------------------------------

const SIGNUP_TOKEN_TTL_SECONDS = 15 * 60;

export function signSignupToken(phone: string): string {
  return jwt.sign({ phone }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    issuer: ISSUER,
    audience: SIGNUP_AUDIENCE,
    expiresIn: SIGNUP_TOKEN_TTL_SECONDS,
  });
}

export function verifySignupToken(token: string): { phone: string } {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: SIGNUP_AUDIENCE,
    });
    if (typeof decoded === "string" || typeof decoded.phone !== "string") {
      throw new Error("malformed token");
    }
    return { phone: decoded.phone };
  } catch {
    throw AppError.badRequest(
      "Your verification has expired. Please verify your phone again.",
      "SIGNUP_TOKEN_INVALID",
    );
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens: opaque, stored hashed, rotated on every use
// ---------------------------------------------------------------------------

export interface IssuedRefreshToken {
  id: string;
  token: string;
  familyId: string;
  expiresAt: Date;
}

/** If two tabs refresh at the same moment, the loser presents an already-rotated
 *  token. Within this window that is treated as a benign race, not theft. */
const REUSE_GRACE_MS = 20_000;

export async function issueRefreshToken(
  db: DbClient,
  userId: string,
  meta: RequestMeta,
  familyId: string = crypto.randomUUID(),
): Promise<IssuedRefreshToken> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const row = await db.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      familyId,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, token, familyId, expiresAt };
}

/**
 * Exchanges a refresh token for a new one (rotation). Presenting a token that
 * was already rotated outside the grace window means it was probably stolen,
 * so the whole family (every token from that login) is revoked.
 */
export async function rotateRefreshToken(
  rawToken: string,
  meta: RequestMeta,
): Promise<{ userId: string; next: IssuedRefreshToken }> {
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
  });
  if (!existing) {
    throw AppError.unauthorized("Please log in again", "INVALID_REFRESH_TOKEN");
  }

  const now = new Date();

  if (existing.revokedAt) {
    const benignRace =
      existing.replacedById !== null &&
      now.getTime() - existing.revokedAt.getTime() < REUSE_GRACE_MS;
    if (!benignRace) {
      await revokeFamily(existing.familyId);
      await auditSafe(prisma, {
        actor: null,
        action: "auth.refresh_token_reuse_detected",
        entityType: "User",
        entityId: existing.userId,
        metadata: { familyId: existing.familyId },
        meta,
      });
      throw AppError.unauthorized("Please log in again", "REFRESH_TOKEN_REUSED");
    }
    const next = await issueRefreshToken(prisma, existing.userId, meta, existing.familyId);
    return { userId: existing.userId, next };
  }

  if (existing.expiresAt <= now) {
    throw AppError.unauthorized(
      "Your session has expired. Please log in again.",
      "REFRESH_TOKEN_EXPIRED",
    );
  }

  const next = await prisma.$transaction(async (tx) => {
    const issued = await issueRefreshToken(tx, existing.userId, meta, existing.familyId);
    await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: now, replacedById: issued.id },
    });
    return issued;
  });

  return { userId: existing.userId, next };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllForUser(db: DbClient, userId: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Transport: web browsers get an httpOnly cookie, the mobile app gets JSON
// ---------------------------------------------------------------------------

export const REFRESH_COOKIE = "mediq_rt";
const REFRESH_COOKIE_PATH = "/api/v1/auth";

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: REFRESH_COOKIE_PATH,
  };
}

/** The mobile app (later) sends `X-Client-Type: mobile` and stores the refresh token itself. */
export function isMobileClient(req: Request): boolean {
  return req.get("x-client-type") === "mobile";
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

/**
 * Reads the refresh token from the cookie (web) or body (mobile).
 * Cookie requests must carry `X-Requested-With`: a custom header forces a CORS
 * preflight, which only allow-listed origins pass, so other sites cannot use
 * the cookie (CSRF defence in addition to SameSite).
 */
export function readRefreshToken(req: Request): string | undefined {
  const fromCookie: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof fromCookie === "string" && fromCookie.length > 0) {
    if (req.get("x-requested-with") !== "XMLHttpRequest") {
      throw AppError.forbidden("Missing X-Requested-With header", "CSRF_CHECK_FAILED");
    }
    return fromCookie;
  }
  const fromBody: unknown = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  return typeof fromBody === "string" && fromBody.length > 0 ? fromBody : undefined;
}
