import { Router } from "express";
import { z } from "zod";
import { localDate } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { parse } from "../../utils/validate.js";
import { hospitalScope } from "../hospitals/scope.js";
import { adminStats, hospitalAnalytics } from "./analytics.service.js";

const period = {
  from: localDate.optional(),
  to: localDate.optional(),
  /** Last N days ending on `to` (default today). Ignored when `from` is given. */
  days: z.coerce.number().int().min(1).max(366).optional(),
};

export const adminStatsQuery = z.object({
  ...period,
  hospitalId: z.uuid().optional(),
  timezone: z.string().trim().max(60).optional(),
});

export const hospitalAnalyticsQuery = z.object({ ...period, doctorId: z.uuid().optional() });

/** /admin/stats: mounted behind the admin role gate. */
export const adminStatsRouter = Router();
adminStatsRouter.get("/", async (req, res) => {
  ok(res, await adminStats(parse(adminStatsQuery, req.query)));
});

/** /hospital/analytics: mounted behind the hospital-admin role gate; always the caller's hospital. */
export const hospitalAnalyticsRouter = Router();
hospitalAnalyticsRouter.get("/", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  ok(res, await hospitalAnalytics(hospitalId, parse(hospitalAnalyticsQuery, req.query)));
});
