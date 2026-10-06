import type { Request, RequestHandler } from "express";
import type { Role } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { AppError } from "../utils/http.js";
import { tagGuard } from "../utils/guards.js";

export interface AuthContext {
  userId: string;
  role: Role;
  name: string;
  /** Hospital the staff member belongs to; null for admin and patients. */
  hospitalId: string | null;
  /** Blood bank a BLOOD_BANK_STAFF member works for; null for everyone else. */
  bloodBankId?: string | null;
}

interface AuthenticateOptions {
  /**
   * Let users who still have to replace their temporary password through.
   * Only the endpoints needed to do that (me, change-password, logout) set this.
   */
  allowPasswordChange?: boolean;
}

/**
 * Verifies the Bearer access token, then re-checks the user in the database so
 * that blocking a user or hospital, or changing a password (tokenVersion bump),
 * takes effect immediately rather than when the token expires.
 */
export function authenticate(options: AuthenticateOptions = {}): RequestHandler {
  return tagGuard(
    async (req, _res, next) => {
      const header = req.get("authorization");
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
      if (!token) throw AppError.unauthorized();

      const payload = verifyAccessToken(token);

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          name: true,
          status: true,
          hospitalId: true,
          bloodBankId: true,
          tokenVersion: true,
          mustChangePassword: true,
          hospital: { select: { status: true } },
          bloodBank: { select: { status: true } },
        },
      });

      if (!user || user.tokenVersion !== payload.tv) {
        throw AppError.unauthorized(
          "Your session has ended. Please log in again.",
          "SESSION_REVOKED",
        );
      }
      if (user.status === "BLOCKED") {
        throw AppError.forbidden("This account has been blocked", "ACCOUNT_BLOCKED");
      }
      if (user.hospital?.status === "BLOCKED") {
        throw AppError.forbidden("This hospital has been blocked", "HOSPITAL_BLOCKED");
      }
      if (user.bloodBank?.status === "BLOCKED") {
        throw AppError.forbidden("This blood bank has been blocked", "BLOOD_BANK_BLOCKED");
      }
      if (user.mustChangePassword && !options.allowPasswordChange) {
        throw AppError.forbidden(
          "You must change your temporary password first",
          "PASSWORD_CHANGE_REQUIRED",
        );
      }

      req.auth = {
        userId: user.id,
        role: user.role,
        name: user.name,
        hospitalId: user.hospitalId,
        bloodBankId: user.bloodBankId,
      };
      next();
    },
    { kind: "auth", allowPasswordChange: options.allowPasswordChange === true },
  );
}

/** Typed accessor for handlers mounted behind `authenticate()`. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}
