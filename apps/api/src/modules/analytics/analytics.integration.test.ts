/**
 * Admin statistics and hospital analytics, against a small known day:
 *   A  online, paid 500.00, still booked      (commission 10% = 50.00)
 *   B  online, paid 500.00, then cancelled by the hospital and refunded in full
 *   C  walk-in, cash 500.00, seen (waited 10 min, consultation 12 min)
 *   D  walk-in, unpaid, did not come
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { confirmAppointment, lockSlot } from "../appointments/booking.service.js";
import { signAccessToken } from "../auth/tokens.js";
import { commissionKept } from "./analytics-rules.js";
import {
  TZ,
  cleanup,
  createDoctor,
  createPatients,
  createStaffUser,
  createWorld,
  slotFactory,
  type Staff,
  type World,
} from "../../../test/fixtures.js";

let server: Server;
let base: string;
let world: World;
let other: World;
let admin: string;
let hospitalAdmin: Staff;
let reception: Staff;
let otherAdmin: Staff;
let ids: { a: string; b: string; c: string; d: string };
let doctorId: string;

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

function nearMidnight(): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const minutes =
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value);
  return minutes > 24 * 60 - 50 || minutes < 5;
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: the shape depends on the endpoint
    data?: any;
    error?: { code: string };
  } | null;
  return { status: res.status, data: json?.data, code: json?.error?.code };
}
const stats = (qs = "") => api("GET", "/admin/stats?hospitalId=" + world.hospitalId + qs, admin);
const analytics = (qs = "") =>
  api("GET", "/hospital/analytics" + (qs ? "?" + qs : ""), hospitalAdmin.token);

async function online(doctor: string, minutes: number, profileIndex: number) {
  const slot = await slotFactory(world)({ doctorId: doctor, startAt: minutesFromNow(minutes) });
  const [patient] = await createPatients(world, 1);
  const hold = await lockSlot(
    patient!.auth,
    { slotId: slot.id, patientProfileId: patient!.profileId },
    {},
  );
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  void profileIndex;
  return hold.id;
}

beforeAll(async () => {
  world = await createWorld({ fee: 50_000 });
  other = await createWorld();
  await prisma.hospital.update({
    where: { id: world.hospitalId },
    data: { commissionPercent: 10 },
  });
  doctorId = await createDoctor(world, 50_000);
  hospitalAdmin = await createStaffUser(world, "HOSPITAL_ADMIN");
  reception = await createStaffUser(world, "RECEPTIONIST");
  otherAdmin = await createStaffUser(other, "HOSPITAL_ADMIN");
  const a = await prisma.user.create({
    data: { role: "ADMIN", name: "Stats Admin", loginId: "stats-admin-" + Date.now() },
  });
  world.userIds.push(a.id);
  admin = signAccessToken({ id: a.id, role: "ADMIN", hospitalId: null, tokenVersion: 0 }).token;
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1";
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (world) await cleanup(world);
  if (other) await cleanup(other);
  await prisma.$disconnect();
});

// Today's date is used throughout, so a run that straddles midnight would be meaningless.
describe.skipIf(nearMidnight())("statistics for a known day", () => {
  beforeAll(async () => {
    const a = await online(doctorId, 40, 0);
    const b = await online(doctorId, 70, 1);
    await api("POST", "/desk/appointments/" + b + "/cancel", reception.token, {
      initiator: "HOSPITAL",
    });

    const walkSlot = await slotFactory(world)({
      doctorId,
      startAt: minutesFromNow(-1),
      durationMin: 60,
      capacity: 4,
    });
    const walk = async (name: string, payment: "CASH" | "PAY_LATER") =>
      (
        await api("POST", "/desk/appointments", reception.token, {
          slotId: walkSlot.id,
          patient: { fullName: name },
          payment,
          checkIn: true,
        })
      ).data.id as string;
    const c = await walk("Cash Patient", "CASH");
    const d = await walk("Absent Patient", "PAY_LATER");
    await api("POST", "/desk/appointments/" + d + "/no-show", reception.token);

    // Patient C was checked in at 09:00, seen from 09:10 to 09:22.
    const day = new Date();
    const at = (h: number, m: number) =>
      new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
    await prisma.appointment.update({
      where: { id: c },
      data: {
        status: "COMPLETED",
        checkedInAt: at(9, 0),
        startedAt: at(9, 10),
        completedAt: at(9, 22),
      },
    });
    ids = { a, b, c, d };
  });

  it("counts bookings by status and source, with the cancellation and no-show rates", async () => {
    const res = await stats();
    expect(res.status).toBe(200);
    expect(res.data.bookings).toMatchObject({
      total: 4,
      active: 1,
      completed: 1,
      cancelled: 1,
      noShow: 1,
      online: 2,
      walkIn: 2,
      cancellationRate: 25,
      noShowRate: 50,
    });
  });

  it("reports the day: three real bookings and one cancelled, with the online money on its day", async () => {
    const res = await stats();
    const today = res.data.range.to;
    const row = res.data.daily.find((d: { date: string }) => d.date === today);
    expect(row).toMatchObject({
      booked: 3,
      cancelled: 1,
      completed: 1,
      noShow: 1,
      onlineGross: 100_000,
    });
    expect(res.data.daily).toHaveLength(30);
    expect(res.data.daily.filter((d: { booked: number }) => d.booked === 0)).toHaveLength(29);
  });

  it("separates online money, cash and commission after the hospital's refund went through", async () => {
    // The mock gateway pays refunds out at once, so B's refund is already complete.
    const res = await stats();
    const inr = res.data.money.find((m: { currency: string }) => m.currency === "INR");
    expect(inr).toEqual({
      currency: "INR",
      onlineGross: 100_000,
      onlineRefunded: 50_000,
      onlineNet: 50_000,
      commission: 5_000, // only A's: B's commission is not kept once B is refunded in full
      hospitalShare: 45_000,
      cashCollected: 50_000, // patient C paid at the desk: no commission
      cashRefunded: 0,
      cashNet: 50_000,
    });
    expect(res.data.refundsOutstanding).toEqual([]);
  });

  it("computes commission the way the reference rule says (kept share of each payment)", async () => {
    const payments = await prisma.payment.findMany({
      where: { hospitalId: world.hospitalId, provider: { not: "CASH" } },
    });
    const expected = payments.reduce(
      (t, p) => t + commissionKept(p.commissionAmount ?? 0, p.amount, p.refundedAmount),
      0,
    );
    const res = await stats();
    expect(res.data.money.find((m: { currency: string }) => m.currency === "INR").commission).toBe(
      expected,
    );
    expect(expected).toBe(5_000);
  });

  it("lists refunds still owed to patients, so nothing waits unnoticed", async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: ids.a } });
    const made = await Promise.all([
      prisma.refund.create({ data: { paymentId: payment.id, amount: 25_000, status: "PENDING" } }),
      prisma.refund.create({
        data: { paymentId: payment.id, amount: 10_000, status: "FAILED", error: "gateway down" },
      }),
    ]);
    try {
      const res = await stats();
      expect(res.data.refundsOutstanding).toEqual(
        expect.arrayContaining([
          { currency: "INR", status: "PENDING", count: 1, amount: 25_000 },
          { currency: "INR", status: "FAILED", count: 1, amount: 10_000 },
        ]),
      );
      const own = await analytics();
      expect(own.data.refundsOutstanding).toHaveLength(2);
      // Another hospital does not see them.
      const theirs = await api("GET", "/hospital/analytics", otherAdmin.token);
      expect(theirs.data.refundsOutstanding).toEqual([]);
    } finally {
      await prisma.refund.deleteMany({ where: { id: { in: made.map((r) => r.id) } } });
    }
  });

  it("ranks hospitals and shows platform totals when no hospital is chosen", async () => {
    const res = await api("GET", "/admin/stats", admin);
    expect(res.data.topHospitals.map((h: { id: string }) => h.id)).toContain(world.hospitalId);
    const mine = res.data.topHospitals.find((h: { id: string }) => h.id === world.hospitalId);
    expect(mine).toMatchObject({ bookings: 3, onlineGross: 100_000, commission: 5_000 });
    expect(res.data.totals.hospitals.active).toBeGreaterThanOrEqual(2);
  });

  it("gives a hospital its own view: doctors, departments, busy hours and service times", async () => {
    const res = await analytics();
    expect(res.status).toBe(200);
    expect(res.data.currency).toBe("INR");
    expect(res.data.bookings).toMatchObject({ total: 4, onlineShare: 50 });
    expect(res.data.money).toMatchObject({
      onlineGross: 100_000,
      onlineRefunded: 50_000,
      commission: 5_000,
      hospitalShare: 45_000,
      cashCollected: 50_000,
    });
    expect(res.data.service).toEqual({ avgWaitMinutes: 10, avgConsultMinutes: 12 });

    const doc = res.data.byDoctor.find((d: { id: string }) => d.id === doctorId);
    expect(doc).toMatchObject({ booked: 3, completed: 1, noShow: 1, cancelled: 1, noShowRate: 50 });
    expect(doc.revenueKept).toBe(50_000 + 50_000); // A online + C cash; B was refunded
    expect(res.data.byDepartment[0].booked).toBeGreaterThanOrEqual(3);
    expect(res.data.byHour).toHaveLength(24);
    expect(res.data.byHour.reduce((t: number, h: { count: number }) => t + h.count, 0)).toBe(3);
  });

  it("can be narrowed to one doctor, and refuses another hospital's doctor", async () => {
    const mine = await analytics("doctorId=" + doctorId);
    expect(mine.data.bookings.total).toBe(4);
    const nobody = await analytics("doctorId=" + world.doctorId);
    expect(nobody.data.bookings.total).toBe(0);
    const foreign = await api("GET", "/hospital/analytics?doctorId=" + doctorId, otherAdmin.token);
    expect(foreign.status).toBe(404);
  });

  it("never shows one hospital's numbers to another", async () => {
    const res = await api("GET", "/hospital/analytics", otherAdmin.token);
    expect(res.status).toBe(200);
    expect(res.data.bookings.total).toBe(0);
    expect(res.data.money.onlineGross).toBe(0);
    expect(res.data.byDoctor.every((d: { id: string }) => d.id !== doctorId)).toBe(true);
  });

  it("checks its inputs", async () => {
    expect((await stats("&from=2026-10-10&to=2026-10-01")).code).toBe("INVALID_RANGE");
    expect((await stats("&from=2020-01-01&to=2026-10-01")).code).toBe("INVALID_RANGE");
    expect((await stats("&from=banana")).status).toBe(400);
    expect((await stats("&timezone=Mars/Base")).code).toBe("INVALID_TIMEZONE");
    expect(
      (await api("GET", "/admin/stats?hospitalId=00000000-0000-7000-8000-000000000000", admin))
        .status,
    ).toBe(404);
    expect((await analytics("from=2026-10-10&to=2026-10-01")).code).toBe("INVALID_RANGE");
  });

  it("is limited to the right roles", async () => {
    expect((await api("GET", "/admin/stats", hospitalAdmin.token)).status).toBe(403);
    expect((await api("GET", "/hospital/analytics", admin)).status).toBe(403);
    expect((await api("GET", "/hospital/analytics", reception.token)).status).toBe(403);
    expect((await api("GET", "/admin/stats")).status).toBe(401);
  });
});
