/**
 * The public live queue, slip templates and printing, the emergency finder, and the
 * patient's link to the queue. On a real PostgreSQL. Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken } from "../auth/tokens.js";
import { confirmAppointment, lockSlot } from "../appointments/booking.service.js";
import { slipAppointmentInclude, slipValuesFor } from "../slips/slip-data.js";
import { clearQueueCache } from "./queue.service.js";
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
import { useFakeRazorpay } from "../../../test/payments-helpers.js";

let server: Server;
let base: string;
let world: World;
let other: World;
let makeSlot: ReturnType<typeof slotFactory>;
let reception: Staff;
let admin: Staff;
let otherAdmin: Staff;
let otherReception: Staff;
let pool: Patient[];
let cursor = 0;
const extraHospitals: string[] = [];

const take = (n: number) => pool.slice(cursor, (cursor += n));
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
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString("utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // binary (a PDF)
  }
  return {
    status: res.status,
    body: json,
    data: json?.data,
    code: json?.error?.code as string | undefined,
    text,
    bytes,
    type: res.headers.get("content-type"),
  };
}
const pages = async (bytes: Buffer) => (await PDFDocument.load(bytes)).getPageCount();

async function onlineToday(p: Patient, doctorId: string): Promise<string> {
  const slot = await makeSlot({ doctorId, startAt: minutesFromNow(40) });
  const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, {});
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  clearQueueCache(); // booked straight through the service, so the 2 s read cache must be dropped by hand
  return hold.id;
}
const tokenOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id } })).tokenNumber!;

const SLIP_BODY = {
  name: "OPD slip",
  paperWidthMm: 148,
  paperHeightMm: 210,
  offsetXMm: 0,
  offsetYMm: 0,
  fields: [
    {
      key: "patientName",
      xMm: 30,
      yMm: 50,
      maxWidthMm: 80,
      fontSizePt: 12,
      bold: true,
      align: "left",
    },
    {
      key: "tokenNumber",
      xMm: 110,
      yMm: 50,
      maxWidthMm: 30,
      fontSizePt: 18,
      bold: true,
      align: "left",
    },
  ],
};

beforeAll(async () => {
  useFakeRazorpay();
  world = await createWorld({ fee: 50_000 });
  other = await createWorld();
  makeSlot = slotFactory(world);
  reception = await createStaffUser(world, "RECEPTIONIST");
  admin = await createStaffUser(world, "HOSPITAL_ADMIN");
  otherAdmin = await createStaffUser(other, "HOSPITAL_ADMIN");
  otherReception = await createStaffUser(other, "RECEPTIONIST");
  pool = await createPatients(world, 40);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (extraHospitals.length)
    await prisma.hospital.deleteMany({ where: { id: { in: extraHospitals } } });
  if (world) await cleanup(world);
  if (other) await cleanup(other);
  await prisma.$disconnect();
});

beforeEach(() => {
  clearQueueCache();
});

describe("the live queue page", () => {
  const qr = async (doctorId: string) =>
    (await prisma.doctor.findUniqueOrThrow({ where: { id: doctorId } })).qrToken;
  const queue = async (doctorId: string, token?: number) =>
    api("GET", `/public/queue/${await qr(doctorId)}${token ? `?token=${token}` : ""}`);

  it("follows a clinic day from empty to done, and estimates the wait as tokens ahead x average minutes", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    const doctorId = await createDoctor(world, 10_000);
    await prisma.doctor.update({ where: { id: doctorId }, data: { avgConsultMinutes: 12 } });
    const dr = await createStaffUser(world, "DOCTOR", { doctorId });
    const patients = take(4);

    expect((await queue(doctorId)).data).toMatchObject({
      state: "NO_BOOKINGS",
      nowServing: null,
      lastIssued: 0,
    });

    const ids: string[] = [];
    for (const p of patients) ids.push(await onlineToday(p, doctorId));
    const tokens = await Promise.all(ids.map(tokenOf));
    expect((await queue(doctorId)).data).toMatchObject({
      state: "NOT_STARTED",
      lastIssued: 4,
      counts: { booked: 4, waiting: 0 },
    });

    for (const id of ids) await api("POST", `/desk/appointments/${id}/check-in`, reception.token);
    await api("POST", `/desk/appointments/${ids[0]}/start`, dr.token, {});

    const serving = await queue(doctorId, tokens[3]);
    expect(serving.data).toMatchObject({
      state: "SERVING",
      nowServing: tokens[0],
      counts: { waiting: 3, inProgress: 1 },
    });
    // Three people (one with the doctor, two waiting) are ahead of the fourth: 3 x 12 minutes.
    expect(serving.data.yourToken).toEqual({
      token: tokens[3],
      status: "WAITING",
      ahead: 3,
      minutes: 36,
    });
    expect((await queue(doctorId, tokens[0])).data.yourToken).toMatchObject({
      status: "NOW",
      ahead: 0,
      minutes: 0,
    });

    await api("POST", `/desk/appointments/${ids[0]}/complete`, dr.token);
    const between = await queue(doctorId, tokens[0]);
    expect(between.data).toMatchObject({
      state: "BETWEEN",
      nowServing: null,
      lastServed: tokens[0],
    });
    expect(between.data.yourToken.status).toBe("DONE");

    await api("POST", `/desk/appointments/${ids[1]}/start`, dr.token, {});
    await api("POST", `/desk/appointments/${ids[1]}/complete`, dr.token);
    await api("POST", `/desk/appointments/${ids[2]}/no-show`, reception.token);
    expect((await queue(doctorId, tokens[2])).data.yourToken.status).toBe("MISSED");
    await api("POST", `/desk/appointments/${ids[3]}/start`, dr.token, {});
    await api("POST", `/desk/appointments/${ids[3]}/complete`, dr.token);

    expect((await queue(doctorId)).data).toMatchObject({
      state: "DONE",
      lastServed: tokens[3],
      counts: { completed: 3, noShow: 1 },
    });
    expect((await queue(doctorId, 9999)).data.yourToken).toMatchObject({ status: "NOT_FOUND" });
  });

  it("shows numbers only: no names, phone numbers, ids or codes", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    const doctorId = await createDoctor(world, 10_000);
    const [p] = take(1);
    const id = await onlineToday(p!, doctorId);
    const code = (await prisma.appointment.findUniqueOrThrow({ where: { id } })).checkInCode;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: p!.userId } });
    const res = await queue(doctorId, await tokenOf(id));
    expect(res.status).toBe(200);
    for (const secret of [
      user.name,
      user.phone!,
      id,
      code,
      "checkInCode",
      "patient",
      "qrToken",
      "commission",
    ]) {
      expect(res.text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(res.data.doctor).toEqual({ name: expect.any(String), department: "General Medicine" });
  });

  it("rejects bad links and anything that is not an open hospital's active doctor", async () => {
    expect((await api("GET", "/public/queue/this-token-does-not-exist-1234")).code).toBe(
      "QUEUE_NOT_FOUND",
    );
    expect((await api("GET", "/public/queue/short")).status).toBe(400);
    const doctorId = await createDoctor(world, 10_000);
    const token = await qr(doctorId);
    expect((await api("GET", `/public/queue/${token}?token=0`)).status).toBe(400);
    expect((await api("GET", `/public/queue/${token}?token=abc`)).status).toBe(400);

    await prisma.doctor.update({ where: { id: doctorId }, data: { isActive: false } });
    expect((await api("GET", `/public/queue/${token}`)).status).toBe(404);
    await prisma.doctor.update({ where: { id: doctorId }, data: { isActive: true } });

    await prisma.hospital.update({ where: { id: world.hospitalId }, data: { status: "BLOCKED" } });
    try {
      expect((await api("GET", `/public/queue/${token}`)).status).toBe(404);
    } finally {
      await prisma.hospital.update({ where: { id: world.hospitalId }, data: { status: "ACTIVE" } });
    }
    expect((await api("GET", `/public/queue/${token}`)).status).toBe(200);
  });

  it("gives a patient with a valid ticket the link to their doctor's queue, and nobody else", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    const [p] = take(1);
    const id = await onlineToday(p!, world.doctorId);
    const patientToken = signAccessToken({
      id: p!.userId,
      role: "PATIENT",
      hospitalId: null,
      tokenVersion: 0,
    }).token;
    const mine = await api("GET", `/appointments/${id}`, patientToken);
    expect(mine.data.queueToken).toBe(await qr(world.doctorId));
    expect(mine.data.doctor).not.toHaveProperty("qrToken");

    await api("POST", `/desk/appointments/${id}/cancel`, reception.token, {
      initiator: "HOSPITAL",
    }); // the patient window to cancel by themselves has closed
    expect((await api("GET", `/appointments/${id}`, patientToken)).data.queueToken).toBeNull();
  });
});

describe("slip templates", () => {
  it("the first template becomes the default; a better one can replace it; deleting the default promotes another", async () => {
    const first = await api("POST", "/hospital/slip-templates", admin.token, SLIP_BODY);
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ isDefault: true, paperWidthMm: 148 });
    const second = await api("POST", "/hospital/slip-templates", admin.token, {
      ...SLIP_BODY,
      name: "Half page",
    });
    expect(second.data.isDefault).toBe(false);

    const promoted = await api(
      "POST",
      `/hospital/slip-templates/${second.data.id}/default`,
      admin.token,
    );
    expect(promoted.data.isDefault).toBe(true);
    const list = await api("GET", "/hospital/slip-templates", admin.token);
    expect(list.data.items.filter((t: { isDefault: boolean }) => t.isDefault)).toHaveLength(1);
    expect(list.data.items[0].id).toBe(second.data.id); // default first

    await api("DELETE", `/hospital/slip-templates/${second.data.id}`, admin.token);
    const after = await api("GET", "/hospital/slip-templates", admin.token);
    expect(after.data.items).toHaveLength(1);
    expect(after.data.items[0]).toMatchObject({ id: first.data.id, isDefault: true });
  });

  it("saves millimetre positions and the calibration offset exactly, and edits them", async () => {
    const created = await api("POST", "/hospital/slip-templates", admin.token, {
      ...SLIP_BODY,
      name: "Calibrated",
      offsetXMm: 1.5,
      offsetYMm: -2,
    });
    expect(created.data).toMatchObject({ offsetXMm: 1.5, offsetYMm: -2 });
    expect(created.data.fields[0]).toMatchObject({
      key: "patientName",
      xMm: 30,
      yMm: 50,
      maxWidthMm: 80,
      fontSizePt: 12,
      bold: true,
    });
    const edited = await api("PATCH", `/hospital/slip-templates/${created.data.id}`, admin.token, {
      ...SLIP_BODY,
      name: "Calibrated",
      offsetXMm: 0.5,
      fields: [{ ...SLIP_BODY.fields[0], xMm: 33.3 }],
    });
    expect(edited.data).toMatchObject({ offsetXMm: 0.5, offsetYMm: 0 });
    expect(edited.data.fields).toHaveLength(1);
    expect(edited.data.fields[0].xMm).toBe(33.3);
  });

  it("refuses invalid layouts", async () => {
    const bad = (patch: object) =>
      api("POST", "/hospital/slip-templates", admin.token, { ...SLIP_BODY, ...patch });
    expect((await bad({ fields: [{ ...SLIP_BODY.fields[0], xMm: 400 }] })).status).toBe(400);
    expect((await bad({ fields: [SLIP_BODY.fields[0], SLIP_BODY.fields[0]] })).status).toBe(400);
    expect((await bad({ fields: [{ ...SLIP_BODY.fields[0], key: "commission" }] })).status).toBe(
      400,
    );
    expect((await bad({ paperWidthMm: 10 })).status).toBe(400);
    expect((await bad({ offsetYMm: 99 })).status).toBe(400);
  });

  it("is private to the hospital and to the hospital admin", async () => {
    const mine = await api("POST", "/hospital/slip-templates", admin.token, {
      ...SLIP_BODY,
      name: "Private",
    });
    expect(
      (await api("GET", `/hospital/slip-templates/${mine.data.id}`, otherAdmin.token)).status,
    ).toBe(404);
    expect(
      (await api("PATCH", `/hospital/slip-templates/${mine.data.id}`, otherAdmin.token, SLIP_BODY))
        .status,
    ).toBe(404);
    expect(
      (await api("DELETE", `/hospital/slip-templates/${mine.data.id}`, otherAdmin.token)).status,
    ).toBe(404);
    expect(
      (await api("POST", `/hospital/slip-templates/${mine.data.id}/default`, otherAdmin.token))
        .status,
    ).toBe(404);
    // Reception can print with templates but not design them.
    expect((await api("GET", "/hospital/slip-templates", reception.token)).status).toBe(403);
    expect((await api("POST", "/hospital/slip-templates", reception.token, SLIP_BODY)).status).toBe(
      403,
    );
    expect((await api("GET", "/hospital/slip-templates")).status).toBe(401);
  });

  it("test print returns a PDF of the paper's exact size from an unsaved layout, with or without guides", async () => {
    for (const guides of [false, true]) {
      const res = await api("POST", "/hospital/slip-templates/test-print", admin.token, {
        template: SLIP_BODY,
        guides,
      });
      expect(res.status).toBe(200);
      expect(res.type).toBe("application/pdf");
      expect(res.bytes.subarray(0, 5).toString()).toBe("%PDF-");
      const doc = await PDFDocument.load(res.bytes);
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getPage(0).getSize().width).toBeCloseTo((148 * 72) / 25.4, 1);
    }
    expect(
      (
        await api("POST", "/hospital/slip-templates/test-print", admin.token, {
          template: { ...SLIP_BODY, paperWidthMm: 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", "/hospital/slip-templates/test-print", reception.token, {
          template: SLIP_BODY,
        })
      ).status,
    ).toBe(403);
  });

  it("a scan of the blank paper can't be stored until file storage is configured, and says so", async () => {
    const t = await api("POST", "/hospital/slip-templates", admin.token, {
      ...SLIP_BODY,
      name: "With scan",
    });
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const form = new FormData();
    form.append("background", new Blob([png], { type: "image/png" }), "paper.png");
    const res = await fetch(`${base}/hospital/slip-templates/${t.data.id}/background`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: form,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "STORAGE_NOT_CONFIGURED",
    );
  });
});

describe("printing slips at the desk", () => {
  async function ensureTemplate() {
    if ((await prisma.slipTemplate.count({ where: { hospitalId: world.hospitalId } })) === 0) {
      await api("POST", "/hospital/slip-templates", admin.token, SLIP_BODY);
    }
  }

  it("fills a slip with the patient's own details, in the hospital's timezone", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    const [p] = take(1);
    const id = await onlineToday(p!, world.doctorId);
    await prisma.patientProfile.update({
      where: { id: p!.profileId },
      data: {
        fullName: "Sunita Devi",
        gender: "FEMALE",
        dateOfBirth: new Date("1980-03-15T00:00:00Z"),
        phone: "+919876500000",
      },
    });
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id },
      include: slipAppointmentInclude,
    });
    const values = slipValuesFor(row, new Date("2026-10-05T00:00:00Z"));
    expect(values).toMatchObject({
      patientName: "Sunita Devi",
      patientAge: "46",
      patientGender: "F",
      patientAgeGender: "46 / F",
      patientPhone: "+919876500000",
      department: "General Medicine",
      tokenNumber: String(row.tokenNumber),
      fee: "₹500.00",
    });
    expect(values.time).toMatch(/^\d{1,2}:\d{2} (am|pm)$/);
    expect(values.date).toMatch(/^\d{1,2} \w{3} \d{4}$/);
    expect(values.checkInCode).toMatch(
      /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}$/,
    );
  });

  it("prints one slip as a PDF and records who printed it", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    await ensureTemplate();
    const [p] = take(1);
    const id = await onlineToday(p!, world.doctorId);
    const res = await api("GET", `/desk/appointments/${id}/slip`, reception.token);
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/pdf");
    expect(await pages(res.bytes)).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: "slip.printed", entityId: id, actorId: reception.userId },
      }),
    ).toBe(1);
    expect((await api("GET", `/desk/appointments/${id}/slip`, otherReception.token)).status).toBe(
      404,
    );
  });

  it("says what to do when the hospital has no template yet", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    const otherSlot = await slotFactory(other)({ startAt: minutesFromNow(-1), durationMin: 30 });
    const booked = await api("POST", "/desk/appointments", otherReception.token, {
      slotId: otherSlot.id,
      patient: { fullName: "No Template" },
    });
    expect(booked.status).toBe(201);
    const res = await api("GET", `/desk/appointments/${booked.data.id}/slip`, otherReception.token);
    expect(res.status).toBe(409);
    expect(res.code).toBe("NO_SLIP_TEMPLATE");
  });

  it("prints a whole day: one page per booked patient, in token order, and not the cancelled", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    await ensureTemplate();
    const doctorId = await createDoctor(world, 10_000);
    const dr = await createStaffUser(world, "DOCTOR", { doctorId });
    const patients = take(5);
    const ids: string[] = [];
    for (const p of patients) ids.push(await onlineToday(p, doctorId));
    await api("POST", `/desk/appointments/${ids[0]}/cancel`, reception.token, {
      initiator: "HOSPITAL",
    });
    await api("POST", `/desk/appointments/${ids[1]}/check-in`, reception.token);
    await api("POST", `/desk/appointments/${ids[1]}/start`, dr.token, {});
    await api("POST", `/desk/appointments/${ids[1]}/complete`, dr.token);

    const open = await api("POST", "/desk/slips", reception.token, { doctorId });
    expect(open.status).toBe(200);
    expect(await pages(open.bytes)).toBe(3); // 5 booked, minus 1 cancelled, minus 1 already seen
    const everyone = await api("POST", "/desk/slips", reception.token, {
      doctorId,
      includeCompleted: true,
    });
    expect(await pages(everyone.bytes)).toBe(4);
    const chosen = await api("POST", "/desk/slips", reception.token, {
      appointmentIds: [ids[2], ids[3]],
    });
    expect(await pages(chosen.bytes)).toBe(2);
    expect(
      await prisma.auditLog.count({
        where: { action: "slip.printed", entityId: world.hospitalId, actorId: reception.userId },
      }),
    ).toBeGreaterThanOrEqual(3);

    // The cancelled booking can't be printed individually either.
    expect((await api("GET", `/desk/appointments/${ids[0]}/slip`, reception.token)).status).toBe(
      404,
    );
  });

  it("keeps hospitals and doctors apart when printing", async (ctx) => {
    if (nearMidnight()) ctx.skip();
    await ensureTemplate();
    const doctorA = await createDoctor(world, 10_000);
    const drA = await createStaffUser(world, "DOCTOR", { doctorId: doctorA });
    const doctorB = await createDoctor(world, 10_000);
    const [a, b] = take(2);
    const idA = await onlineToday(a!, doctorA);
    const idB = await onlineToday(b!, doctorB);

    // Another hospital can neither print these nor learn that they exist.
    const foreign = await api("POST", "/desk/slips", otherReception.token, {
      appointmentIds: [idA, idB],
    });
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe("NOTHING_TO_PRINT");

    expect((await api("GET", `/desk/appointments/${idA}/slip`, drA.token)).status).toBe(200);
    expect((await api("GET", `/desk/appointments/${idB}/slip`, drA.token)).status).toBe(404);
    expect((await api("POST", "/desk/slips", drA.token, { doctorId: doctorB })).status).toBe(404);
    const own = await api("POST", "/desk/slips", drA.token, {});
    expect(await pages(own.bytes)).toBe(1); // a doctor's "print all" is their own patients only
    expect((await api("POST", "/desk/slips", reception.token, { appointmentIds: [] })).status).toBe(
      400,
    );
  });

  it("lists the templates for the desk and rejects an unknown one", async () => {
    await ensureTemplate();
    const list = await api("GET", "/desk/slip-templates", reception.token);
    expect(list.data.items.length).toBeGreaterThanOrEqual(1);
    expect(list.text).not.toContain("fields"); // the desk needs names and paper sizes, not layouts
    const [p] = take(1);
    if (!nearMidnight()) {
      const id = await onlineToday(p!, world.doctorId);
      const res = await api(
        "GET",
        `/desk/appointments/${id}/slip?templateId=00000000-0000-7000-8000-000000000000`,
        reception.token,
      );
      expect(res.code).toBe("TEMPLATE_NOT_FOUND");
    }
  });
});

describe("the emergency finder", () => {
  const city = `Testville${Date.now().toString(36)}`;
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  let names: { near: string; far: string; nowhere: string };

  beforeAll(async () => {
    const make = async (data: Record<string, unknown>) => {
      const h = await prisma.hospital.create({
        data: {
          slug: `em-${Math.random().toString(36).slice(2, 10)}`,
          city,
          ...(data as object),
        } as Parameters<typeof prisma.hospital.create>[0]["data"],
      });
      extraHospitals.push(h.id);
      return h;
    };
    const near = await make({
      name: `${city} Near`,
      status: "ACTIVE",
      latitude: 28.5677,
      longitude: 77.2433,
      emergencyPhone: "+911140000911",
      phone: "+911140000000",
      totalBeds: 100,
      availableBeds: 5,
      bedsUpdatedAt: new Date(),
      email: "secret@example.com",
      commissionPercent: 12,
    });
    const far = await make({
      name: `${city} Far`,
      status: "ACTIVE",
      latitude: 19.076,
      longitude: 72.8777,
      phone: "+912200000000",
      totalBeds: 50,
      availableBeds: 20,
      bedsUpdatedAt: daysAgo(3),
    });
    const nowhere = await make({
      name: `${city} Nowhere`,
      status: "ACTIVE",
      phone: "+919999999999",
    });
    await make({
      name: `${city} Pending`,
      status: "PENDING_APPROVAL",
      latitude: 28.6139,
      longitude: 77.209,
    });
    await make({
      name: `${city} Blocked`,
      status: "BLOCKED",
      latitude: 28.6139,
      longitude: 77.209,
    });
    names = { near: near.name, far: far.name, nowhere: nowhere.name };
  });

  it("lists open hospitals nearest first, with a way to call and the bed situation", async () => {
    const res = await api("GET", `/public/emergency?lat=28.6139&lng=77.209&city=${city}`);
    expect(res.status).toBe(200);
    expect(res.data.located).toBe(true);
    expect(res.data.items.map((h: { name: string }) => h.name)).toEqual([
      names.near,
      names.far,
      names.nowhere,
    ]);
    const [near, far, nowhere] = res.data.items;
    expect(near.distanceKm).toBeGreaterThan(5);
    expect(near.distanceKm).toBeLessThan(8);
    expect(far.distanceKm).toBeGreaterThan(1100);
    expect(nowhere.distanceKm).toBeNull(); // no coordinates: listed last, not dropped
    expect(near).toMatchObject({
      callNumber: "+911140000911",
      hasEmergencyLine: true,
      availableBeds: 5,
      totalBeds: 100,
      bedsStale: false,
    });
    expect(far).toMatchObject({
      callNumber: "+912200000000",
      hasEmergencyLine: false,
      bedsStale: true,
    });
    expect(nowhere.bedsStale).toBe(true); // never updated
  });

  it("never lists pending or blocked hospitals, and exposes nothing internal", async () => {
    const res = await api("GET", `/public/emergency?city=${city}`);
    expect(res.text).not.toContain("Pending");
    expect(res.text).not.toContain("Blocked");
    for (const secret of ["secret@example.com", "commission", "email", "razorpay"])
      expect(res.text).not.toContain(secret);
  });

  it("works without a location: alphabetical, and not marked as located", async () => {
    const res = await api("GET", `/public/emergency?city=${city}`);
    expect(res.data.located).toBe(false);
    expect(res.data.items.map((h: { name: string }) => h.name)).toEqual([
      names.far,
      names.near,
      names.nowhere,
    ]);
  });

  it("respects the limit and the city, and checks its inputs", async () => {
    expect(
      (await api("GET", `/public/emergency?lat=28.6&lng=77.2&city=${city}&limit=1`)).data.items,
    ).toHaveLength(1);
    expect(
      (await api("GET", `/public/emergency?city=${city.toUpperCase()}`)).data.items,
    ).toHaveLength(3); // case-insensitive
    expect(
      (await api("GET", "/public/emergency?city=NoSuchPlaceAnywhere")).data.items,
    ).toHaveLength(0);
    expect((await api("GET", "/public/emergency?lat=999&lng=77")).status).toBe(400);
    expect((await api("GET", "/public/emergency?lat=28.6")).status).toBe(400);
    expect((await api("GET", "/public/emergency?limit=500")).status).toBe(400);
  });
});
