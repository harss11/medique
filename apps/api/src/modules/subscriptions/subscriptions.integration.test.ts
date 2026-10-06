/**
 * Hospital subscriptions through the real HTTP API: plans, assigning one, offline payments, the
 * limits and features a plan sets, and what a lapsed or suspended hospital can still do.
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { randomToken } from "../../utils/crypto.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cancelAppointment,
  confirmAppointment,
  lockSlot,
} from "../appointments/booking.service.js";
import {
  cleanup,
  createPatients,
  createStaffUser,
  createWorld,
  slotFactory,
  type Patient,
  type Staff,
  type World,
} from "../../../test/fixtures.js";

const TAG = randomToken(4)
  .replace(/[^a-z0-9]/gi, "x")
  .toLowerCase();
const DAY = 86_400_000;

let server: Server;
let base: string;
let world: World;
let other: World;
let makeSlot: ReturnType<typeof slotFactory>;
let patients: Patient[];
let hospitalAdmin: Staff;
let otherAdmin: Staff;
let reception: Staff;
let adminId: string;
let adminToken: string;
const planIds: string[] = [];
const extraWorlds: World[] = [];

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  code?: string;
}

async function http(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as {
    data?: unknown;
    error?: { code: string };
  } | null;
  return { status: res.status, data: json?.data, code: json?.error?.code };
}

const tokenOf = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

async function newPlan(suffix: string, fields: Record<string, unknown> = {}) {
  const r = await http("POST", "/admin/plans", adminToken, {
    code: `t${TAG}${suffix}`,
    name: `Test ${suffix}`,
    priceMonthly: 99_900,
    ...fields,
  });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  planIds.push(r.data.id);
  return r.data as { id: string; code: string };
}

const assign = (
  hospitalId: string,
  planId: string,
  extra: Record<string, unknown> = { periodMonths: 1 },
) => http("PUT", `/admin/subscriptions/${hospitalId}`, adminToken, { planId, ...extra });

const view = (token: string) => http("GET", "/hospital/subscription", token);

beforeAll(async () => {
  world = await createWorld();
  other = await createWorld();
  makeSlot = slotFactory(world);
  patients = await createPatients(world, 4);
  hospitalAdmin = await createStaffUser(world, "HOSPITAL_ADMIN");
  otherAdmin = await createStaffUser(other, "HOSPITAL_ADMIN");
  reception = await createStaffUser(world, "RECEPTIONIST");
  const admin = await prisma.user.create({
    data: { role: "ADMIN", name: "Plan Admin", loginId: `plan-admin-${TAG}` },
  });
  adminId = admin.id;
  adminToken = signAccessToken({
    id: admin.id,
    role: "ADMIN",
    hospitalId: null,
    tokenVersion: 0,
  }).token;
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  for (const w of [world, other, ...extraWorlds]) {
    if (!w) continue;
    // Logins made through the API are not in the fixture's list.
    const users = await prisma.user.findMany({
      where: { hospitalId: w.hospitalId },
      select: { id: true },
    });
    w.userIds.push(...users.map((u) => u.id));
    await cleanup(w);
  }
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  if (adminId) {
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.delete({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

describe("plans", () => {
  it("are created, listed and changed by the platform admin only", async () => {
    const plan = await newPlan("basic", { maxDoctors: 3, description: "For small clinics" });
    expect(plan).toMatchObject({ maxDoctors: 3, maxStaff: null, analytics: true, isActive: true });

    expect(
      (await http("POST", "/admin/plans", adminToken, { code: plan.code, name: "Again" })).code,
    ).toBe("CODE_TAKEN");
    for (const bad of [
      { code: "Bad Code", name: "x" },
      { code: "ok-code", name: "" },
      { code: "ok-code", name: "Ok", maxDoctors: -1 },
    ]) {
      expect((await http("POST", "/admin/plans", adminToken, bad)).status).toBe(400);
    }
    expect(
      (await http("POST", "/admin/plans", hospitalAdmin.token, { code: "nope", name: "Nope" }))
        .status,
    ).toBe(403);
    expect((await http("GET", "/admin/plans", tokenOf(patients[0]!))).status).toBe(403);
    expect((await http("GET", "/admin/plans")).status).toBe(401);

    // A small edit changes only that field and never the code.
    const patched = await http("PATCH", `/admin/plans/${plan.id}`, adminToken, {
      name: "Basic plus",
      code: "hacked",
    });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({
      name: "Basic plus",
      code: plan.code,
      priceMonthly: 99_900,
      maxDoctors: 3,
    });
    const list = await http("GET", "/admin/plans", adminToken);
    expect(list.data.items.find((p: { id: string }) => p.id === plan.id)).toMatchObject({
      hospitals: 0,
    });
    expect(
      (await http("PATCH", `/admin/plans/${plan.id}`, hospitalAdmin.token, { name: "x" })).status,
    ).toBe(403);
    expect(
      (
        await http("PATCH", "/admin/plans/00000000-0000-7000-8000-000000000000", adminToken, {
          name: "xy",
        })
      ).status,
    ).toBe(404);
  });

  it("never switch off the plan new hospitals start on", async () => {
    const pilot = (await http("GET", "/admin/plans", adminToken)).data.items.find(
      (p: { code: string }) => p.code === env.DEFAULT_PLAN_CODE,
    );
    expect(pilot, "the migration creates the pilot plan").toBeTruthy();
    const r = await http("PATCH", `/admin/plans/${pilot.id}`, adminToken, { isActive: false });
    expect(r.code).toBe("DEFAULT_PLAN");
  });
});

describe("assigning a plan", () => {
  it("needs a trial or a paid period for a paid plan, and not both", async () => {
    const plan = await newPlan("assign");
    expect((await assign(world.hospitalId, plan.id, {})).code).toBe("PERIOD_REQUIRED");
    expect((await assign(world.hospitalId, plan.id, { trialDays: 14, periodMonths: 1 })).code).toBe(
      "TRIAL_OR_PERIOD",
    );
    expect((await assign(world.hospitalId, "00000000-0000-7000-8000-000000000000")).code).toBe(
      "PLAN_NOT_FOUND",
    );
    expect((await assign("00000000-0000-7000-8000-000000000000", plan.id)).status).toBe(404);
    expect(
      (
        await http("PUT", `/admin/subscriptions/${world.hospitalId}`, hospitalAdmin.token, {
          planId: plan.id,
          periodMonths: 1,
        })
      ).status,
    ).toBe(403);

    const trial = await assign(world.hospitalId, plan.id, {
      trialDays: 14,
      notes: "Demo given on 6 Oct",
    });
    expect(trial.status).toBe(200);
    expect(trial.data).toMatchObject({
      status: "TRIALING",
      state: "TRIALING",
      acceptingBookings: true,
      notes: "Demo given on 6 Oct",
    });
    expect(trial.data.daysLeft).toBeGreaterThanOrEqual(13);

    const paid = await assign(world.hospitalId, plan.id, { periodMonths: 3 });
    expect(paid.data).toMatchObject({ status: "ACTIVE", state: "ACTIVE" });
    expect(new Date(paid.data.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 80 * DAY);

    const inactive = await newPlan("off", { isActive: false });
    expect((await assign(world.hospitalId, inactive.id)).code).toBe("PLAN_NOT_FOUND");
  });

  it("is shown to the hospital admin, only for their own hospital", async () => {
    const mine = await view(hospitalAdmin.token);
    expect(mine.status).toBe(200);
    expect(mine.data.plan.code).toBe(`t${TAG}assign`);
    expect(mine.data.usage).toMatchObject({ doctors: 1, staff: 1, monthlyBookings: 0 });
    const theirs = await view(otherAdmin.token);
    expect(JSON.stringify(theirs.data)).not.toContain(`t${TAG}assign`);
    expect((await view(reception.token)).status).toBe(403);
    expect((await http("GET", "/hospital/subscription")).status).toBe(401);
    expect(
      (await http("GET", `/admin/subscriptions/${world.hospitalId}`, adminToken)).data.plan.code,
    ).toBe(`t${TAG}assign`);
    expect(
      (await http("GET", `/admin/subscriptions/${world.hospitalId}`, hospitalAdmin.token)).status,
    ).toBe(403);
  });
});

describe("limits of a plan", () => {
  it("stop one doctor too many, also when switching one back on", async () => {
    const plan = await newPlan("docs", { maxDoctors: 2 });
    await assign(world.hospitalId, plan.id);
    const make = (n: string) =>
      http("POST", "/hospital/doctors", hospitalAdmin.token, {
        departmentId: world.departmentId,
        name: `Dr ${n} ${TAG}`,
        consultationFee: 10_000,
      });

    const second = await make("Second");
    expect(second.status).toBe(201);
    const third = await make("Third");
    expect(third.status).toBe(409);
    expect(third.code).toBe("PLAN_LIMIT");
    expect((await view(hospitalAdmin.token)).data.usage.doctors).toBe(2);

    expect(
      (
        await http("PATCH", `/hospital/doctors/${world.doctorId}`, hospitalAdmin.token, {
          isActive: false,
        })
      ).status,
    ).toBe(200);
    expect((await make("Fourth")).status).toBe(201);
    const back = await http("PATCH", `/hospital/doctors/${world.doctorId}`, hospitalAdmin.token, {
      isActive: true,
    });
    expect(back.code).toBe("PLAN_LIMIT");
    // Editing something else on a doctor is never blocked by the limit.
    expect(
      (
        await http("PATCH", `/hospital/doctors/${second.data.id}`, hospitalAdmin.token, {
          bio: "Hello",
        })
      ).status,
    ).toBe(200);
  });

  it("stop one staff login too many, also when unblocking one", async () => {
    const plan = await newPlan("staff", { maxStaff: 2 });
    await assign(world.hospitalId, plan.id);
    const make = (name: string) =>
      http("POST", "/hospital/staff/receptionists", hospitalAdmin.token, { name });

    const one = await make("Rita Test");
    expect(one.status).toBe(201);
    expect((await make("Sita Test")).code).toBe("PLAN_LIMIT");

    expect(
      (await http("POST", `/hospital/staff/${one.data.user.id}/block`, hospitalAdmin.token)).status,
    ).toBe(200);
    const two = await make("Gita Test");
    expect(two.status).toBe(201);
    const unblock = await http(
      "POST",
      `/hospital/staff/${one.data.user.id}/unblock`,
      hospitalAdmin.token,
    );
    expect(unblock.code).toBe("PLAN_LIMIT");
  });

  it("do not apply to an unlimited plan", async () => {
    const plan = await newPlan("open", { maxDoctors: null, maxStaff: null });
    await assign(world.hospitalId, plan.id);
    for (const n of ["A", "B", "C"]) {
      expect(
        (
          await http("POST", "/hospital/doctors", hospitalAdmin.token, {
            departmentId: world.departmentId,
            name: `Dr Open${n} ${TAG}`,
            consultationFee: 0,
          })
        ).status,
      ).toBe(201);
    }
  });
});

describe("features of a plan", () => {
  it("switch analytics and slip printing off for a plan without them, and on again", async () => {
    const lean = await newPlan("lean", { analytics: false, slipPrinting: false });
    await assign(world.hospitalId, lean.id);

    const a = await http("GET", "/hospital/analytics", hospitalAdmin.token);
    expect(a.status).toBe(403);
    expect(a.code).toBe("PLAN_FEATURE");
    expect((await http("GET", "/hospital/slip-templates", hospitalAdmin.token)).code).toBe(
      "PLAN_FEATURE",
    );
    const slip = await http(
      "GET",
      "/desk/appointments/00000000-0000-7000-8000-000000000000/slip",
      reception.token,
    );
    expect(slip.code).toBe("PLAN_FEATURE");
    expect((await http("POST", "/desk/slips", reception.token, { date: "2026-10-07" })).code).toBe(
      "PLAN_FEATURE",
    );
    // The rest of the panel keeps working.
    expect((await http("GET", "/hospital/doctors", hospitalAdmin.token)).status).toBe(200);
    expect((await view(hospitalAdmin.token)).status).toBe(200);

    const full = await newPlan("full");
    await assign(world.hospitalId, full.id);
    expect((await http("GET", "/hospital/analytics", hospitalAdmin.token)).status).toBe(200);
    expect((await http("GET", "/hospital/slip-templates", hospitalAdmin.token)).status).toBe(200);
  });
});

describe("a hospital that is not taking online bookings", () => {
  async function lockAs(p: Patient, slotId: string) {
    return http("POST", "/appointments/lock", tokenOf(p), {
      slotId,
      patientProfileId: p.profileId,
    });
  }

  it("is told to patients, cannot be booked, and can be resumed", async () => {
    const plan = await newPlan("pause");
    await assign(world.hospitalId, plan.id);
    const [a, b] = patients as [Patient, Patient, Patient, Patient];
    await prisma.doctor.update({
      where: { id: world.doctorId },
      data: { isActive: true, name: `Dr Pause ${TAG}` },
    });
    const slot1 = await makeSlot({ dayOffset: 5, capacity: 2 });
    const slot2 = await makeSlot({ dayOffset: 5, capacity: 2 });
    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });

    // Open: a patient books, and the pages say bookings are open.
    const held = await lockAs(a, slot1.id);
    expect(held.status).toBeLessThan(300);
    expect((await http("GET", `/public/hospitals/${hospital.slug}`)).data.acceptingBookings).toBe(
      true,
    );
    expect(
      (await http("GET", `/public/doctors/${world.doctorId}/availability`)).data.dates.length,
    ).toBeGreaterThan(0);
    const confirmed = await lockSlot(
      patients[2]!.auth,
      { slotId: slot2.id, patientProfileId: patients[2]!.profileId },
      {},
    );
    await confirmAppointment(confirmed.id, { provider: "MOCK", method: "ONLINE" }, null);

    // Suspended: nobody can book, pages say so, search offers no seat.
    expect(
      (
        await http("POST", `/admin/subscriptions/${world.hospitalId}/suspend`, adminToken, {
          reason: "x",
        })
      ).status,
    ).toBe(400);
    const suspended = await http(
      "POST",
      `/admin/subscriptions/${world.hospitalId}/suspend`,
      adminToken,
      { reason: "Payment overdue" },
    );
    expect(suspended.data).toMatchObject({
      status: "SUSPENDED",
      state: "SUSPENDED",
      acceptingBookings: false,
      notice: "suspended",
    });
    expect(
      (
        await http("POST", `/admin/subscriptions/${world.hospitalId}/suspend`, adminToken, {
          reason: "Again please",
        })
      ).code,
    ).toBe("INVALID_STATUS");

    const refused = await lockAs(b, slot1.id);
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("BOOKINGS_PAUSED");
    expect((await http("GET", `/public/hospitals/${hospital.slug}`)).data.acceptingBookings).toBe(
      false,
    );
    expect(
      (await http("GET", `/public/hospitals?search=${hospital.name}`)).data.items[0]
        .acceptingBookings,
    ).toBe(false);
    const avail = await http("GET", `/public/doctors/${world.doctorId}/availability`);
    expect(avail.data).toMatchObject({ dates: [], fullDates: [], acceptingBookings: false });
    expect((await http("GET", `/public/doctors/${world.doctorId}`)).data.acceptingBookings).toBe(
      false,
    );
    const found = await http("GET", `/public/search/doctors?q=${TAG}`);
    const row = found.data.items.find((d: { id: string }) => d.id === world.doctorId);
    expect(row.hospital.acceptingBookings).toBe(false);
    expect(row.nextAvailable).toBeNull();
    expect(
      (
        await http("POST", "/waitlist", tokenOf(b), {
          doctorId: world.doctorId,
          date: "2099-01-01",
          patientProfileId: b.profileId,
        })
      ).code,
    ).toBe("BOOKINGS_PAUSED");

    // People who already booked are not affected: they can still cancel, and the desk keeps working.
    await cancelAppointment(patients[2]!.auth, confirmed.id, null, {});
    expect((await http("GET", "/desk/queue", reception.token)).status).toBeLessThan(500);
    // A payment cannot be recorded while it is suspended.
    const pay = await http(
      "POST",
      `/admin/subscriptions/${world.hospitalId}/payments`,
      adminToken,
      {
        amount: 99_900,
        method: "UPI",
        periodMonths: 1,
      },
    );
    expect(pay.code).toBe("INVALID_STATUS");

    // Resumed: bookings are open again.
    const resumed = await http(
      "POST",
      `/admin/subscriptions/${world.hospitalId}/resume`,
      adminToken,
    );
    expect(resumed.data).toMatchObject({ status: "ACTIVE", acceptingBookings: true });
    expect((await lockAs(b, slot1.id)).status).toBeLessThan(300);
    expect(
      (await http("POST", `/admin/subscriptions/${world.hospitalId}/resume`, adminToken)).code,
    ).toBe("INVALID_STATUS");
  });

  it("can be cancelled by the admin and brought back", async () => {
    const r = await http("POST", `/admin/subscriptions/${world.hospitalId}/cancel`, adminToken, {
      reason: "Left the platform",
    });
    expect(r.data).toMatchObject({
      status: "CANCELLED",
      acceptingBookings: false,
      notice: "cancelled",
    });
    expect(
      (
        await http("POST", `/admin/subscriptions/${world.hospitalId}/cancel`, adminToken, {
          reason: "Once more",
        })
      ).code,
    ).toBe("INVALID_STATUS");
    expect(
      (await http("POST", `/admin/subscriptions/${world.hospitalId}/resume`, adminToken)).data
        .acceptingBookings,
    ).toBe(true);
  });
});

describe("running out, and paying offline", () => {
  const setEnd = (hospitalId: string, end: Date) =>
    prisma.subscription.update({
      where: { hospitalId },
      data: { status: "ACTIVE", currentPeriodEnd: end, trialEndsAt: null },
    });

  it("has a grace period, then stops online bookings, until a payment is recorded", async () => {
    const plan = await newPlan("lapse");
    await assign(world.hospitalId, plan.id);
    const slot = await makeSlot({ dayOffset: 6, capacity: 5 });

    await setEnd(world.hospitalId, new Date(Date.now() + 3 * DAY));
    const soon = await view(hospitalAdmin.token);
    expect(soon.data).toMatchObject({ state: "ACTIVE", notice: "ending_soon", daysLeft: 3 });

    await setEnd(world.hospitalId, new Date(Date.now() - 2 * DAY));
    const grace = await view(hospitalAdmin.token);
    expect(grace.data).toMatchObject({ state: "GRACE", notice: "grace", acceptingBookings: true });
    expect(
      (
        await http("POST", "/appointments/lock", tokenOf(patients[3]!), {
          slotId: slot.id,
          patientProfileId: patients[3]!.profileId,
        })
      ).status,
    ).toBeLessThan(300);

    await setEnd(world.hospitalId, new Date(Date.now() - (env.SUBSCRIPTION_GRACE_DAYS + 2) * DAY));
    const lapsed = await view(hospitalAdmin.token);
    expect(lapsed.data).toMatchObject({
      state: "EXPIRED",
      notice: "expired",
      acceptingBookings: false,
    });
    const refused = await http("POST", "/appointments/lock", tokenOf(patients[0]!), {
      slotId: slot.id,
      patientProfileId: patients[0]!.profileId,
    });
    expect(refused.code).toBe("BOOKINGS_PAUSED");

    // The admin sees it in the list of hospitals to chase.
    const attention = await http(
      "GET",
      "/admin/subscriptions?filter=attention&limit=100",
      adminToken,
    );
    const mine = attention.data.items.find(
      (i: { hospitalId: string }) => i.hospitalId === world.hospitalId,
    );
    expect(mine).toMatchObject({ state: "EXPIRED", notice: "expired" });
    expect(
      attention.data.items.find((i: { hospitalId: string }) => i.hospitalId === other.hospitalId),
    ).toBeUndefined();
    expect(
      (await http("GET", "/admin/subscriptions?filter=all&limit=100", adminToken)).data.pagination
        .total,
    ).toBeGreaterThanOrEqual(attention.data.pagination.total);

    // A payment received offline brings it back from today.
    const pay = await http(
      "POST",
      `/admin/subscriptions/${world.hospitalId}/payments`,
      adminToken,
      {
        amount: 99_900,
        method: "BANK_TRANSFER",
        reference: "UTR123456",
        periodMonths: 2,
        note: "October and November",
      },
    );
    expect(pay.status).toBe(201);
    expect(pay.data.subscription).toMatchObject({
      status: "ACTIVE",
      state: "ACTIVE",
      acceptingBookings: true,
      notice: "none",
    });
    const end = new Date(pay.data.periodEnd).getTime();
    expect(end).toBeGreaterThan(Date.now() + 55 * DAY);
    expect(end).toBeLessThan(Date.now() + 63 * DAY);
    expect(pay.data.subscription.payments[0]).toMatchObject({
      amount: 99_900,
      method: "BANK_TRANSFER",
      reference: "UTR123456",
      recordedBy: "Plan Admin",
    });
    expect((await view(hospitalAdmin.token)).data.payments).toHaveLength(1);
    expect(
      (
        await http("POST", "/appointments/lock", tokenOf(patients[0]!), {
          slotId: slot.id,
          patientProfileId: patients[0]!.profileId,
        })
      ).status,
    ).toBeLessThan(300);
  });

  it("continues from the end of the paid period when paying early, and rejects bad payments", async () => {
    const before = new Date((await view(hospitalAdmin.token)).data.currentPeriodEnd).getTime();
    const pay = await http(
      "POST",
      `/admin/subscriptions/${world.hospitalId}/payments`,
      adminToken,
      {
        amount: 49_950,
        method: "CASH",
        periodMonths: 1,
      },
    );
    const after = new Date(pay.data.periodEnd).getTime();
    expect(after - before).toBeGreaterThan(27 * DAY);
    expect(after - before).toBeLessThan(32 * DAY);

    const bad = (body: Record<string, unknown>) =>
      http("POST", `/admin/subscriptions/${world.hospitalId}/payments`, adminToken, body);
    expect((await bad({ amount: 0, method: "UPI", periodMonths: 1 })).status).toBe(400);
    expect((await bad({ amount: 100, method: "BITCOIN", periodMonths: 1 })).status).toBe(400);
    expect((await bad({ amount: 100, method: "UPI", periodMonths: 0 })).status).toBe(400);
    expect((await bad({ amount: 100, method: "UPI", periodMonths: 99 })).status).toBe(400);
    expect(
      (
        await bad({
          amount: 100,
          method: "UPI",
          periodMonths: 1,
          paidAt: new Date(Date.now() + 10 * DAY).toISOString(),
        })
      ).code,
    ).toBe("FUTURE_PAYMENT");
    expect(
      (
        await http(
          "POST",
          `/admin/subscriptions/${world.hospitalId}/payments`,
          hospitalAdmin.token,
          { amount: 100, method: "UPI", periodMonths: 1 },
        )
      ).status,
    ).toBe(403);
    expect((await view(hospitalAdmin.token)).data.payments).toHaveLength(2);
  });

  it("is written to the audit log", async () => {
    const actions = await prisma.auditLog.findMany({
      where: { hospitalId: world.hospitalId, entityType: "Subscription" },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "subscription.assigned",
        "subscription.payment_recorded",
        "subscription.suspended",
        "subscription.resumed",
      ]),
    );
  });
});

describe("the monthly booking limit", () => {
  it("stops new online bookings once the month is full, but not a repeated tap on an existing hold", async () => {
    const w = await createWorld();
    extraWorlds.push(w);
    const slots = slotFactory(w);
    const [p1, p2, p3] = await createPatients(w, 3);
    const plan = await newPlan("month", { maxMonthlyBookings: 2 });
    await assign(w.hospitalId, plan.id);
    const slot = await slots({ dayOffset: 4, capacity: 5 });
    const lock = (p: Patient) =>
      http("POST", "/appointments/lock", tokenOf(p), {
        slotId: slot.id,
        patientProfileId: p.profileId,
      });

    const first = await lock(p1!);
    expect(first.status).toBeLessThan(300);
    expect((await lock(p2!)).status).toBeLessThan(300);
    const third = await lock(p3!);
    expect(third.status).toBe(409);
    expect(third.code).toBe("BOOKINGS_PAUSED");
    // Tapping again on a hold that already exists is not a new booking.
    const again = await lock(p1!);
    expect(again.status).toBeLessThan(300);
    expect(again.data.id).toBe(first.data.id);

    const admin = await createStaffUser(w, "HOSPITAL_ADMIN");
    expect((await view(admin.token)).data.usage.monthlyBookings).toBe(2);

    // Cancelling frees a place in the month.
    await cancelAppointment(p1!.auth, first.data.id, null, {});
    expect((await lock(p3!)).status).toBeLessThan(300);
  });
});

describe("new hospitals", () => {
  it("start on the default plan", async () => {
    const created = await http("POST", "/admin/hospitals", adminToken, {
      name: `Plan Test Hospital ${TAG}`,
      city: "Jaipur",
      approve: true,
    });
    expect(created.status).toBe(201);
    const id = created.data.hospital.id as string;
    extraWorlds.push({
      hospitalId: id,
      departmentId: "",
      doctorId: "",
      userIds: [],
      doctorIds: [],
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { hospitalId: id },
      include: { plan: true },
    });
    expect(sub.plan.code).toBe(env.DEFAULT_PLAN_CODE);
    expect(sub).toMatchObject({ status: "ACTIVE", currentPeriodEnd: null });
    expect((await http("GET", `/admin/subscriptions/${id}`, adminToken)).data.plan.code).toBe(
      env.DEFAULT_PLAN_CODE,
    );
  });

  it("without any subscription row are unrestricted, so a missing row never locks anyone out", async () => {
    const w = await createWorld();
    extraWorlds.push(w);
    await prisma.subscription.deleteMany({ where: { hospitalId: w.hospitalId } });
    const admin = await createStaffUser(w, "HOSPITAL_ADMIN");
    const v = await view(admin.token);
    expect(v.data).toMatchObject({ plan: null, state: null, acceptingBookings: true });
    expect((await http("GET", "/hospital/analytics", admin.token)).status).toBe(200);
  });
});
