import { env } from "../../config/env.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { Plan, SubscriptionPaymentMethod } from "../../generated/prisma/client.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { ACTIVE_STATUSES } from "../appointments/booking-rules.js";
import { advisoryLock } from "../appointments/booking.service.js";
import {
  acceptsBookings,
  accessState,
  addMonths,
  daysLeft,
  monthRange,
  noticeFor,
  paidPeriod,
  withinLimit,
  type AccessState,
} from "./subscription-rules.js";

/**
 * Hospital subscriptions. A hospital without a subscription row (created before plans existed or
 * by a script) is treated as unrestricted, so a missing row never locks anyone out. New hospitals
 * get the default plan when they are created.
 */

export type Feature = "analytics" | "slipPrinting";

export function toPlanDto(p: Plan) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    priceMonthly: p.priceMonthly,
    currency: p.currency,
    maxDoctors: p.maxDoctors,
    maxStaff: p.maxStaff,
    maxMonthlyBookings: p.maxMonthlyBookings,
    analytics: p.analytics,
    slipPrinting: p.slipPrinting,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  };
}

const subscriptionInclude = { plan: true } satisfies Prisma.SubscriptionInclude;

export interface Access {
  /** Null for a hospital with no subscription: unrestricted. */
  state: AccessState | null;
  acceptingBookings: boolean;
  plan: Plan | null;
  features: Record<Feature, boolean>;
  limits: { maxDoctors: number | null; maxStaff: number | null; maxMonthlyBookings: number | null };
}

const UNRESTRICTED: Access = {
  state: null,
  acceptingBookings: true,
  plan: null,
  features: { analytics: true, slipPrinting: true },
  limits: { maxDoctors: null, maxStaff: null, maxMonthlyBookings: null },
};

export async function hospitalAccess(
  db: DbClient,
  hospitalId: string,
  now: Date = new Date(),
): Promise<Access> {
  const sub = await db.subscription.findUnique({
    where: { hospitalId },
    include: subscriptionInclude,
  });
  if (!sub) return UNRESTRICTED;
  const state = accessState(sub, now, env.SUBSCRIPTION_GRACE_DAYS);
  return {
    state,
    acceptingBookings: acceptsBookings(state),
    plan: sub.plan,
    features: { analytics: sub.plan.analytics, slipPrinting: sub.plan.slipPrinting },
    limits: {
      maxDoctors: sub.plan.maxDoctors,
      maxStaff: sub.plan.maxStaff,
      maxMonthlyBookings: sub.plan.maxMonthlyBookings,
    },
  };
}

