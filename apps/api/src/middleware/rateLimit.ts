import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { tagGuard } from "../utils/guards.js";
import { fail } from "../utils/http.js";

/**
 * Per-IP limits (in-memory store for now; swap in a Redis store when we run
 * more than one API instance). Keep them generous: many Indian mobile users
 * share an IP behind carrier NAT. The strict per-phone and per-account limits
 * live in the auth service and are enforced in the database.
 */
function limiter(name: string, windowMs: number, limit: number, message: string) {
  const handler = rateLimit({
    windowMs,
    limit: limit * env.RATE_LIMIT_MULTIPLIER,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res, _next, options) =>
      fail(res, options.statusCode, { code: "RATE_LIMITED", message }),
  });
  return tagGuard(handler, { kind: "limit", name });
}

const MINUTE = 60_000;

export const globalLimiter = limiter("global", MINUTE, 300, "Too many requests. Please slow down.");
export const loginLimiter = limiter(
  "login",
  15 * MINUTE,
  20,
  "Too many login attempts. Try again in 15 minutes.",
);
export const otpRequestLimiter = limiter(
  "otpRequest",
  15 * MINUTE,
  20,
  "Too many OTP requests. Try again in a few minutes.",
);
export const otpVerifyLimiter = limiter(
  "otpVerify",
  15 * MINUTE,
  40,
  "Too many attempts. Try again in a few minutes.",
);
export const webhookLimiter = limiter("webhook", MINUTE, 600, "Too many requests.");
export const bookingLimiter = limiter(
  "booking",
  MINUTE,
  30,
  "Too many booking attempts. Please slow down.",
);
export const refreshLimiter = limiter(
  "refresh",
  15 * MINUTE,
  200,
  "Too many requests. Please slow down.",
);

const HOUR = 60 * MINUTE;
// Blood endpoints are open to anyone and some send an SMS (which costs money and can be abused),
// so they are limited per address more tightly than the rest of the API.
export const bloodOtpLimiter = limiter(
  "bloodOtp",
  HOUR,
  10,
  "Too many codes requested. Try again in an hour.",
);
export const bloodRequestLimiter = limiter(
  "bloodRequest",
  HOUR,
  6,
  "Too many blood requests from this connection. Try again later.",
);
export const bloodRegisterLimiter = limiter(
  "bloodRegister",
  HOUR,
  6,
  "Too many registration attempts. Try again later.",
);
export const bloodLookupLimiter = limiter(
  "bloodLookup",
  HOUR,
  120,
  "Too many donor look-ups. Try again later.",
);
