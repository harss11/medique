import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { prisma } from "../../lib/prisma.js";
import { LANGUAGES } from "../../utils/language.js";
import { ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { clearRefreshCookie } from "../auth/tokens.js";
import { eraseAccount, exportAccount } from "./account.service.js";

/** /patient/account: the patient's data rights (a copy of their data, and erasure). */
export const accountRouter = Router();

accountRouter.use(authenticate(), requireRole("PATIENT"));

export const eraseSchema = z.object({
  /** Typed by the patient so erasure can never happen by a stray click. */
  confirm: z.literal("ERASE", "Type ERASE to confirm"),
});

export const languageSchema = z.object({ language: z.enum(LANGUAGES) });

/** The language of MediQ and of the SMS it sends this patient. */
accountRouter.patch("/language", async (req, res) => {
  const { language } = parse(languageSchema, req.body);
  await prisma.user.update({ where: { id: requireAuth(req).userId }, data: { language } });
  ok(res, { language });
});

accountRouter.get("/export", async (req, res) => {
  ok(res, await exportAccount(requireAuth(req).userId));
});

accountRouter.post("/erase", async (req, res) => {
  parse(eraseSchema, req.body);
  await eraseAccount(requireAuth(req).userId, requestMeta(req));
  clearRefreshCookie(res);
  ok(res, { erased: true });
});