/** For lists: whether each hospital is taking online bookings. A hospital with no row is. */
export async function acceptingBookingsFor(
  db: DbClient,
  hospitalIds: string[],
  now: Date = new Date(),
): Promise<Map<string, boolean>> {
  const out = new Map(hospitalIds.map((id) => [id, true]));
  if (hospitalIds.length === 0) return out;
  const subs = await db.subscription.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { hospitalId: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
  });
  for (const s of subs) {
    out.set(s.hospitalId, acceptsBookings(accessState(s, now, env.SUBSCRIPTION_GRACE_DAYS)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function hospitalUsage(db: DbClient, hospitalId: string, now: Date = new Date()) {
  const hospital = await db.hospital.findUnique({
    where: { id: hospitalId },
    select: { timezone: true },
  });
  const month = monthRange(now, hospital?.timezone ?? "Asia/Kolkata");
  const [doctors, staff, monthlyBookings] = await Promise.all([
    db.doctor.count({ where: { hospitalId, isActive: true } }),
    db.user.count({
      where: { hospitalId, role: { in: ["RECEPTIONIST", "DOCTOR"] }, status: "ACTIVE" },
    }),
    db.appointment.count({
      where: {
        hospitalId,
        source: "ONLINE",
        status: { in: [...ACTIVE_STATUSES] },
        createdAt: { gte: month.from, lt: month.to },
      },
    }),
  ]);
  return { doctors, staff, monthlyBookings };
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

function limitError(what: string, limit: number, planName: string) {
  return AppError.conflict(
    `The ${planName} plan allows ${limit} ${what}. Ask MediQ to move your hospital to a bigger plan.`,
    "PLAN_LIMIT",
  );
}

/** Call before adding (or re-activating) a doctor. */
export async function assertCanAddDoctor(db: DbClient, hospitalId: string): Promise<void> {
  const access = await hospitalAccess(db, hospitalId);
  const limit = access.limits.maxDoctors;
  if (limit === null) return;
  const { doctors } = await hospitalUsage(db, hospitalId);
  if (!withinLimit(limit, doctors)) throw limitError("doctors", limit, access.plan!.name);
}

/** Call before adding a receptionist or doctor login. */
export async function assertCanAddStaff(db: DbClient, hospitalId: string): Promise<void> {
  const access = await hospitalAccess(db, hospitalId);
  const limit = access.limits.maxStaff;
  if (limit === null) return;
  const { staff } = await hospitalUsage(db, hospitalId);
  if (!withinLimit(limit, staff)) throw limitError("staff logins", limit, access.plan!.name);
}

/** Call before using a plan feature (analytics, slip printing). */
export async function assertFeature(
  db: DbClient,
  hospitalId: string,
  feature: Feature,
): Promise<void> {
  const access = await hospitalAccess(db, hospitalId);
  if (!access.features[feature]) {
    throw AppError.forbidden(
      `This is not part of the ${access.plan!.name} plan. Ask MediQ to move your hospital to a bigger plan.`,
      "PLAN_FEATURE",
    );
  }
}

/**
 * Online bookings: the hospital's subscription must be in good standing and it must be under its
 * monthly limit. The messages are for patients, so they never mention plans. Pass the transaction
 * client with `lock` to make the monthly count race-free.
 */
export async function assertBookingsOpen(
  db: DbClient,
  hospitalId: string,
  options: { lock?: boolean } = {},
): Promise<void> {
  const access = await hospitalAccess(db, hospitalId);
  if (!access.acceptingBookings) {
    throw AppError.conflict(
      "This hospital is not taking online bookings right now. Please call the hospital.",
      "BOOKINGS_PAUSED",
    );
  }
  const limit = access.limits.maxMonthlyBookings;
  if (limit === null) return;
  if (options.lock)
    await advisoryLock(db as Parameters<typeof advisoryLock>[0], `hospital-bookings:${hospitalId}`);
  const { monthlyBookings } = await hospitalUsage(db, hospitalId);
  if (!withinLimit(limit, monthlyBookings)) {
    throw AppError.conflict(
      "This hospital cannot take more online bookings this month. Please call the hospital.",
      "BOOKINGS_PAUSED",
    );
  }
}

/** New hospitals start on the default plan (the free pilot unless settings say otherwise). */
export async function createDefaultSubscription(
  db: DbClient,
  hospitalId: string,
  assignedById: string | null,
): Promise<void> {
  const plan = await db.plan.findUnique({ where: { code: env.DEFAULT_PLAN_CODE } });
  if (!plan) return; // no such plan configured: the hospital is unrestricted until an admin assigns one
  await db.subscription.create({
    data: { hospitalId, planId: plan.id, status: "ACTIVE", assignedById },
  });
}

// ---------------------------------------------------------------------------
// The picture of one hospital's subscription (hospital and admin screens)
// ---------------------------------------------------------------------------

export async function subscriptionView(hospitalId: string, now: Date = new Date()) {
  const sub = await prisma.subscription.findUnique({
    where: { hospitalId },
    include: {
      plan: true,
      payments: {
        orderBy: { paidAt: "desc" },
        take: 24,
        include: { recordedBy: { select: { name: true } } },
      },
    },
  });
  const usage = await hospitalUsage(prisma, hospitalId, now);
  if (!sub) {
    return {
      plan: null,
      status: null,
      state: null as AccessState | null,
      notice: "none" as const,
      acceptingBookings: true,
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      daysLeft: null,
      notes: null,
      usage,
      payments: [],
    };
  }
  const state = accessState(sub, now, env.SUBSCRIPTION_GRACE_DAYS);
  const end = sub.status === "TRIALING" ? sub.trialEndsAt : sub.currentPeriodEnd;
  return {
    plan: toPlanDto(sub.plan),
    status: sub.status,
    state,
    notice: noticeFor(state, end, now),
    acceptingBookings: acceptsBookings(state),
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    daysLeft: daysLeft(end, now),
    notes: sub.notes,
    usage,
    payments: sub.payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      reference: p.reference,
      paidAt: p.paidAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      note: p.note,
      recordedBy: p.recordedBy.name,
    })),
  };
}

// ---------------------------------------------------------------------------
// Admin: plans
// ---------------------------------------------------------------------------

export interface PlanInput {
  code: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  currency: string;
  maxDoctors: number | null;
  maxStaff: number | null;
  maxMonthlyBookings: number | null;
  analytics: boolean;
  slipPrinting: boolean;
  isActive: boolean;
  sortOrder: number;
}

export async function listPlans() {
  const plans = await prisma.plan.findMany({
    orderBy: [{ sortOrder: "asc" }, { priceMonthly: "asc" }],
    include: { _count: { select: { subscriptions: true } } },
  });
  return plans.map(({ _count, ...p }) => ({ ...toPlanDto(p), hospitals: _count.subscriptions }));
}

export async function createPlan(admin: AuthContext, input: PlanInput, meta: RequestMeta) {
  try {
    return await prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({ data: input });
      await audit(tx, {
        actor: { userId: admin.userId, role: admin.role },
        action: "plan.created",
        entityType: "Plan",
        entityId: plan.id,
        after: toPlanDto(plan),
        meta,
      });
      return toPlanDto(plan);
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("A plan with this code already exists.", "CODE_TAKEN");
    }
    throw err;
  }
}

