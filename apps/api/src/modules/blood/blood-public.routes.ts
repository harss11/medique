import { Router } from "express";
import { z } from "zod";
import type { OtpPurpose } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { bloodOtpLimiter, bloodRegisterLimiter } from "../../middleware/rateLimit.js";
import { AppError, ok } from "../../utils/http.js";
import { mount } from "../../utils/mount.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { sendOtp } from "../auth/otp.service.js";
import { mobileSchema, registerBankSchema } from "./bank.schemas.js";
import { registerBloodBank } from "./bank.service.js";
import { bloodRequestsRouter } from "./request.routes.js";

/**
 * /blood: the parts of the blood module anyone can use without signing in. Each one is either
 * proved with a code sent to the person's phone, rate limited, or both.
 */
export const bloodPublicRouter = Router();

mount(bloodPublicRouter, "/requests", bloodRequestsRouter);

const PURPOSES = {
  REQUEST: "BLOOD_REQUEST",
  BANK_REGISTRATION: "BLOOD_BANK_REGISTRATION",
  RECOVERY: "BLOOD_REQUEST_RECOVERY",
} as const satisfies Record<string, OtpPurpose>;

export const bloodOtpSchema = z.object({
  phone: mobileSchema,
  purpose: z.enum(["REQUEST", "BANK_REGISTRATION", "RECOVERY"]),
});

const reply = (phone: string) => ({
  sent: true,
  resendAfterSeconds: 60,
  phoneHint: phone.slice(0, 3) + "******" + phone.slice(-2),
});

/**
 * Sends a verification code. Recovery never says whether the number has an open request (it
 * answers the same either way and only sends when there is one), so the endpoint cannot be
 * used to find out who has asked for blood.
 */
bloodPublicRouter.post("/otp", bloodOtpLimiter, async (req, res) => {
  const { phone, purpose } = parse(bloodOtpSchema, req.body);
  const meta = requestMeta(req);

  if (purpose === "REQUEST") {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const made = await prisma.bloodRequest.count({
      where: { requesterPhone: phone, createdAt: { gte: since } },
    });
    if (made >= env.BLOOD_REQUESTS_PER_PHONE_PER_DAY) {
      throw AppError.tooMany(
        "This number has made the most blood requests allowed in a day. Please call a blood bank directly.",
        "BLOOD_REQUEST_LIMIT",
      );
    }
  }
  if (purpose === "RECOVERY") {
    const open = await prisma.bloodRequest.count({
      where: { requesterPhone: phone, status: "OPEN", expiresAt: { gt: new Date() } },
    });
    if (open === 0) return ok(res, reply(phone));
  }
  await sendOtp(phone, PURPOSES[purpose], meta);
  ok(res, reply(phone));
});

/** A blood bank registers (the contact phone proved with a code). It is listed only after MediQ verifies the licence. */
bloodPublicRouter.post("/banks/register", bloodRegisterLimiter, async (req, res) => {
  const input = parse(registerBankSchema, req.body);
  const bank = await registerBloodBank(input, requestMeta(req));
  ok(res, { id: bank.id, status: bank.status, name: bank.name }, 201);
});
