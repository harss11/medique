import { mount } from "../../utils/mount.js";
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { generateSlotsForAllDoctors } from "../../jobs/slot-generation.job.js";
import { auditSafe } from "../../utils/audit.js";
import { ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { adminHospitalsRouter } from "../hospitals/admin-hospitals.routes.js";
import { adminStatsRouter } from "../analytics/analytics.routes.js";
import { adminBloodBanksRouter } from "../blood/admin-banks.routes.js";
import { adminBloodRequestsRouter } from "../blood/admin-requests.routes.js";
import { adminReviewsRouter } from "../reviews/reviews.routes.js";
import {
  adminPlansRouter,
  adminSubscriptionsRouter,
} from "../subscriptions/subscriptions.routes.js";

export const adminRouter = Router();

adminRouter.use(authenticate(), requireRole("ADMIN"));

mount(adminRouter, "/hospitals", adminHospitalsRouter);
mount(adminRouter, "/stats", adminStatsRouter);
mount(adminRouter, "/blood-banks", adminBloodBanksRouter);
mount(adminRouter, "/blood-requests", adminBloodRequestsRouter);
mount(adminRouter, "/reviews", adminReviewsRouter);
mount(adminRouter, "/plans", adminPlansRouter);
mount(adminRouter, "/subscriptions", adminSubscriptionsRouter);

/** POST /admin/jobs/generate-slots — run the slot generation job now (all doctors). */
adminRouter.post("/jobs/generate-slots", async (req, res) => {
  const result = await generateSlotsForAllDoctors();
  await auditSafe(prisma, {
    actor: { userId: req.auth!.userId, role: req.auth!.role },
    action: "job.slots_generated",
    entityType: "Job",
    metadata: { ...result },
    meta: requestMeta(req),
  });
  ok(res, result);
});

export const auditLogQuery = paginationQuery.extend({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(50).optional(),
  entityId: z.string().trim().max(100).optional(),
  actorId: z.uuid().optional(),
  hospitalId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** GET /admin/audit-logs — newest first, filterable, paginated */
adminRouter.get("/audit-logs", async (req, res) => {
  const q = parse(auditLogQuery, req.query);

  const where: Prisma.AuditLogWhereInput = {
    action: q.action ? { startsWith: q.action } : undefined,
    entityType: q.entityType,
    entityId: q.entityId,
    actorId: q.actorId,
    hospitalId: q.hospitalId,
    createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
  };

  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...toSkipTake(q),
      include: {
        actor: { select: { id: true, name: true, role: true, loginId: true } },
        hospital: { select: { id: true, name: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  ok(res, paginate(items, total, q));
});