/** The code never changes: settings and scripts refer to it. */
export async function updatePlan(
  admin: AuthContext,
  id: string,
  patch: Partial<Omit<PlanInput, "code">>,
  meta: RequestMeta,
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.plan.findUnique({ where: { id } });
    if (!before) throw AppError.notFound("Plan not found");
    if (patch.isActive === false && before.code === env.DEFAULT_PLAN_CODE) {
      throw AppError.conflict(
        "The plan new hospitals start on cannot be switched off.",
        "DEFAULT_PLAN",
      );
    }
    const plan = await tx.plan.update({ where: { id }, data: patch });
    await audit(tx, {
      actor: { userId: admin.userId, role: admin.role },
      action: "plan.updated",
      entityType: "Plan",
      entityId: id,
      before: toPlanDto(before),
      after: toPlanDto(plan),
      meta,
    });
    return toPlanDto(plan);
  });
}

// ---------------------------------------------------------------------------
// Admin: one hospital's subscription
// ---------------------------------------------------------------------------

const actorOf = (a: AuthContext) => ({ userId: a.userId, role: a.role });

async function requireHospital(db: DbClient, hospitalId: string) {
  const hospital = await db.hospital.findUnique({
    where: { id: hospitalId },
    select: { id: true },
  });
  if (!hospital) throw AppError.notFound("Hospital not found");
}

export interface AssignInput {
  planId: string;
  /** A trial of this many days, or a paid period of this many months, or neither for an open-ended free plan. */
  trialDays?: number;
  periodMonths?: number;
  notes: string | null;
}

