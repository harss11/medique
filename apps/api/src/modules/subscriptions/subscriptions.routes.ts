import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/authenticate.js";
import { amountMinor, idParams, nullableText } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { hospitalScope } from "../hospitals/scope.js";
import {
  assertFeature,
  assignPlan,
  changeSubscription,
  createPlan,
  listPlans,
  listSubscriptions,
  recordPayment,
  subscriptionView,
  updatePlan,
  type Feature,
} from "./subscription.service.js";

/** Stops a request for a feature the hospital's plan does not include. Put it behind hospital auth. */
export function requirePlanFeature(feature: Feature): RequestHandler {
  return async (req, _res, next) => {
    try {
      await assertFeature(prisma, hospitalScope(req).hospitalId, feature);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// /hospital/subscription: the hospital admin sees its plan, limits and payments
// ---------------------------------------------------------------------------

export const hospitalSubscriptionRouter = Router();

hospitalSubscriptionRouter.get("/", async (req, res) => {
  ok(res, await subscriptionView(hospitalScope(req).hospitalId));
});

// ---------------------------------------------------------------------------
// /admin/plans
// ---------------------------------------------------------------------------

const limit = z.number().int().min(0).max(100_000).nullable();

const planFields = {
  code: z
    .string()
    .trim()
    .regex(
      /^[a-z][a-z0-9-]{1,39}$/,
      "Use lower case letters, digits and dashes, for example standard",
    ),
  name: z.string().trim().min(2, "Enter the plan name").max(60),
  description: nullableText(300),
  priceMonthly: amountMinor,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Use a 3 letter currency code such as INR"),
  maxDoctors: limit,
  maxStaff: limit,
  maxMonthlyBookings: limit,
  analytics: z.boolean(),
  slipPrinting: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};

/** A new plan: everything not given is free, unlimited and on. */
export const planSchema = z.object({
  ...planFields,
  priceMonthly: planFields.priceMonthly.default(0),
  currency: planFields.currency.default("INR"),
  maxDoctors: limit.default(null),
  maxStaff: limit.default(null),
  maxMonthlyBookings: limit.default(null),
  analytics: z.boolean().default(true),
  slipPrinting: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: planFields.sortOrder.default(0),
});

/**
 * Changing a plan: only what is given changes (no defaults here, or a small edit would reset the
 * rest). The code is the plan's stable name and cannot be changed.
 */
export const updatePlanSchema = z.object(planFields).omit({ code: true }).partial();

export const adminPlansRouter = Router();

adminPlansRouter.get("/", async (_req, res) => {
  ok(res, { items: await listPlans() });
});

adminPlansRouter.post("/", async (req, res) => {
  const body = parse(planSchema, req.body);
  ok(
    res,
    await createPlan(
      requireAuth(req),
      { ...body, description: body.description ?? null },
      requestMeta(req),
    ),
    201,
  );
});

adminPlansRouter.patch("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updatePlanSchema, req.body);
  ok(res, await updatePlan(requireAuth(req), id, body, requestMeta(req)));
});

// ---------------------------------------------------------------------------
// /admin/subscriptions: assign plans, record offline payments, suspend
// ---------------------------------------------------------------------------

export const adminSubscriptionsRouter = Router();

export const subscriptionsQuery = paginationQuery.extend({
  /** "attention": ending soon, in grace, expired, suspended or cancelled. */
  filter: z.enum(["all", "attention"]).default("attention"),
});

const hospitalParams = z.object({ hospitalId: z.uuid() });

export const assignSchema = z.object({
  planId: z.uuid("Choose a plan"),
  trialDays: z.number().int().min(1).max(90).optional(),
  periodMonths: z.number().int().min(1).max(36).optional(),
  notes: nullableText(300),
});

export const paymentSchema = z.object({
  amount: amountMinor.min(1, "Enter the amount received"),
  method: z.enum(["BANK_TRANSFER", "UPI", "CASH", "CHEQUE", "OTHER"]),
  reference: nullableText(100),
  paidAt: z.coerce.date().optional(),
  periodMonths: z.number().int().min(1).max(36),
  note: nullableText(300),
});

export const reasonSchema = z.object({
  reason: z.string().trim().min(5, "Give a reason").max(300),
});

async function ownHospital(hospitalId: string) {
  const exists = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: { id: true },
  });
  if (!exists) throw AppError.notFound("Hospital not found");
}

adminSubscriptionsRouter.get("/", async (req, res) => {
  const q = parse(subscriptionsQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { items, total } = await listSubscriptions(q.filter, skip, take);
  ok(res, paginate(items, total, q));
});

adminSubscriptionsRouter.get("/:hospitalId", async (req, res) => {
  const { hospitalId } = parse(hospitalParams, req.params);
  await ownHospital(hospitalId);
  ok(res, await subscriptionView(hospitalId));
});

adminSubscriptionsRouter.put("/:hospitalId", async (req, res) => {
  const { hospitalId } = parse(hospitalParams, req.params);
  const body = parse(assignSchema, req.body);
  await assignPlan(
    requireAuth(req),
    hospitalId,
    { ...body, notes: body.notes ?? null },
    requestMeta(req),
  );
  ok(res, await subscriptionView(hospitalId));
});

adminSubscriptionsRouter.post("/:hospitalId/payments", async (req, res) => {
  const { hospitalId } = parse(hospitalParams, req.params);
  const body = parse(paymentSchema, req.body);
  const result = await recordPayment(
    requireAuth(req),
    hospitalId,
    { ...body, reference: body.reference ?? null, note: body.note ?? null },
    requestMeta(req),
  );
  ok(res, { ...result, subscription: await subscriptionView(hospitalId) }, 201);
});

for (const change of ["suspend", "cancel"] as const) {
  adminSubscriptionsRouter.post(`/:hospitalId/${change}`, async (req, res) => {
    const { hospitalId } = parse(hospitalParams, req.params);
    const { reason } = parse(reasonSchema, req.body);
    await changeSubscription(requireAuth(req), hospitalId, change, reason, requestMeta(req));
    ok(res, await subscriptionView(hospitalId));
  });
}

adminSubscriptionsRouter.post("/:hospitalId/resume", async (req, res) => {
  const { hospitalId } = parse(hospitalParams, req.params);
  await changeSubscription(requireAuth(req), hospitalId, "resume", null, requestMeta(req));
  ok(res, await subscriptionView(hospitalId));
});
