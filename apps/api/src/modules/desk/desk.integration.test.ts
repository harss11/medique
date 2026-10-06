/**
 * The front desk and consulting room, on a real PostgreSQL: who may do what, walk-in
 * booking (including races with online patients), check-in, the doctor's queue,
 * cancellations and their refunds. Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { mockOutbox } from "../../services/sms/index.js";
import { confirmAppointment, lockSlot } from "../appointments/booking.service.js";
import { clearQueueCache } from "../queue/queue.service.js";
import {
  TZ,
  cleanup,
  createDoctor,
  createPatients,
  createStaffUser,
  createWorld,
  slotFactory,
  type Patient,
  type Staff,
  type World,
} from "../../../test/fixtures.js";
import { until, useFakeRazorpay, type FakeRazorpay } from "../../../test/payments-helpers.js";

let server: Server;
let base: string;
let fake: FakeRazorpay;
let world: World;
let other: World; // a second hospital, to prove hospitals are isolated
let makeSlot: ReturnType<typeof slotFactory>;
let reception: Staff;
let hospitalAdmin: Staff;
let doctor: Staff;
let otherReception: Staff;
let doctor2Id: string;
let doctor2: Staff;
let pool: Patient[];
let cursor = 0;

const take = (n: number) => pool.slice(cursor, (cursor += n));
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

/** These tests need "today" (the hospital's calendar day) to still be today in 40 minutes. */
function minuteOfDayIST(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return get("hour") * 60 + get("minute");
}
const nearMidnight = () => minuteOfDayIST() > 24 * 60 - 50 || minuteOfDayIST() < 5;

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (a PDF)
  }
  return {
    status: res.status,
    body: json,
    data: json?.data,
    code: json?.error?.code as string | undefined,
    text,
  };
}

/** An online patient's paid appointment for a slot that starts in 40 minutes (today). */
async function onlineToday(p: Patient, doctorId = world.doctorId): Promise<string> {
  const slot = await makeSlot({ doctorId, startAt: minutesFromNow(40) });
  const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, {});
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  return hold.id;
}

/** A slot the desk can book right now: it started two minutes ago and runs for half an hour. */
const currentSlot = (options: { doctorId?: string; capacity?: number } = {}) =>
  makeSlot({ ...options, startAt: minutesFromNow(-2), durationMin: 30 });

let nameSeq = 0;
const walkInBody = (
  slotId: string,
  extra: Record<string, unknown> = {},
  patient: Record<string, unknown> = {},
) => ({
  slotId,
  patient: { fullName: `Walk In ${++nameSeq}`, ageYears: 34, gender: "MALE", ...patient },
  ...extra,
});

const apptRow = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    include: { payments: true, patientProfile: true },
  });
const codeOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id } })).checkInCode;

beforeAll(async () => {
  fake = useFakeRazorpay();
  world = await createWorld({ fee: 50_000 });
  other = await createWorld();
  makeSlot = slotFactory(world);
  reception = await createStaffUser(world, "RECEPTIONIST");
  hospitalAdmin = await createStaffUser(world, "HOSPITAL_ADMIN");
  doctor = await createStaffUser(world, "DOCTOR");
  doctor2Id = await createDoctor(world, 30_000);
  doctor2 = await createStaffUser(world, "DOCTOR", { doctorId: doctor2Id });
  otherReception = await createStaffUser(other, "RECEPTIONIST");
  pool = await createPatients(world, 80);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (world) await cleanup(world);
  if (other) await cleanup(other);
  await prisma.$disconnect();
});

beforeEach((ctx) => {
  clearQueueCache();
  if (nearMidnight()) ctx.skip(); // "today" would roll over mid-test
});