export async function assignPlan(
  admin: AuthContext,
  hospitalId: string,
  input: AssignInput,
  meta: RequestMeta,
) {
  if (input.trialDays !== undefined && input.periodMonths !== undefined) {
    throw AppError.badRequest("Choose a trial or a paid period, not both.", "TRIAL_OR_PERIOD");
  }
  await prisma.$transaction(async (tx) => {
    await requireHospital(tx, hospitalId);
    const plan = await tx.plan.findUnique({ where: { id: input.planId } });
    if (!plan || !plan.isActive)
      throw AppError.badRequest("Choose an active plan.", "PLAN_NOT_FOUND");
    if (
      input.trialDays === undefined &&
      input.periodMonths === undefined &&
      plan.priceMonthly > 0
    ) {
      throw AppError.badRequest("A paid plan needs a trial or a paid period.", "PERIOD_REQUIRED");
    }

    const now = new Date();
    const dates =
      input.trialDays !== undefined
        ? {
            status: "TRIALING" as const,
            trialEndsAt: new Date(now.getTime() + input.trialDays * 86_400_000),
            currentPeriodStart: null,
            currentPeriodEnd: null,
          }
        : input.periodMonths !== undefined
          ? {
              status: "ACTIVE" as const,
              trialEndsAt: null,
              currentPeriodStart: now,
              currentPeriodEnd: addMonths(now, input.periodMonths),
            }
          : {
              status: "ACTIVE" as const,
              trialEndsAt: null,
              currentPeriodStart: null,
              currentPeriodEnd: null,
            };

    const before = await tx.subscription.findUnique({
      where: { hospitalId },
      include: subscriptionInclude,
    });
    const after = await tx.subscription.upsert({
      where: { hospitalId },
      create: {
        hospitalId,
        planId: plan.id,
        notes: input.notes,
        assignedById: admin.userId,
        ...dates,
      },
      update: { planId: plan.id, notes: input.notes, assignedById: admin.userId, ...dates },
    });
    await audit(tx, {
      actor: actorOf(admin),
      action: "subscription.assigned",
      entityType: "Subscription",
      entityId: after.id,
      hospitalId,
      before: before
        ? { plan: before.plan.code, status: before.status, end: before.currentPeriodEnd }
        : undefined,
      after: {
        plan: plan.code,
        status: after.status,
        end: after.currentPeriodEnd ?? after.trialEndsAt,
      },
      meta,
    });
  });
}

export interface PaymentInput {
  amount: number;
  method: SubscriptionPaymentMethod;
  reference: string | null;
  paidAt?: Date;
  /** How many months this payment buys. */
  periodMonths: number;
  note: string | null;
}

/** An offline payment (bank transfer, UPI, cash, cheque) the admin received: records it and extends the plan. */
export async function recordPayment(
  admin: AuthContext,
  hospitalId: string,
  input: PaymentInput,
  meta: RequestMeta,
) {
  return prisma.$transaction(async (tx) => {
    await requireHospital(tx, hospitalId);
    await advisoryLock(tx, `subscription:${hospitalId}`);
    const sub = await tx.subscription.findUnique({
      where: { hospitalId },
      include: subscriptionInclude,
    });
    if (!sub)
      throw AppError.conflict("Assign a plan before recording a payment.", "NO_SUBSCRIPTION");
    if (sub.status === "SUSPENDED" || sub.status === "CANCELLED") {
      throw AppError.conflict(
        "Resume the subscription before recording a payment.",
        "INVALID_STATUS",
      );
    }
    const now = new Date();
    const paidAt = input.paidAt ?? now;
    if (paidAt.getTime() > now.getTime() + 86_400_000) {
      throw AppError.badRequest("The payment date cannot be in the future.", "FUTURE_PAYMENT");
    }

    // A trial has no paid period yet; a lapsed or open-ended one starts today.
    const current = sub.status === "ACTIVE" ? sub.currentPeriodEnd : null;
    const period = paidPeriod(current, now, input.periodMonths);
    const payment = await tx.subscriptionPayment.create({
      data: {
        subscriptionId: sub.id,
        amount: input.amount,
        currency: sub.plan.currency,
        method: input.method,
        reference: input.reference,
        paidAt,
        periodStart: period.start,
        periodEnd: period.end,
        note: input.note,
        recordedById: admin.userId,
      },
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE",
        trialEndsAt: null,
        currentPeriodStart:
          sub.status === "ACTIVE" && sub.currentPeriodStart ? sub.currentPeriodStart : period.start,
        currentPeriodEnd: period.end,
      },
    });
    await audit(tx, {
      actor: actorOf(admin),
      action: "subscription.payment_recorded",
      entityType: "Subscription",
      entityId: sub.id,
      hospitalId,
      metadata: {
        paymentId: payment.id,
        amount: input.amount,
        method: input.method,
        months: input.periodMonths,
        periodEnd: period.end,
      },
      meta,
    });
    return { paymentId: payment.id, periodEnd: period.end };
  });
}

