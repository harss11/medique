/**
 * The patient's language, end to end: choosing it, and getting SMS in it. On a real PostgreSQL.
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import {
  setSmsProviderOverride,
  type SmsMessage,
  type SmsProvider,
} from "../../services/sms/index.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cancelAppointment,
  confirmAppointment,
  lockSlot,
} from "../appointments/booking.service.js";
import {
  dispatchNotifications,
  enqueueAppointmentMessage,
  enqueueGroupMessages,
} from "./notifications.service.js";
import {
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

const DEVANAGARI = /[ऀ-ॿ]/;

let server: Server;
let base: string;
let world: World;
let makeSlot: ReturnType<typeof slotFactory>;
let hindi: Patient;
let english: Patient;
let reception: Staff;
const sent: SmsMessage[] = [];

const recorder: SmsProvider = {
  name: "recorder",
  supportsWhatsApp: true,
  async send(message) {
    sent.push(message);
    return { providerMessageId: `rec-${sent.length}` };
  },
};

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
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
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return { status: res.status, data: json?.data };
}

const tokenOf = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

async function phoneOf(p: Patient) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).phone!;
}

/** A confirmed booking. Each one is with a new doctor: one patient cannot hold two seats with one doctor a day. */
async function book(p: Patient) {
  const slot = await makeSlot({ doctorId: await createDoctor(world) });
  const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, {});
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  return hold.id;
}

const messagesTo = (phone: string, template?: string) =>
  sent.filter((m) => m.to === phone && (!template || m.template === template));

beforeAll(async () => {
  world = await createWorld();
  makeSlot = slotFactory(world);
  [hindi, english] = (await createPatients(world, 2)) as [Patient, Patient];
  reception = await createStaffUser(world, "RECEPTIONIST");
  setSmsProviderOverride(recorder);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  setSmsProviderOverride(null);
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("choosing a language", () => {
  it("is saved for the patient and shown on their account", async () => {
    const before = await http("GET", "/auth/me", tokenOf(hindi));
    expect(before.data.language).toBe("en");
    const r = await http("PATCH", "/patient/account/language", tokenOf(hindi), { language: "hi" });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ language: "hi" });
    expect((await http("GET", "/auth/me", tokenOf(hindi))).data.language).toBe("hi");
    // the other patient is untouched
    expect((await http("GET", "/auth/me", tokenOf(english))).data.language).toBe("en");
  });

  it("accepts only languages we have, and only from a signed-in patient", async () => {
    for (const language of ["fr", "", null, 5]) {
      expect(
        (await http("PATCH", "/patient/account/language", tokenOf(hindi), { language })).status,
      ).toBe(400);
    }
    expect((await http("PATCH", "/patient/account/language", tokenOf(hindi), {})).status).toBe(400);
    expect(
      (await http("PATCH", "/patient/account/language", undefined, { language: "hi" })).status,
    ).toBe(401);
    expect(
      (await http("PATCH", "/patient/account/language", reception.token, { language: "hi" }))
        .status,
    ).toBe(403);
  });
});

describe("messages in the patient's language", () => {
  it("sends the booking confirmation in Hindi to a Hindi patient and English to the others", async () => {
    const hiId = await book(hindi);
    const enId = await book(english);
    const rows = await prisma.notificationLog.findMany({
      where: { appointmentId: { in: [hiId, enId] }, template: "booking_confirmed" },
    });
    expect(rows.find((r) => r.appointmentId === hiId)?.language).toBe("hi");
    expect(rows.find((r) => r.appointmentId === enId)?.language).toBe("en");

    await dispatchNotifications(100);
    const toHindi = messagesTo(await phoneOf(hindi), "booking_confirmed").at(-1)!;
    expect(toHindi.language).toBe("hi");
    expect(toHindi.body).toMatch(DEVANAGARI);
    expect(toHindi.body).toContain("Patient"); // the name is not translated
    expect(toHindi.variables).toMatchObject({ token: expect.any(String) });

    const toEnglish = messagesTo(await phoneOf(english), "booking_confirmed").at(-1)!;
    expect(toEnglish.language).toBe("en");
    expect(toEnglish.body).not.toMatch(DEVANAGARI);
    expect(toEnglish.body).toContain("Booking confirmed");
  });

  it("keeps the language a message was queued in if the patient switches later", async () => {
    const id = await book(english);
    await prisma.user.update({ where: { id: english.userId }, data: { language: "hi" } });
    try {
      await dispatchNotifications(100);
      expect(messagesTo(await phoneOf(english), "booking_confirmed").at(-1)!.body).not.toMatch(
        DEVANAGARI,
      );
      // The next message uses the new choice.
      await cancelAppointment(english.auth, id, null, {});
      await dispatchNotifications(100);
      const cancelled = messagesTo(await phoneOf(english), "appointment_cancelled").at(-1)!;
      expect(cancelled.language).toBe("hi");
      expect(cancelled.body).toMatch(DEVANAGARI);
    } finally {
      await prisma.user.update({ where: { id: english.userId }, data: { language: "en" } });
    }
  });

  it("says what happened to the money in the same language", async () => {
    const id = await book(hindi);
    await enqueueAppointmentMessage(prisma, id, "appointment_rescheduled");
    await prisma.notificationLog.deleteMany({
      where: { appointmentId: id, template: "appointment_cancelled" },
    });
    await enqueueAppointmentMessage(
      prisma,
      id,
      "appointment_cancelled",
      {},
      { kind: "ONLINE", amountText: "Rs.500" },
    );
    await dispatchNotifications(100);
    const m = messagesTo(await phoneOf(hindi), "appointment_cancelled").at(-1)!;
    expect(m.body).toContain("Rs.500");
    expect(m.body).toMatch(/रिफंड/);
    expect(m.variables?.refund).toMatch(/रिफंड/);
  });

  it("group messages use the language of a known user, and English for a bare phone number", async () => {
    await enqueueGroupMessages(prisma, [
      {
        groupKey: "lang-test:1",
        to: await phoneOf(hindi),
        userId: hindi.userId,
        template: "waitlist_slot_open",
        vars: { name: "A", doctor: "Dr B", hospital: "C", date: "1 Jan" },
      },
      {
        groupKey: "lang-test:1",
        to: "+910000000001",
        template: "waitlist_slot_open",
        vars: { name: "A", doctor: "Dr B", hospital: "C", date: "1 Jan" },
      },
      {
        groupKey: "lang-test:1",
        to: "+910000000002",
        template: "waitlist_slot_open",
        language: "hi",
        vars: { name: "A", doctor: "Dr B", hospital: "C", date: "1 Jan" },
      },
    ]);
    try {
      await dispatchNotifications(100);
      expect(messagesTo(await phoneOf(hindi), "waitlist_slot_open").at(-1)!.body).toMatch(
        DEVANAGARI,
      );
      expect(messagesTo("+910000000001")[0]!.body).not.toMatch(DEVANAGARI);
      expect(messagesTo("+910000000002")[0]!.body).toMatch(DEVANAGARI);
    } finally {
      await prisma.notificationLog.deleteMany({ where: { groupKey: "lang-test:1" } });
    }
  });
});
