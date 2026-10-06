/**
 * The patient booking flow through the real HTTP API: public browsing, profiles,
 * lock -> pay -> cancel / reschedule, plus authentication, ownership and
 * validation. Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cleanup,
  createPatients,
  createWorld,
  slotFactory,
  type Patient,
  type World,
} from "../../../test/fixtures.js";

let server: Server;
let base: string;
let world: World;
let makeSlot: ReturnType<typeof slotFactory>;
let alice: Patient;
let bob: Patient;
let aliceToken: string;
let bobToken: string;
let pendingHospitalId: string;

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text };
}

const tokenFor = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

beforeAll(async () => {
  world = await createWorld();
  makeSlot = slotFactory(world);
  [alice, bob] = (await createPatients(world, 2)) as [Patient, Patient];
  aliceToken = tokenFor(alice);
  bobToken = tokenFor(bob);
  const pending = await prisma.hospital.create({
    data: {
      name: "Pending Hospital",
      slug: `pending-${world.hospitalId.slice(0, 8)}`,
      status: "PENDING_APPROVAL",
    },
  });
  pendingHospitalId = pending.id;
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  if (pendingHospitalId) await prisma.hospital.delete({ where: { id: pendingHospitalId } });
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("public browsing (no login)", () => {
  it("lists active hospitals only, with search", async () => {
    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });
    const found = await http(
      "GET",
      `/public/hospitals?search=${encodeURIComponent(hospital.name)}`,
    );
    expect(found.status).toBe(200);
    expect(found.body.data.items.map((h: { slug: string }) => h.slug)).toEqual([hospital.slug]);
    expect(found.body.data.items[0].doctorCount).toBe(1);

    const pending = await prisma.hospital.findUniqueOrThrow({ where: { id: pendingHospitalId } });
    expect((await http("GET", `/public/hospitals?search=Pending`)).body.data.items).toHaveLength(0);
    expect((await http("GET", `/public/hospitals/${pending.slug}`)).status).toBe(404);
  });

  it("hospital page lists departments with doctors; doctors list is filterable", async () => {
    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });
    const page = await http("GET", `/public/hospitals/${hospital.slug}`);
    expect(page.status).toBe(200);
    expect(page.body.data.departments).toEqual([
      expect.objectContaining({ id: world.departmentId, doctorCount: 1 }),
    ]);
    const doctors = await http(
      "GET",
      `/public/hospitals/${hospital.slug}/doctors?departmentId=${world.departmentId}`,
    );
    expect(doctors.body.data.items).toHaveLength(1);
    expect(
      (await http("GET", `/public/hospitals/${hospital.slug}/doctors?limit=1000`)).status,
    ).toBe(400);
  });

  it("never exposes internal fields", async () => {
    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });
    const doctor = await http("GET", `/public/doctors/${world.doctorId}`);
    expect(doctor.status).toBe(200);
    for (const secret of [
      "qrToken",
      "registrationNumber",
      "commissionPercent",
      "passwordHash",
      "razorpayAccountId",
    ]) {
      expect(doctor.text).not.toContain(secret);
    }
    expect((await http("GET", `/public/hospitals/${hospital.slug}`)).text).not.toContain(
      "commissionPercent",
    );
  });

  it("shows days with free slots and the slots of a day", async () => {
    const slot = await makeSlot({ dayOffset: 3 });
    const date = slot.date.toISOString().slice(0, 10);
    const avail = await http("GET", `/public/doctors/${world.doctorId}/availability`);
    expect(avail.status).toBe(200);
    expect(avail.body.data.dates).toContainEqual({ date, openSlots: 1 });

    const slots = await http("GET", `/public/doctors/${world.doctorId}/slots?date=${date}`);
    expect(slots.body.data.items).toEqual([
      expect.objectContaining({ id: slot.id, available: true, remaining: 1 }),
    ]);
    expect((await http("GET", `/public/doctors/${world.doctorId}/slots?date=nope`)).status).toBe(
      400,
    );

    const one = await http("GET", `/public/slots/${slot.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.slot).toMatchObject({ id: slot.id, date, available: true });
    expect(one.body.data.doctor.hospital.slug).toBeTruthy();
    expect(one.text).not.toContain("qrToken");
    // Not a slot id at all: same answer as an unavailable slot, no information leaked.
    const missing = await http("GET", `/public/slots/${world.hospitalId}`);
    expect(missing.body.error.code).toBe("SLOT_UNAVAILABLE");
  });

  it("a full slot stays listed but unavailable; an inactive doctor disappears", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const date = slot.date.toISOString().slice(0, 10);
    const hold = await http("POST", "/appointments/lock", {
      token: aliceToken,
      body: { slotId: slot.id, patientProfileId: alice.profileId },
    });
    expect(hold.status).toBe(201);
    const slots = await http("GET", `/public/doctors/${world.doctorId}/slots?date=${date}`);
    expect(slots.body.data.items[0]).toMatchObject({ available: false, remaining: 0 });
    await http("POST", `/appointments/${hold.body.data.id}/cancel`, {
      token: aliceToken,
      body: {},
    });

    await prisma.doctor.update({ where: { id: world.doctorId }, data: { isActive: false } });
    expect((await http("GET", `/public/doctors/${world.doctorId}`)).status).toBe(404);
    await prisma.doctor.update({ where: { id: world.doctorId }, data: { isActive: true } });
  });
});

describe("family profiles", () => {
  it("lists the patient's own profile first, adds and removes family", async () => {
    const created = await http("POST", "/patient/profiles", {
      token: aliceToken,
      body: {
        fullName: "Aarav Sharma",
        relation: "CHILD",
        dateOfBirth: "2018-04-12",
        gender: "MALE",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ relation: "CHILD", dateOfBirth: "2018-04-12" });

    const list = await http("GET", "/patient/profiles", { token: aliceToken });
    expect(list.body.data.items.map((p: { relation: string }) => p.relation)).toEqual([
      "SELF",
      "CHILD",
    ]);

    const self = list.body.data.items[0];
    expect(
      (await http("DELETE", `/patient/profiles/${self.id}`, { token: aliceToken })).body.error.code,
    ).toBe("SELF_PROFILE");
    expect(
      (await http("DELETE", `/patient/profiles/${created.body.data.id}`, { token: aliceToken }))
        .status,
    ).toBe(200);
    expect(
      (await http("GET", "/patient/profiles", { token: aliceToken })).body.data.items,
    ).toHaveLength(1);
  });

  it("validates input and keeps profiles private", async () => {
    const bad = await http("POST", "/patient/profiles", {
      token: aliceToken,
      body: { fullName: "X", relation: "CHILD", dateOfBirth: "2999-01-01", phone: "123" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      (
        await http("POST", "/patient/profiles", {
          token: aliceToken,
          body: { fullName: "Self", relation: "SELF" },
        })
      ).status,
    ).toBe(400);

    const bobSelf = (await http("GET", "/patient/profiles", { token: bobToken })).body.data
      .items[0];
    expect(
      (
        await http("PATCH", `/patient/profiles/${bobSelf.id}`, {
          token: aliceToken,
          body: { fullName: "Hacked" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("booking through the API", () => {
  it("rejects anonymous and malformed requests", async () => {
    expect((await http("POST", "/appointments/lock", { body: {} })).status).toBe(401);
    expect((await http("GET", "/appointments")).status).toBe(401);
    const bad = await http("POST", "/appointments/lock", {
      token: aliceToken,
      body: { slotId: "nope", patientProfileId: "nope" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("lock -> pay -> ticket -> reschedule -> cancel, with ownership enforced throughout", async () => {
    const s1 = await makeSlot({ dayOffset: 6 });
    const s2 = await makeSlot({ dayOffset: 7 });

    // 1. Lock
    const hold = await http("POST", "/appointments/lock", {
      token: aliceToken,
      body: { slotId: s1.id, patientProfileId: alice.profileId, reasonForVisit: "Fever" },
    });
    expect(hold.status).toBe(201);
    const id = hold.body.data.id as string;
    expect(hold.body.data).toMatchObject({
      status: "PENDING_PAYMENT",
      tokenNumber: null,
      checkInCode: null, // no ticket until paid
      feeAmount: 50_000,
      canCancel: true,
    });
    expect(hold.body.data.holdExpiresAt).toBeTruthy();

    // 2. Someone else can't take it, see it, pay it or cancel it
    const rival = await http("POST", "/appointments/lock", {
      token: bobToken,
      body: { slotId: s1.id, patientProfileId: bob.profileId },
    });
    expect(rival.status).toBe(409);
    expect(rival.body.error.code).toBe("SLOT_FULL");
    expect((await http("GET", `/appointments/${id}`, { token: bobToken })).status).toBe(404);
    expect((await http("POST", `/appointments/${id}/mock-pay`, { token: bobToken })).status).toBe(
      404,
    );
    expect(
      (await http("POST", `/appointments/${id}/cancel`, { token: bobToken, body: {} })).status,
    ).toBe(404);

    // 3. Pay (mock): token and ticket appear
    const paid = await http("POST", `/appointments/${id}/mock-pay`, { token: aliceToken });
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe("CONFIRMED");
    expect(paid.body.data.tokenNumber).toBeGreaterThanOrEqual(1);
    expect(paid.body.data.checkInCode).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);
    expect(paid.body.data.payment).toMatchObject({ status: "CAPTURED", amount: 50_000 });
    expect(paid.body.data.hospital.timezone).toBe("Asia/Kolkata");
    expect(paid.body.data.patient.fullName).toBeTruthy();

    // 4. It's listed under upcoming, not past
    const upcoming = await http("GET", "/appointments?scope=upcoming", { token: aliceToken });
    expect(upcoming.body.data.items.map((a: { id: string }) => a.id)).toContain(id);
    const past = await http("GET", "/appointments?scope=past", { token: aliceToken });
    expect(past.body.data.items.map((a: { id: string }) => a.id)).not.toContain(id);
    expect(
      (await http("GET", "/appointments?scope=upcoming", { token: bobToken })).body.data.items,
    ).toHaveLength(0);

    // 5. Paying again is harmless
    expect(
      (await http("POST", `/appointments/${id}/mock-pay`, { token: aliceToken })).body.data
        .tokenNumber,
    ).toBe(paid.body.data.tokenNumber);

    // 6. Reschedule to another day: a new confirmed appointment, the old one points to it
    const moved = await http("POST", `/appointments/${id}/reschedule`, {
      token: aliceToken,
      body: { slotId: s2.id },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ status: "CONFIRMED", rescheduledFromId: id });
    const old = await http("GET", `/appointments/${id}`, { token: aliceToken });
    expect(old.body.data).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Rescheduled",
      rescheduledToId: moved.body.data.id,
    });
    expect(old.body.data.checkInCode).toBeNull();

    // 7. Cancel the new one; it moves to past
    const cancelled = await http("POST", `/appointments/${moved.body.data.id}/cancel`, {
      token: aliceToken,
      body: { reason: "Feeling better" },
    });
    expect(cancelled.body.data).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Feeling better",
      canCancel: false,
    });
    const history = await http("GET", "/appointments?scope=past", { token: aliceToken });
    expect(history.body.data.items.map((a: { id: string }) => a.id)).toEqual(
      expect.arrayContaining([id, moved.body.data.id]),
    );
    expect(
      (
        await http("POST", `/appointments/${moved.body.data.id}/cancel`, {
          token: aliceToken,
          body: {},
        })
      ).body.error.code,
    ).toBe("INVALID_STATUS");
  });

  it("listing is paginated and bounded", async () => {
    const res = await http("GET", "/appointments?scope=all&limit=1", { token: aliceToken });
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.limit).toBe(1);
    expect((await http("GET", "/appointments?limit=1000", { token: aliceToken })).status).toBe(400);
  });

  it("staff tokens can't use the patient booking API", async () => {
    const staff = await prisma.user.create({
      data: {
        role: "RECEPTIONIST",
        name: "Desk",
        loginId: `desk-${world.hospitalId.slice(0, 8)}`,
        hospitalId: world.hospitalId,
      },
    });
    world.userIds.push(staff.id);
    const token = signAccessToken({
      id: staff.id,
      role: "RECEPTIONIST",
      hospitalId: world.hospitalId,
      tokenVersion: 0,
    }).token;
    expect((await http("GET", "/appointments", { token })).status).toBe(403);
    expect((await http("GET", "/patient/profiles", { token })).status).toBe(403);
  });
});