describe("who may use the desk", () => {
  it("refuses anonymous visitors and patients", async () => {
    expect((await api("GET", "/desk/appointments")).status).toBe(401);
    const [p] = take(1);
    const { signAccessToken } = await import("../auth/tokens.js");
    const patientToken = signAccessToken({
      id: p!.userId,
      role: "PATIENT",
      hospitalId: null,
      tokenVersion: 0,
    }).token;
    expect((await api("GET", "/desk/appointments", patientToken)).status).toBe(403);
    expect((await api("POST", "/desk/check-in", patientToken, { code: "ABCDEFGHJK" })).status).toBe(
      403,
    );
  });

  it("a receptionist can't see, book into, check in or cancel anything at another hospital", async () => {
    const [p] = take(1);
    const id = await onlineToday(p!);
    const code = await codeOf(id);
    expect((await api("GET", `/desk/appointments/${id}`, otherReception.token)).status).toBe(404);
    expect((await api("POST", "/desk/check-in", otherReception.token, { code })).code).toBe(
      "CODE_NOT_FOUND",
    );
    expect(
      (await api("POST", `/desk/appointments/${id}/cancel`, otherReception.token, {})).status,
    ).toBe(404);
    expect(
      (await api("POST", `/desk/appointments/${id}/start`, otherReception.token, {})).status,
    ).toBe(404);

    const slot = await currentSlot();
    const book = await api("POST", "/desk/appointments", otherReception.token, walkInBody(slot.id));
    expect(book.status).toBe(404);
    expect(book.code).toBe("SLOT_NOT_FOUND");

    const list = await api("GET", "/desk/appointments", otherReception.token);
    expect(list.data.items).toHaveLength(0);
    expect(list.text).not.toContain(id);
  });

  it("a doctor sees and acts on only their own patients", async () => {
    const [a, b] = take(2);
    const mine = await onlineToday(a!);
    const theirs = await onlineToday(b!, doctor2Id);

    const list = await api("GET", "/desk/appointments", doctor.token);
    const ids = list.data.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect((await api("GET", `/desk/appointments/${theirs}`, doctor.token)).status).toBe(404);
    expect((await api("POST", `/desk/appointments/${theirs}/start`, doctor.token, {})).status).toBe(
      404,
    );
    expect(
      (await api("GET", `/desk/appointments?doctorId=${doctor2Id}`, doctor.token)).status,
    ).toBe(404);
  });

  it("a doctor can't do front-desk work: book, take cash, check in, cancel", async () => {
    const [p] = take(1);
    const id = await onlineToday(p!);
    const slot = await currentSlot();
    expect(
      (await api("POST", "/desk/appointments", doctor.token, walkInBody(slot.id))).status,
    ).toBe(403);
    expect(
      (await api("POST", "/desk/check-in", doctor.token, { code: await codeOf(id) })).status,
    ).toBe(403);
    expect((await api("POST", `/desk/appointments/${id}/check-in`, doctor.token)).status).toBe(403);
    expect((await api("POST", `/desk/appointments/${id}/cash`, doctor.token)).status).toBe(403);
    expect((await api("POST", `/desk/appointments/${id}/cancel`, doctor.token, {})).status).toBe(
      403,
    );
    expect((await api("GET", `/desk/slots?doctorId=${world.doctorId}`, doctor.token)).status).toBe(
      403,
    );
  });

  it("a hospital admin can do everything a receptionist can", async () => {
    const slot = await currentSlot();
    const book = await api("POST", "/desk/appointments", hospitalAdmin.token, walkInBody(slot.id));
    expect(book.status).toBe(201);
  });
});

