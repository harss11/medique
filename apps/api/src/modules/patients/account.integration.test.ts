/**
 * A patient's data rights: a copy of their data, and erasure. On a real PostgreSQL.
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { confirmAppointment, lockSlot } from "../appointments/booking.service.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  TZ,
  cleanup,
  createPatients,
  createStaffUser,
  createWorld,
  slotFactory,
  type Patient,
  type Staff,
  type World,
} from "../../../test/fixtures.js";

let server: Server;
let base: string;
let world: World;
let reception: Staff;
let p1: Patient;
let p2: Patient;
let t1: string;
let t2: string;
let makeSlot: ReturnType<typeof slotFactory>;
const extraUsers: string[] = [];

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

const tokenOf = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: the shape depends on the endpoint
    error?: { code: string; message: string; details?: any };
  } | null;
  return {
    status: res.status,
    data: json?.data,
    code: json?.error?.code,
    message: json?.error?.message,
    details: json?.error?.details,
  };
}

async function book(p: Patient, minutes: number) {
  const slot = await makeSlot({ startAt: minutesFromNow(minutes) });
  const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, {});
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  return hold.id;
}

beforeAll(async () => {
  world = await createWorld({ fee: 50_000 });
  makeSlot = slotFactory(world);
  reception = await createStaffUser(world, "RECEPTIONIST");
  [p1, p2] = (await createPatients(world, 2)) as [Patient, Patient];
  t1 = tokenOf(p1);
  t2 = tokenOf(p2);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1";
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (extraUsers.length) await prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe.skipIf(nearMidnight())("a copy of my data", () => {
  it("contains my own account, profiles, appointments and payments, and nobody else's", async () => {
    await prisma.patientProfile.update({
      where: { id: p1.profileId },
      data: {
        fullName: "Sunita Devi",
        gender: "FEMALE",
        dateOfBirth: new Date("1980-03-15T00:00:00Z"),
      },
    });
    const id1 = await book(p1, 40);
    await prisma.appointment.update({
      where: { id: id1 },
      data: { reasonForVisit: "Fever for three days" },
    });
    await book(p2, 70);
    const visit = await prisma.appointment.findUniqueOrThrow({ where: { id: id1 } });
    await prisma.review.create({
      data: {
        appointmentId: id1,
        hospitalId: visit.hospitalId,
        doctorId: visit.doctorId,
        userId: p1.userId,
        rating: 4,
        comment: "Kind and quick",
      },
    });

    const mine = await api("GET", "/patient/account/export", t1);
    expect(mine.status).toBe(200);
    expect(mine.data.account.name).toBeTruthy();
    expect(mine.data.profiles[0]).toMatchObject({
      fullName: "Sunita Devi",
      gender: "FEMALE",
      dateOfBirth: "1980-03-15",
    });
    expect(mine.data.reviews).toEqual([
      expect.objectContaining({ rating: 4, comment: "Kind and quick", isPublished: true }),
    ]);
    expect(mine.data.consents).toEqual([]); // fixtures sign nobody up; real accounts list their acceptances
    expect(mine.data.appointments).toHaveLength(1);
    expect(mine.data.appointments[0]).toMatchObject({
      reasonForVisit: "Fever for three days",
      status: "CONFIRMED",
      fee: 50_000,
      payments: [expect.objectContaining({ amount: 50_000, status: "CAPTURED" })],
    });
    const text = JSON.stringify(mine.data);
    expect(text).not.toContain(p2.userId);
    expect(text).not.toMatch(/passwordHash|commission|checkInCode|tokenVersion/);

    const theirs = await api("GET", "/patient/account/export", t2);
    expect(theirs.data.appointments).toHaveLength(1);
    expect(JSON.stringify(theirs.data)).not.toContain("Sunita");
  });
});

describe.skipIf(nearMidnight())("erasing my account", () => {
  it("asks for the typed confirmation", async () => {
    expect((await api("POST", "/patient/account/erase", t1, {})).status).toBe(400);
    expect((await api("POST", "/patient/account/erase", t1, { confirm: "yes" })).status).toBe(400);
  });

  it("is refused while an appointment is upcoming, and while a refund is still on its way", async () => {
    const blocked = await api("POST", "/patient/account/erase", t1, { confirm: "ERASE" });
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("ERASE_BLOCKED");
    expect(blocked.message).toMatch(/upcoming appointment/);

    // Once the visit is cancelled, only a refund still in flight stands in the way.
    const appt = await prisma.appointment.findFirstOrThrow({ where: { bookedById: p1.userId } });
    await api("POST", "/desk/appointments/" + appt.id + "/cancel", reception.token, {
      initiator: "HOSPITAL",
    });
    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: appt.id } });
    const pending = await prisma.refund.create({
      data: { paymentId: payment.id, amount: 1_000, status: "PENDING" },
    });
    try {
      const refundBlock = await api("POST", "/patient/account/erase", t1, { confirm: "ERASE" });
      expect(refundBlock.status).toBe(409);
      expect(refundBlock.message).toMatch(/refund is still on its way/);
    } finally {
      await prisma.refund.delete({ where: { id: pending.id } });
    }
    // Nothing was changed by the refusals.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: p1.userId } })).phone).toBeTruthy();
  });

  it("anonymises the person, keeps the records the hospital needs, and ends every session", async () => {
    const phone = (await prisma.user.findUniqueOrThrow({ where: { id: p1.userId } })).phone!;
    const appt = await prisma.appointment.findFirstOrThrow({ where: { bookedById: p1.userId } });
    expect(
      await prisma.notificationLog.count({ where: { appointmentId: appt.id } }),
    ).toBeGreaterThan(0);

    const res = await api("POST", "/patient/account/erase", t1, { confirm: "ERASE" });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ erased: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: p1.userId } });
    expect(user).toMatchObject({
      name: "Erased patient",
      phone: null,
      email: null,
      status: "BLOCKED",
    });
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { id: p1.profileId } });
    expect(profile).toMatchObject({
      fullName: "Erased patient",
      dateOfBirth: null,
      gender: null,
      phone: null,
    });
    expect(profile.deletedAt).not.toBeNull();

    // The visit and its money stay; the person's words and details do not.
    const kept = await prisma.appointment.findUniqueOrThrow({
      where: { id: appt.id },
      include: { payments: true },
    });
    expect(kept).toMatchObject({ status: "CANCELLED", feeAmount: 50_000, reasonForVisit: null });
    expect(kept.payments).toHaveLength(1);
    const messages = await prisma.notificationLog.findMany({ where: { appointmentId: appt.id } });
    expect(messages.every((m) => m.to === "[erased]" && m.templateVars === null)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(phone);
    expect(await prisma.refreshToken.count({ where: { userId: p1.userId } })).toBe(0);
    expect(await prisma.review.count({ where: { userId: p1.userId } })).toBe(0);

    // Every token already issued stops working at once.
    const again = await api("GET", "/patient/account/export", t1);
    expect(again.status).toBe(401);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "patient.erased", entityId: p1.userId },
    });
    expect(JSON.stringify(audit)).not.toContain(phone);

    // The phone number is free again: the same person can sign up afresh, with a clean slate.
    const fresh = await prisma.user.create({
      data: { role: "PATIENT", name: "New account", phone },
    });
    extraUsers.push(fresh.id);
    expect(fresh.id).not.toBe(p1.userId);
  });

  it("leaves other patients untouched", async () => {
    const other = await prisma.user.findUniqueOrThrow({ where: { id: p2.userId } });
    expect(other.status).toBe("ACTIVE");
    expect(other.phone).toBeTruthy();
    expect((await api("GET", "/patient/account/export", t2)).status).toBe(200);
  });

  it("cannot be done by staff, or without signing in", async () => {
    expect(
      (await api("POST", "/patient/account/erase", reception.token, { confirm: "ERASE" })).status,
    ).toBe(403);
    expect((await api("GET", "/patient/account/export", reception.token)).status).toBe(403);
    expect(
      (await api("POST", "/patient/account/erase", undefined, { confirm: "ERASE" })).status,
    ).toBe(401);
  });
});

describe.skipIf(nearMidnight())("erasing while a booking is being made", () => {
  it("never leaves a held slot behind: one of the two wins cleanly", async () => {
    const [p3] = await createPatients(world, 1);
    const t3 = tokenOf(p3!);
    const slot = await makeSlot({ startAt: minutesFromNow(90) });

    const [booked, erased] = await Promise.allSettled([
      lockSlot(p3!.auth, { slotId: slot.id, patientProfileId: p3!.profileId }, {}),
      api("POST", "/patient/account/erase", t3, { confirm: "ERASE" }),
    ]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: p3!.userId } });
    const holds = await prisma.appointment.count({
      where: { bookedById: p3!.userId, status: "PENDING_PAYMENT" },
    });
    const erasedOk = erased.status === "fulfilled" && erased.value.status === 200;
    if (erasedOk) {
      // Erased first: the booking must have been refused, and nothing is left holding a seat.
      expect(user.phone).toBeNull();
      expect(booked.status).toBe("rejected");
      expect(holds).toBe(0);
    } else {
      // Booked first: erasure was refused because of the hold, and the account is intact.
      expect(erased.status === "fulfilled" && erased.value.code).toBe("ERASE_BLOCKED");
      expect(booked.status).toBe("fulfilled");
      expect(holds).toBe(1);
      expect(user.phone).toBeTruthy();
    }
  });
});
