/**
 * The waitlist through the real HTTP API and the notification job: joining a full day, order,
 * who is told, what happens when nobody answers, and that nobody is told twice.
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { addDays, dateOnly, todayInZone } from "../../utils/time.js";
import {
  cancelAppointment,
  confirmAppointment,
  lockSlot,
} from "../appointments/booking.service.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  TZ,
  cleanup,
  createDoctor,
  createPatients,
  createWorld,
  slotFactory,
  type Patient,
  type World,
} from "../../../test/fixtures.js";
import { notifyWaitlists } from "./waitlist.service.js";

let server: Server;
let base: string;
let world: World;
let makeSlot: ReturnType<typeof slotFactory>;
let patients: Patient[];
const tokens = new Map<string, string>();

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

const tokenOf = (p: Patient) => tokens.get(p.userId)!;
const dayStr = (offset: number) => addDays(todayInZone(TZ), offset);

/** A doctor whose one-seat slot on `dayOffset` is already taken by `holder`. */
async function fullDay(holder: Patient, dayOffset = 4) {
  const doctorId = await createDoctor(world);
  const slot = await makeSlot({ doctorId, dayOffset, capacity: 1 });
  const hold = await lockSlot(
    holder.auth,
    { slotId: slot.id, patientProfileId: holder.profileId },
    {},
  );
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  return { doctorId, slot, appointmentId: hold.id, date: dayStr(dayOffset) };
}

const join = (p: Patient, doctorId: string, date: string, profileId = p.profileId) =>
  http("POST", "/waitlist", tokenOf(p), { doctorId, date, patientProfileId: profileId });

