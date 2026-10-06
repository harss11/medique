import { env } from "../../config/env.js";
import type { OtpPurpose } from "../../generated/prisma/client.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { sms } from "../../services/sms/index.js";
import { hmacSha256, randomNumericCode, safeEqualHex } from "../../utils/crypto.js";
import { AppError } from "../../utils/http.js";
import { maskPhone } from "../../utils/phone.js";
import type { RequestMeta } from "../../utils/request.js";

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_MAX_PER_HOUR = 5;
export const OTP_MAX_ATTEMPTS = 5;

/** The code is bound to the phone number and hashed with a server secret. */
function hashCode(phone: string, code: string): string {
  return hmacSha256(env.OTP_HMAC_SECRET, `${phone}:${code}`);
}

/**
 * Creates and sends a login OTP. Per-phone limits are enforced in the database
 * (so they hold across API instances): one OTP per 60 s and 5 per hour.
 */
export async function sendLoginOtp(phone: string, meta: RequestMeta) {
  return sendOtp(phone, "LOGIN", meta);
}

/** The text of a code message. Login keeps its original wording (already registered with the SMS regulator). */
function otpText(purpose: OtpPurpose, code: string): { template: string; body: string } {
  const minutes = OTP_TTL_SECONDS / 60;
  return purpose === "LOGIN"
    ? {
        template: "otp_login",
        body: `${code} is your MediQ login code. It expires in ${minutes} minutes. Do not share it with anyone.`,
      }
    : {
        template: "otp_verify",
        body: `${code} is your MediQ verification code. It expires in ${minutes} minutes. Do not share it with anyone.`,
      };
}

/** Sends a one-time code for any purpose (login, a blood request, registering a blood bank). */
export async function sendOtp(phone: string, purpose: OtpPurpose, meta: RequestMeta) {
  const code = randomNumericCode(OTP_LENGTH);
  const now = Date.now();

  const otp = await prisma.$transaction(async (tx) => {
    // Serialise concurrent requests for the same phone so the limits can't be raced.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;

    const recent = await tx.otpCode.findMany({
      where: { phone, purpose, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const last = recent[0];
    if (last) {
      const elapsed = Math.floor((now - last.createdAt.getTime()) / 1000);
      if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
        const retryAfterSeconds = OTP_RESEND_COOLDOWN_SECONDS - elapsed;
        throw AppError.tooMany(
          `Please wait ${retryAfterSeconds} seconds before requesting another code`,
          "OTP_COOLDOWN",
          { retryAfterSeconds },
        );
      }
    }
    if (recent.length >= OTP_MAX_PER_HOUR) {
      throw AppError.tooMany("Too many codes requested. Try again in an hour.", "OTP_LIMIT", {
        retryAfterSeconds: 3600,
      });
    }

    // Only the newest code is valid.
    await tx.otpCode.updateMany({
      where: { phone, purpose, consumedAt: null },
      data: { consumedAt: new Date(now) },
    });

    return tx.otpCode.create({
      data: {
        phone,
        purpose,
        codeHash: hashCode(phone, code),
        expiresAt: new Date(now + OTP_TTL_SECONDS * 1000),
        ip: meta.ip ?? null,
      },
      select: { id: true },
    });
  });

  // Send outside the transaction so a slow provider doesn't hold a DB connection.
  try {
    const text = otpText(purpose, code);
    const result = await sms.send({
      to: phone,
      template: text.template,
      variables: { otp: code, minutes: String(OTP_TTL_SECONDS / 60) },
      body: text.body,
    });
    await prisma.notificationLog.create({
      data: {
        channel: "SMS",
        provider: sms.name,
        to: phone,
        template: otpText(purpose, "").template,
        status: "SENT",
        providerMessageId: result.providerMessageId ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, phone: maskPhone(phone) }, "failed to send OTP");
    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    await prisma.notificationLog.create({
      data: {
        channel: "SMS",
        provider: sms.name,
        to: phone,
        template: otpText(purpose, "").template,
        status: "FAILED",
        error: err instanceof Error ? err.message.slice(0, 500) : "unknown",
      },
    });
    throw new AppError(502, "SMS_FAILED", "We couldn't send the code. Please try again.");
  }

  return {
    phone: maskPhone(phone),
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

/** Checks a code. Each OTP allows 5 attempts and can be used once. */
export async function consumeLoginOtp(phone: string, code: string): Promise<void> {
  return consumeOtp(phone, code, "LOGIN");
}

/** Checks a code for any purpose. A code made for one purpose is useless for another. */
export async function consumeOtp(phone: string, code: string, purpose: OtpPurpose): Promise<void> {
  const otp = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!otp || otp.expiresAt <= new Date()) {
    throw AppError.badRequest("This code has expired. Please request a new one.", "OTP_EXPIRED");
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    throw AppError.badRequest(
      "Too many wrong attempts. Please request a new code.",
      "OTP_TOO_MANY_ATTEMPTS",
    );
  }

  if (!safeEqualHex(hashCode(phone, code), otp.codeHash)) {
    const bumped = await prisma.otpCode.updateMany({
      where: { id: otp.id, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    const attemptsLeft = bumped.count ? Math.max(0, OTP_MAX_ATTEMPTS - otp.attempts - 1) : 0;
    throw AppError.badRequest("Incorrect code", "OTP_INVALID", { attemptsLeft });
  }

  // Conditional update: if two requests race with the right code, only one wins.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: otp.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    throw AppError.badRequest("This code has already been used", "OTP_EXPIRED");
  }
}