describe("walk-in booking", () => {
  it("books, takes cash, checks the patient in and sends the confirmation to the PATIENT's phone", async () => {
    const slot = await currentSlot();
    const phone = "+919812345678";
    const res = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody(
        slot.id,
        { reasonForVisit: "Fever" },
        { phone: "98123 45678", fullName: "Sunita Devi", ageYears: 52, gender: "FEMALE" },
      ),
    );
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      status: "CHECKED_IN",
      source: "WALK_IN",
      feeAmount: 50_000,
      paid: true,
      payment: { method: "CASH", status: "CAPTURED", amount: 50_000 },
      patient: { fullName: "Sunita Devi", phone, ageYears: 52, gender: "FEMALE" },
      reasonForVisit: "Fever",
    });
    expect(res.data.tokenNumber).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain("checkInCode"); // staff never see the patient's code

    const row = await apptRow(res.data.id);
    expect(row).toMatchObject({
      status: "CHECKED_IN",
      source: "WALK_IN",
      bookedById: reception.userId,
      commissionPercent: expect.anything(),
    });
    expect(Number(row.commissionPercent)).toBe(0); // the platform commission is for online bookings
    expect(row.payments[0]).toMatchObject({
      provider: "CASH",
      collectedById: reception.userId,
      commissionAmount: 0,
    });
    expect(row.patientProfile).toMatchObject({ userId: null, phone });

    // The SMS goes to the walk-in's phone, never to the receptionist.
    await until(
      async () =>
        (
          await prisma.notificationLog.findMany({
            where: { appointmentId: res.data.id, status: "SENT" },
          })
        )[0],
    );
    const sms = mockOutbox.filter((m) => m.to === phone && m.template === "booking_confirmed");
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain(`Token ${res.data.tokenNumber}`);
    expect(
      await prisma.notificationLog.count({
        where: { appointmentId: res.data.id, userId: { not: null } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          action: "appointment.walk_in_booked",
          entityId: res.data.id,
          actorId: reception.userId,
        },
      }),
    ).toBe(1);
  });

  it("can book without checking in, without a phone (no SMS), and pay later", async () => {
    const slot = await currentSlot();
    const res = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody(slot.id, { checkIn: false, payment: "PAY_LATER", sendSms: true }),
    );
    expect(res.data).toMatchObject({ status: "CONFIRMED", paid: false, payment: null });
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.notificationLog.count({ where: { appointmentId: res.data.id } })).toBe(0); // no phone given

    const cash = await api("POST", `/desk/appointments/${res.data.id}/cash`, reception.token);
    expect(cash.data).toMatchObject({ paid: true, payment: { method: "CASH", amount: 50_000 } });
    expect(
      (await api("POST", `/desk/appointments/${res.data.id}/cash`, reception.token)).code,
    ).toBe("ALREADY_PAID");
  });

  it("doesn't send an SMS when the desk says not to", async () => {
    const slot = await currentSlot();
    const phone = "+919822200001";
    const res = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody(slot.id, { sendSms: false }, { phone }),
    );
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.notificationLog.count({ where: { appointmentId: res.data.id } })).toBe(0);
  });

  it("recognises a returning walk-in, and refuses the same person twice with one doctor in a day", async () => {
    const phone = "98220 00002";
    const patient = { fullName: "Mohan Lal", phone };
    const a = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody((await currentSlot()).id, {}, patient),
    );
    const b = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody((await makeSlot({ dayOffset: 4 })).id, {}, patient),
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.data.patient.id).toBe(b.data.patient.id); // one profile, not two

    const sameDay = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody((await currentSlot()).id, {}, patient),
    );
    expect(sameDay.status).toBe(409);
    expect(sameDay.code).toBe("ALREADY_BOOKED");
  });

  it("the desk may book a slot that has started but not one that has ended, and online booking has closed by then", async () => {
    const ended = await makeSlot({ startAt: minutesFromNow(-30), durationMin: 5 });
    expect(
      (await api("POST", "/desk/appointments", reception.token, walkInBody(ended.id))).code,
    ).toBe("SLOT_UNAVAILABLE");

    const running = await currentSlot();
    expect(
      (await api("POST", "/desk/appointments", reception.token, walkInBody(running.id))).status,
    ).toBe(201);
    const [p] = take(1);
    await expect(
      lockSlot(
        p!.auth,
        {
          slotId: (await makeSlot({ doctorId: world.doctorId, startAt: minutesFromNow(5) })).id,
          patientProfileId: p!.profileId,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });

  it("validates the form", async () => {
    const slot = await currentSlot();
    expect(
      (
        await api(
          "POST",
          "/desk/appointments",
          reception.token,
          walkInBody(slot.id, {}, { phone: "12345" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          "POST",
          "/desk/appointments",
          reception.token,
          walkInBody(slot.id, {}, { fullName: "A" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          "POST",
          "/desk/appointments",
          reception.token,
          walkInBody(slot.id, {}, { ageYears: 400 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", "/desk/appointments", reception.token, {
          slotId: "nope",
          patient: { fullName: "Abc" },
        })
      ).status,
    ).toBe(400);
    const blocked = await makeSlot({
      status: "BLOCKED",
      startAt: minutesFromNow(-1),
      durationMin: 20,
    });
    expect(
      (await api("POST", "/desk/appointments", reception.token, walkInBody(blocked.id))).code,
    ).toBe("SLOT_UNAVAILABLE");
  });

  it("40 simultaneous desk bookings for a 5-seat slot: exactly 5 winners, on distinct seats and tokens", async () => {
    const slot = await currentSlot({ capacity: 5 });
    const attempts = Array.from({ length: 40 }, () =>
      api("POST", "/desk/appointments", reception.token, walkInBody(slot.id)),
    );
    const results = await Promise.all(attempts);
    const codes = results.map((r) => (r.status === 201 ? "OK" : r.code));
    expect(codes.filter((c) => c === "OK")).toHaveLength(5);
    expect(codes.filter((c) => c === "SLOT_FULL")).toHaveLength(35);

    const held = await prisma.appointment.findMany({
      where: { slotId: slot.id, seatNumber: { not: null } },
    });
    expect(held.map((h) => h.seatNumber).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(held.map((h) => h.tokenNumber)).size).toBe(5); // five different tokens
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).bookedCount).toBe(5);
  });

  it("an online patient and the desk racing for the last seat: exactly one gets it", async () => {
    // A future slot is bookable both online and at the desk.
    const slot = await makeSlot({ startAt: minutesFromNow(60), capacity: 1 });
    const [p] = take(1);
    const [online, desk] = await Promise.all([
      lockSlot(p!.auth, { slotId: slot.id, patientProfileId: p!.profileId }, {}).then(
        () => "OK",
        (e) => (e as { code: string }).code,
      ),
      api("POST", "/desk/appointments", reception.token, walkInBody(slot.id)).then((r) =>
        r.status === 201 ? "OK" : (r.code as string),
      ),
    ]);
    expect([online, desk].filter((x) => x === "OK")).toHaveLength(1);
    expect([online, desk].filter((x) => x === "SLOT_FULL")).toHaveLength(1);
  });

  it("walk-in tokens continue the same sequence as online ones, with no gaps or repeats", async () => {
    const doctorId = await createDoctor(world, 10_000);
    const patients = take(3);
    await onlineToday(patients[0]!, doctorId);
    await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody((await currentSlot({ doctorId })).id),
    );
    await onlineToday(patients[1]!, doctorId);
    await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody((await currentSlot({ doctorId })).id),
    );
    const tokens = (
      await prisma.appointment.findMany({
        where: { doctorId, tokenNumber: { not: null } },
        select: { tokenNumber: true },
      })
    )
      .map((a) => a.tokenNumber!)
      .sort((a, b) => a - b);
    expect(tokens).toEqual([1, 2, 3, 4]);
  });

  it("lists the slots a receptionist can book, including the one running now", async () => {
    const doctorId = await createDoctor(world, 10_000);
    const running = await currentSlot({ doctorId });
    const past = await makeSlot({ doctorId, startAt: minutesFromNow(-120), durationMin: 5 });
    const res = await api("GET", `/desk/slots?doctorId=${doctorId}`, reception.token);
    const ids = res.data.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(running.id);
    expect(ids).not.toContain(past.id);
    expect(res.data.doctor.consultationFee).toBe(10_000);
    expect(
      (await api("GET", `/desk/slots?doctorId=${doctorId}`, otherReception.token)).status,
    ).toBe(404);
  });
});

describe("check-in", () => {
  it("accepts the code as a person types it, and is safe to repeat", async () => {
    const [p] = take(1);
    const id = await onlineToday(p!);
    const code = await codeOf(id);
    const typed = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`.toLowerCase();

    const first = await api("POST", "/desk/check-in", reception.token, { code: typed });
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({
      alreadyCheckedIn: false,
      appointment: { id, status: "CHECKED_IN" },
    });
    expect((await apptRow(id)).checkedInAt).not.toBeNull();

    const again = await api("POST", "/desk/check-in", reception.token, { code });
    expect(again.data.alreadyCheckedIn).toBe(true);
  });

  it("explains why it can't check someone in", async () => {
    const [a, b] = take(2);
    expect(
      (await api("POST", "/desk/check-in", reception.token, { code: "ZZZZZZZZZZ" })).code,
    ).toBe("CODE_NOT_FOUND");

    // Booked for another day.
    const future = await lockSlot(
      a!.auth,
      { slotId: (await makeSlot({ dayOffset: 5 })).id, patientProfileId: a!.profileId },
      {},
    );
    await confirmAppointment(future.id, { provider: "MOCK", method: "ONLINE" }, null);
    const wrongDay = await api("POST", "/desk/check-in", reception.token, {
      code: await codeOf(future.id),
    });
    expect(wrongDay.status).toBe(409);
    expect(wrongDay.code).toBe("WRONG_DAY");
    expect(wrongDay.body.error.message).toMatch(/not today/);

    // Cancelled.
    const id = await onlineToday(b!);
    await api("POST", `/desk/appointments/${id}/cancel`, reception.token, {
      initiator: "HOSPITAL",
    });
    const cancelled = await api("POST", "/desk/check-in", reception.token, {
      code: await codeOf(id),
    });
    expect(cancelled.code).toBe("INVALID_STATUS");
    expect(cancelled.body.error.message).toMatch(/was cancelled/);
  });

  it("can check in a patient who was marked absent but then turned up", async () => {
    const [p] = take(1);
    const id = await onlineToday(p!);
    await api("POST", `/desk/appointments/${id}/no-show`, reception.token);
    expect((await apptRow(id)).status).toBe("NO_SHOW");
    const back = await api("POST", `/desk/appointments/${id}/check-in`, reception.token);
    expect(back.data.appointment.status).toBe("CHECKED_IN");
  });
});

describe("the doctor's queue", () => {
  async function twoWaiting() {
    const doctorId = await createDoctor(world, 10_000);
    const dr = await createStaffUser(world, "DOCTOR", { doctorId });
    const [a, b] = take(2);
    const first = await onlineToday(a!, doctorId);
    const second = await onlineToday(b!, doctorId);
    await api("POST", `/desk/appointments/${first}/check-in`, reception.token);
    await api("POST", `/desk/appointments/${second}/check-in`, reception.token);
    return { doctorId, dr, first, second };
  }

  it("start, complete and the next patient, one at a time", async () => {
    const { doctorId, dr, first, second } = await twoWaiting();

    const start = await api("POST", `/desk/appointments/${first}/start`, dr.token, {});
    expect(start.data).toMatchObject({ status: "IN_PROGRESS" });
    expect((await apptRow(first)).startedAt).not.toBeNull();
    const day = await prisma.doctorDay.findFirstOrThrow({ where: { doctorId } });
    expect(day.currentToken).toBe(start.data.tokenNumber);

    // Only one patient can be with the doctor.
    const clash = await api("POST", `/desk/appointments/${second}/start`, dr.token, {});
    expect(clash.status).toBe(409);
    expect(clash.code).toBe("IN_PROGRESS_EXISTS");
    expect(clash.body.error.details.currentToken).toBe(start.data.tokenNumber);
    expect((await apptRow(second)).status).toBe("CHECKED_IN");

    // "Next patient" completes the current one and starts the next in a single step.
    const next = await api("POST", `/desk/appointments/${second}/start`, dr.token, {
      completeCurrent: true,
    });
    expect(next.data.status).toBe("IN_PROGRESS");
    expect((await apptRow(first)).status).toBe("COMPLETED");
    expect((await apptRow(first)).completedAt).not.toBeNull();

    expect((await api("POST", `/desk/appointments/${second}/complete`, dr.token)).data.status).toBe(
      "COMPLETED",
    );
    expect((await api("POST", `/desk/appointments/${second}/complete`, dr.token)).code).toBe(
      "INVALID_STATUS",
    );
    expect(await prisma.appointment.count({ where: { doctorId, status: "IN_PROGRESS" } })).toBe(0);
  });

  it("two people starting two patients at the same instant: only one gets in", async () => {
    const { doctorId, dr, first, second } = await twoWaiting();
    const results = await Promise.all([
      api("POST", `/desk/appointments/${first}/start`, dr.token, {}),
      api("POST", `/desk/appointments/${second}/start`, reception.token, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.appointment.count({ where: { doctorId, status: "IN_PROGRESS" } })).toBe(1);
  });

  it("starting a patient who walked straight in checks them in", async () => {
    const doctorId = await createDoctor(world, 10_000);
    const dr = await createStaffUser(world, "DOCTOR", { doctorId });
    const [p] = take(1);
    const id = await onlineToday(p!, doctorId);
    expect((await apptRow(id)).checkedInAt).toBeNull();
    await api("POST", `/desk/appointments/${id}/start`, dr.token, {});
    expect((await apptRow(id)).checkedInAt).not.toBeNull();
  });

  it("only today's appointments can be started or marked absent", async () => {
    const [p] = take(1);
    const future = await lockSlot(
      p!.auth,
      { slotId: (await makeSlot({ dayOffset: 6 })).id, patientProfileId: p!.profileId },
      {},
    );
    await confirmAppointment(future.id, { provider: "MOCK", method: "ONLINE" }, null);
    expect(
      (await api("POST", `/desk/appointments/${future.id}/start`, doctor.token, {})).code,
    ).toBe("WRONG_DAY");
    expect(
      (await api("POST", `/desk/appointments/${future.id}/no-show`, reception.token)).code,
    ).toBe("WRONG_DAY");
  });

  it("a no-show gets no refund, and a finished consultation can't be cancelled", async () => {
    const { doctorId, dr, first } = await twoWaiting();
    void doctorId;
    const [p] = take(1);
    const paidOnline = await onlineToday(p!);
    await prisma.payment.updateMany({
      where: { appointmentId: paidOnline },
      data: { status: "CAPTURED" },
    });
    await api("POST", `/desk/appointments/${paidOnline}/no-show`, reception.token);
    expect(await prisma.refund.count({ where: { payment: { appointmentId: paidOnline } } })).toBe(
      0,
    );

    await api("POST", `/desk/appointments/${first}/start`, dr.token, {});
    await api("POST", `/desk/appointments/${first}/complete`, dr.token);
    const late = await api("POST", `/desk/appointments/${first}/cancel`, reception.token, {});
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/already been seen/);
  });
});

describe("cancelling at the desk", () => {
  async function paidOnlineToday(p: Patient, hoursAhead?: number) {
    const slot = await makeSlot({
      startAt: hoursAhead ? minutesFromNow(hoursAhead * 60) : minutesFromNow(40),
    });
    const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, {});
    await confirmAppointment(
      hold.id,
      { provider: "RAZORPAY", method: "ONLINE", razorpayPaymentId: `pay_${hold.id}` },
      null,
    );
    return { id: hold.id, slotId: slot.id };
  }

  it("a hospital cancellation refunds an online payment in full, however close the appointment, and tells the patient", async () => {
    const [p] = take(1);
    const { id, slotId } = await paidOnlineToday(p!); // 40 minutes away: policy alone would give 50%
    const res = await api("POST", `/desk/appointments/${id}/cancel`, reception.token, {
      initiator: "HOSPITAL",
      reason: "Doctor unavailable",
    });
    expect(res.status).toBe(200);
    expect(res.data.refund).toEqual({ amount: 50_000, percent: 100, method: "ONLINE" });
    expect(res.data.appointment).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Doctor unavailable",
    });

    const payment = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: id },
      include: { refunds: true },
    });
    const settled = await until(async () => {
      const x = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      return x.status === "REFUNDED" ? x : null;
    });
    expect(settled.refundedAmount).toBe(50_000);
    expect(fake.refunds.some((r) => r.paymentId === `pay_${id}` && r.amountMinor === 50_000)).toBe(
      true,
    );
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slotId } })).bookedCount).toBe(0); // the seat is free again
    const msg = await until(
      async () =>
        (
          await prisma.notificationLog.findMany({
            where: { appointmentId: id, template: "appointment_cancelled", status: "SENT" },
          })
        )[0],
    );
    expect(msg).toBeTruthy();
  });

  it("a patient-requested cancellation follows the refund policy", async () => {
    const [p] = take(1);
    const { id } = await paidOnlineToday(p!); // inside 24 hours: 50%
    const res = await api("POST", `/desk/appointments/${id}/cancel`, reception.token, {
      initiator: "PATIENT_REQUEST",
    });
    expect(res.data.refund).toEqual({ amount: 25_000, percent: 50, method: "ONLINE" });
  });

  it("cash is handed back at the desk: the refund is recorded as complete and never goes to the gateway", async () => {
    const slot = await currentSlot();
    const booked = await api("POST", "/desk/appointments", reception.token, walkInBody(slot.id));
    const gatewayCalls = fake.refunds.length;

    const res = await api("POST", `/desk/appointments/${booked.data.id}/cancel`, reception.token, {
      initiator: "HOSPITAL",
    });
    expect(res.data.refund).toEqual({ amount: 50_000, percent: 100, method: "CASH" });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: booked.data.id },
      include: { refunds: true },
    });
    expect(payment).toMatchObject({ status: "REFUNDED", refundedAmount: 50_000 });
    expect(payment.refunds[0]).toMatchObject({
      status: "PROCESSED",
      amount: 50_000,
      initiatedById: reception.userId,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.refunds.length).toBe(gatewayCalls);
    expect(
      await prisma.auditLog.count({
        where: { action: "refund.failed", entityId: payment.refunds[0]!.id },
      }),
    ).toBe(0);
  });

  it("an unpaid pay-later booking cancels with no refund, and the seat can be booked again", async () => {
    const slot = await currentSlot({ capacity: 1 });
    const booked = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody(slot.id, { payment: "PAY_LATER" }),
    );
    const res = await api(
      "POST",
      `/desk/appointments/${booked.data.id}/cancel`,
      reception.token,
      {},
    );
    expect(res.data.refund).toBeNull();
    expect(
      (await api("POST", "/desk/appointments", reception.token, walkInBody(slot.id))).status,
    ).toBe(201);
  });

  it("twenty simultaneous cancels of one appointment queue one refund", async () => {
    const [p] = take(1);
    const { id } = await paidOnlineToday(p!);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api("POST", `/desk/appointments/${id}/cancel`, reception.token, { initiator: "HOSPITAL" }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: id },
      include: { refunds: true },
    });
    expect(payment.refunds).toHaveLength(1);
  });

  it("is audited with who did it", async () => {
    const [p] = take(1);
    const { id } = await paidOnlineToday(p!);
    await api("POST", `/desk/appointments/${id}/cancel`, hospitalAdmin.token, {
      initiator: "HOSPITAL",
    });
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "appointment.cancelled_by_staff", entityId: id },
    });
    expect(log).toMatchObject({
      actorId: hospitalAdmin.userId,
      actorRole: "HOSPITAL_ADMIN",
      hospitalId: world.hospitalId,
    });
  });
});

describe("the day's list", () => {
  it("shows a doctor's day in token order with counts and the live queue", async () => {
    const doctorId = await createDoctor(world, 10_000);
    const dr = await createStaffUser(world, "DOCTOR", { doctorId });
    const patients = take(3);
    const ids = [];
    for (const p of patients) ids.push(await onlineToday(p, doctorId));
    await api("POST", `/desk/appointments/${ids[0]}/check-in`, reception.token);
    await api("POST", `/desk/appointments/${ids[0]}/start`, dr.token, {});
    await api("POST", `/desk/appointments/${ids[2]}/no-show`, reception.token);

    const res = await api("GET", `/desk/appointments?doctorId=${doctorId}`, reception.token);
    expect(res.status).toBe(200);
    expect(res.data.items.map((i: { id: string }) => i.id)).toEqual(ids); // token order
    expect(res.data.items.map((i: { status: string }) => i.status)).toEqual([
      "IN_PROGRESS",
      "CONFIRMED",
      "NO_SHOW",
    ]);
    expect(res.data.summary).toMatchObject({
      booked: 1,
      waiting: 0,
      inProgress: 1,
      completed: 0,
      noShow: 1,
      cancelled: 0,
    });
    expect(res.data.queue).toMatchObject({
      state: "SERVING",
      nowServing: res.data.items[0].tokenNumber,
    });

    const active = await api(
      "GET",
      `/desk/appointments?doctorId=${doctorId}&status=active`,
      reception.token,
    );
    expect(active.data.items).toHaveLength(2);
    const asDoctor = await api("GET", "/desk/appointments?status=done", dr.token);
    expect(asDoctor.data.items.map((i: { status: string }) => i.status)).toEqual(["NO_SHOW"]);
  });

  it("finds patients by token, name or phone, and keeps cancelled ones out unless asked", async () => {
    const doctorId = await createDoctor(world, 10_000);
    const slot = await currentSlot({ doctorId });
    const booked = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody(slot.id, {}, { fullName: "Zebulon Quasar", phone: "98220 00099" }),
    );
    const slot2 = await currentSlot({ doctorId });
    const gone = await api(
      "POST",
      "/desk/appointments",
      reception.token,
      walkInBody(slot2.id, {}, { fullName: "Cancelled Person" }),
    );
    await api("POST", `/desk/appointments/${gone.data.id}/cancel`, reception.token, {});

    const q = (s: string) =>
      api(
        "GET",
        `/desk/appointments?doctorId=${doctorId}&search=${encodeURIComponent(s)}`,
        reception.token,
      ).then((r) => r.data.items.map((i: { id: string }) => i.id));
    expect(await q("quasar")).toEqual([booked.data.id]);
    expect(await q("9822000099")).toEqual([booked.data.id]);
    expect(await q(String(booked.data.tokenNumber))).toContain(booked.data.id);
    expect(await q("nobody-by-this-name")).toEqual([]);

    const all = await api("GET", `/desk/appointments?doctorId=${doctorId}`, reception.token);
    expect(all.data.items.map((i: { id: string }) => i.id)).not.toContain(gone.data.id);
    const cancelled = await api(
      "GET",
      `/desk/appointments?doctorId=${doctorId}&status=cancelled`,
      reception.token,
    );
    expect(cancelled.data.items.map((i: { id: string }) => i.id)).toEqual([gone.data.id]);
  });

  it("validates its inputs and is bounded", async () => {
    expect((await api("GET", "/desk/appointments?date=nope", reception.token)).status).toBe(400);
    expect((await api("GET", "/desk/appointments?limit=1000", reception.token)).status).toBe(400);
    expect((await api("GET", "/desk/appointments?status=weird", reception.token)).status).toBe(400);
    expect(
      (await api("GET", `/desk/appointments?doctorId=${other.doctorId}`, reception.token)).status,
    ).toBe(404);
  });

  it("lists the hospital's active doctors; a doctor sees only themselves", async () => {
    const all = await api("GET", "/desk/doctors", reception.token);
    expect(all.data.items.length).toBeGreaterThanOrEqual(2);
    expect(all.data.items.map((d: { id: string }) => d.id)).not.toContain(other.doctorId);
    const mine = await api("GET", "/desk/doctors", doctor2.token);
    expect(mine.data.items.map((d: { id: string }) => d.id)).toEqual([doctor2Id]);
  });
});