beforeAll(async () => {
  world = await createWorld();
  makeSlot = slotFactory(world);
  patients = await createPatients(world, 6);
  for (const p of patients) {
    tokens.set(
      p.userId,
      signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token,
    );
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("joining the waitlist", () => {
  it("is allowed only for a day that is full", async () => {
    const [a, b] = patients as [Patient, Patient];
    const open = await createDoctor(world);
    await makeSlot({ doctorId: open, dayOffset: 4, capacity: 2 });
    const free = await join(b, open, dayStr(4));
    expect(free.status).toBe(409);
    expect(free.code).toBe("SLOTS_AVAILABLE");

    const empty = await createDoctor(world);
    expect((await join(b, empty, dayStr(4))).code).toBe("NO_SLOTS");

    const full = await fullDay(a);
    const avail = await http("GET", `/public/doctors/${full.doctorId}/availability`);
    expect(avail.data.dates).toEqual([]);
    expect(avail.data.fullDates).toEqual([full.date]);
    const ok = await join(b, full.doctorId, full.date);
    expect(ok.status).toBe(201);
    expect(ok.data.id).toBeTruthy();
  });

  it("refuses the past, days beyond the booking window, other people's profiles and a bad body", async () => {
    const [a, b, c] = patients as [Patient, Patient, Patient];
    const full = await fullDay(a, 5);
    expect((await join(b, full.doctorId, dayStr(-1))).status).toBe(400);
    expect((await join(b, full.doctorId, dayStr(env.SLOT_WINDOW_DAYS + 2))).code).toBe(
      "DATE_OUT_OF_RANGE",
    );
    expect((await join(b, full.doctorId, full.date, c.profileId)).code).toBe("PROFILE_NOT_FOUND");
    expect(
      (await http("POST", "/waitlist", tokenOf(b), { doctorId: "nope", date: "x" })).status,
    ).toBe(400);
    expect((await http("POST", "/waitlist", undefined, {})).status).toBe(401);
    expect((await http("GET", "/waitlist")).status).toBe(401);
  });

  it("is refused for somebody who already has a seat that day, and for a second time", async () => {
    const [a, b] = patients as [Patient, Patient];
    const full = await fullDay(a, 6);
    expect((await join(a, full.doctorId, full.date)).code).toBe("ALREADY_BOOKED");
    expect((await join(b, full.doctorId, full.date)).status).toBe(201);
    const again = await join(b, full.doctorId, full.date);
    expect(again.status).toBe(409);
    expect(again.code).toBe("ALREADY_ON_WAITLIST");
  });

  it("limits how many days one patient waits for", async () => {
    const [a, , c] = patients as [Patient, Patient, Patient];
    const limit = env.WAITLIST_MAX_ACTIVE_PER_USER;
    env.WAITLIST_MAX_ACTIVE_PER_USER = 2;
    try {
      const days = [await fullDay(a, 7), await fullDay(a, 8), await fullDay(a, 9)];
      expect((await join(c, days[0]!.doctorId, days[0]!.date)).status).toBe(201);
      expect((await join(c, days[1]!.doctorId, days[1]!.date)).status).toBe(201);
      const third = await join(c, days[2]!.doctorId, days[2]!.date);
      expect(third.code).toBe("WAITLIST_LIMIT");
      // Leaving one makes room.
      const mine = await http("GET", "/waitlist", tokenOf(c));
      const first = mine.data.items[0].id as string;
      expect((await http("DELETE", `/waitlist/${first}`, tokenOf(c))).status).toBe(200);
      expect((await join(c, days[2]!.doctorId, days[2]!.date)).status).toBe(201);
    } finally {
      env.WAITLIST_MAX_ACTIVE_PER_USER = limit;
    }
  });
});

describe("my waitlist", () => {
  it("shows my place in line and can be left, by me only", async () => {
    const [a, b, c, d] = patients as [Patient, Patient, Patient, Patient];
    const full = await fullDay(a, 10);
    const idC = (await join(c, full.doctorId, full.date)).data.id as string;
    await join(d, full.doctorId, full.date);
    await join(b, full.doctorId, full.date);

    const forC = await http("GET", `/waitlist?scope=active`, tokenOf(c));
    const rowC = forC.data.items.find((i: { id: string }) => i.id === idC);
    expect(rowC).toMatchObject({
      status: "WAITING",
      position: 1,
      seatsOpen: false,
      date: full.date,
    });
    const forB = await http("GET", `/waitlist`, tokenOf(b));
    expect(
      forB.data.items.find((i: { doctor: { id: string } }) => i.doctor.id === full.doctorId)
        .position,
    ).toBe(3);
    expect(JSON.stringify(forB.data)).not.toContain(c.userId);

    // somebody else's entry looks like it does not exist
    expect((await http("DELETE", `/waitlist/${idC}`, tokenOf(b))).status).toBe(404);
    expect((await http("DELETE", `/waitlist/${idC}`, tokenOf(c))).status).toBe(200);
    const twice = await http("DELETE", `/waitlist/${idC}`, tokenOf(c));
    expect(twice.status).toBe(409);
    expect(twice.code).toBe("INVALID_STATUS");

    // the others move up
    const now = await http("GET", `/waitlist`, tokenOf(b));
    expect(
      now.data.items.find((i: { doctor: { id: string } }) => i.doctor.id === full.doctorId)
        .position,
    ).toBe(2);
  });
});

describe("telling people when a seat opens", () => {
  it("tells the first in line, once, and marks them booked when they book", async () => {
    const [a, b, c] = patients as [Patient, Patient, Patient];
    const full = await fullDay(a, 11);
    const first = (await join(b, full.doctorId, full.date)).data.id as string;
    const second = (await join(c, full.doctorId, full.date)).data.id as string;

    // Nothing is free yet, so nobody is told.
    await notifyWaitlists();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first } })).status).toBe(
      "WAITING",
    );

    await cancelAppointment(a.auth, full.appointmentId, null, {});
    const round = await notifyWaitlists();
    expect(round.told).toBeGreaterThanOrEqual(1);

    const one = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first } });
    const two = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: second } });
    expect(one.status).toBe("NOTIFIED");
    expect(one.notifiedAt).not.toBeNull();
    // One free seat, one patient told: the second keeps waiting.
    expect(two.status).toBe("WAITING");

    const messages = await prisma.notificationLog.findMany({
      where: { groupKey: `waitlist:${first}` },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ template: "waitlist_slot_open", channel: "SMS" });

    // Running the job again tells nobody and sends nothing twice.
    await notifyWaitlists();
    await notifyWaitlists();
    expect(await prisma.notificationLog.count({ where: { groupKey: `waitlist:${first}` } })).toBe(
      1,
    );
    expect(await prisma.notificationLog.count({ where: { groupKey: `waitlist:${second}` } })).toBe(
      0,
    );

    // The told patient books the seat: the wait is over.
    const hold = await lockSlot(
      b.auth,
      { slotId: full.slot.id, patientProfileId: b.profileId },
      {},
    );
    await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first } })).status).toBe(
      "BOOKED",
    );
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: second } })).status).toBe(
      "WAITING",
    );
  });

  it("moves on to the next patient when the told one does not book in time", async () => {
    const [a, b, c] = patients as [Patient, Patient, Patient];
    const full = await fullDay(a, 12);
    const first = (await join(b, full.doctorId, full.date)).data.id as string;
    const second = (await join(c, full.doctorId, full.date)).data.id as string;
    await cancelAppointment(a.auth, full.appointmentId, null, {});
    await notifyWaitlists();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first } })).status).toBe(
      "NOTIFIED",
    );

    await prisma.waitlistEntry.update({
      where: { id: first },
      data: { notifiedAt: new Date(Date.now() - (env.WAITLIST_NOTICE_MINUTES + 1) * 60_000) },
    });
    await notifyWaitlists();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first } })).status).toBe(
      "EXPIRED",
    );
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: second } })).status).toBe(
      "NOTIFIED",
    );

    // The one who lost their place can join again, at the back of the line.
    const mine = await http("GET", "/waitlist?scope=all", tokenOf(b));
    expect(mine.data.items.find((i: { id: string }) => i.id === first).status).toBe("EXPIRED");
    // While the seat is still free there is nothing to wait for: the patient is told to book it.
    expect((await join(b, full.doctorId, full.date)).code).toBe("SLOTS_AVAILABLE");
    // Once somebody else takes it, joining again works and starts at the back of the line.
    const other = patients[3]!;
    const hold = await lockSlot(
      other.auth,
      { slotId: full.slot.id, patientProfileId: other.profileId },
      {},
    );
    await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
    const back = await join(b, full.doctorId, full.date);
    expect(back.status).toBe(201);
    expect(back.data.id).toBe(first);
    const again = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first } });
    expect(again).toMatchObject({ status: "WAITING", notifiedAt: null });
  });

  it("tells several people when several seats open, never more than the batch", async () => {
    const [a, b, c, d, e, f] = patients as [Patient, Patient, Patient, Patient, Patient, Patient];
    const doctorId = await createDoctor(world);
    const slot = await makeSlot({ doctorId, dayOffset: 13, capacity: 5 });
    const holds: string[] = [];
    for (const p of [a, b, c, d, e]) {
      const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, {});
      await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
      holds.push(hold.id);
    }
    const date = dayStr(13);
    expect((await join(f, doctorId, date)).status).toBe(201);
    // three more waiting people from other accounts
    const extra = await createPatients(world, 3);
    for (const p of extra) {
      tokens.set(
        p.userId,
        signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token,
      );
      expect((await join(p, doctorId, date)).status).toBe(201);
    }
    // All five seats open at once. Four people wait: the batch is told first, the rest next round.
    for (const id of holds)
      await cancelAppointment(patients[holds.indexOf(id)]!.auth, id, null, {});
    await notifyWaitlists();
    const told = await prisma.waitlistEntry.count({ where: { doctorId, status: "NOTIFIED" } });
    expect(told).toBe(env.WAITLIST_NOTIFY_BATCH);
    await notifyWaitlists();
    expect(await prisma.waitlistEntry.count({ where: { doctorId, status: "NOTIFIED" } })).toBe(4);
  });

  it("ends waits for days that have passed", async () => {
    const b = patients[1]!;
    const doctorId = await createDoctor(world);
    const entry = await prisma.waitlistEntry.create({
      data: {
        doctorId,
        date: dateOnly(dayStr(-1)),
        patientProfileId: b.profileId,
        userId: b.userId,
      },
    });
    await notifyWaitlists();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe(
      "EXPIRED",
    );
  });
});