type Change = "suspend" | "resume" | "cancel";

export async function changeSubscription(
  admin: AuthContext,
  hospitalId: string,
  change: Change,
  reason: string | null,
  meta: RequestMeta,
) {
  await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `subscription:${hospitalId}`);
    const sub = await tx.subscription.findUnique({ where: { hospitalId } });
    if (!sub) throw AppError.notFound("This hospital has no subscription");
    if (change === "suspend" && sub.status !== "ACTIVE" && sub.status !== "TRIALING") {
      throw AppError.conflict("Only a running subscription can be suspended.", "INVALID_STATUS");
    }
    if (change === "resume" && sub.status !== "SUSPENDED" && sub.status !== "CANCELLED") {
      throw AppError.conflict("This subscription is not suspended or cancelled.", "INVALID_STATUS");
    }
    if (change === "cancel" && sub.status === "CANCELLED") {
      throw AppError.conflict("This subscription is already cancelled.", "INVALID_STATUS");
    }
    // Resuming brings back the state before: a trial that was running stays a trial.
    const status =
      change === "suspend"
        ? "SUSPENDED"
        : change === "cancel"
          ? "CANCELLED"
          : sub.trialEndsAt
            ? "TRIALING"
            : "ACTIVE";
    await tx.subscription.update({
      where: { id: sub.id },
      data: { status, ...(reason ? { notes: reason } : {}) },
    });
    await audit(tx, {
      actor: actorOf(admin),
      action: `subscription.${change === "suspend" ? "suspended" : change === "cancel" ? "cancelled" : "resumed"}`,
      entityType: "Subscription",
      entityId: sub.id,
      hospitalId,
      before: { status: sub.status },
      after: { status },
      metadata: reason ? { reason } : undefined,
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Admin: who needs attention
// ---------------------------------------------------------------------------

export type SubscriptionFilter = "all" | "attention";

export async function listSubscriptions(filter: SubscriptionFilter, skip: number, take: number) {
  const now = new Date();
  const subs = await prisma.subscription.findMany({
    take: 2000,
    include: {
      plan: { select: { code: true, name: true, priceMonthly: true, currency: true } },
      hospital: { select: { id: true, name: true, status: true } },
    },
  });
  const rows = subs
    .map((s) => {
      const state = accessState(s, now, env.SUBSCRIPTION_GRACE_DAYS);
      const end = s.status === "TRIALING" ? s.trialEndsAt : s.currentPeriodEnd;
      return {
        hospitalId: s.hospital.id,
        hospital: s.hospital.name,
        hospitalStatus: s.hospital.status,
        plan: s.plan,
        status: s.status,
        state,
        notice: noticeFor(state, end, now),
        endsAt: end,
        daysLeft: daysLeft(end, now),
      };
    })
    .filter((r) => filter === "all" || r.notice !== "none")
    // Soonest end first; open-ended ones last.
    .sort(
      (a, b) =>
        (a.endsAt?.getTime() ?? Infinity) - (b.endsAt?.getTime() ?? Infinity) ||
        a.hospital.localeCompare(b.hospital),
    );
  return { total: rows.length, items: rows.slice(skip, skip + take) };
}
