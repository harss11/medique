/**
 * Messages (outbox, retries, reminders) and PDF receipts, on a real PostgreSQL.
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  mockOutbox,
  setSmsProviderOverride,
  SmsError,
  type SmsMessage,
  type SmsProvider,
} from "../../services/sms/index.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cancelAppointment,
  confirmAppointment,
  lockSlot,
  rescheduleAppointment,
} from "../appointments/booking.service.js";
import { processDueRefunds } from "../payments/refunds.service.js";
import {
  dispatchNotifications,
  enqueueAppointmentMessage,
  enqueueDueReminders,
  MAX_ATTEMPTS,
} from "./notifications.service.js";
import {
  cleanup,
  createDoctor,
  createPatients,
  createWorld,
  slotFactory,
  type Patient,
  type World,
} from "../../../test/fixtures.js";
import { until, useFakeRazorpay } from "../../../test/payments-helpers.js";

const META = {};
let world: World;
let makeSlot: ReturnType<typeof slotFactory>;
let pool: Patient[];
let cursor = 0;
let server: Server;
let base: string;

const take = (n: number) => {
  const out = pool.slice(cursor, cursor + n);
  cursor += n;
  return out;
};
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
const tokenFor = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

/** A held appointment, optionally paid for. */
async function booking(
  p: Patient,
  options: { startAt?: Date; paid?: boolean; doctorId?: string } = {},
) {
  const slot = await makeSlot({
    ...(options.startAt ? { startAt: options.startAt } : {}),
    ...(options.doctorId ? { doctorId: options.doctorId } : {}),
  });
  const hold = await lockSlot(p.auth, { slotId: slot.id, patientProfileId: p.profileId }, META);
  if (options.paid !== false && hold.status === "PENDING_PAYMENT") {
    await confirmAppointment(
      hold.id,
      {
        provider: "RAZORPAY",
        method: "ONLINE",
        razorpayPaymentId: `pay_${hold.id}`,
        providerMethod: "upi",
      },
      null,
    );
  }
  return hold.id;
}

const rowsFor = (appointmentId: string, template?: string) =>
  prisma.notificationLog.findMany({ where: { appointmentId, ...(template ? { template } : {}) } });
const phoneOf = async (p: Patient) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).phone!;
const sentTo = (phone: string) => mockOutbox.filter((m) => m.to === phone);
/** Wait for the background dispatcher (kicked after a commit) to deliver this appointment's message. */
const delivered = (appointmentId: string, template: string) =>
  until(async () => (await rowsFor(appointmentId, template)).find((r) => r.status === "SENT"));

beforeAll(async () => {
  useFakeRazorpay();
  world = await createWorld();
  makeSlot = slotFactory(world);
  pool = await createPatients(world, 80);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  setSmsProviderOverride(null);
  env.NOTIFICATION_CHANNEL = "SMS";
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("booking confirmation message", () => {
  it("is queued with the booking, sent to the patient's phone, and says what they need", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    const row = await delivered(id, "booking_confirmed");

    const phone = await phoneOf(p!);
    expect(row).toMatchObject({
      to: phone,
      status: "SENT",
      channel: "SMS",
      provider: "mock",
      attempts: 1,
      userId: p!.userId,
    });
    expect(row.providerMessageId).toBeTruthy();
    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { id },
      include: { doctor: true, hospital: true },
    });
    const messages = sentTo(phone).filter((m) => m.template === "booking_confirmed");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain(appt.doctor.name);
    expect(messages[0]!.body).toContain(appt.hospital.name);
    expect(messages[0]!.body).toContain(`Token ${appt.tokenNumber}`);
    expect(messages[0]!.body).toMatch(/ \d{1,2}:\d{2} (am|pm)\./); // time in the hospital's timezone
    expect(messages[0]!.variables).toMatchObject({
      doctor: appt.doctor.name,
      token: String(appt.tokenNumber),
    });
  });

  it("is also sent for a free appointment", async () => {
    const [p] = take(1);
    const free = await createDoctor(world, 0);
    const id = await booking(p!, { doctorId: free, paid: false });
    expect((await delivered(id, "booking_confirmed")).status).toBe("SENT");
  });

  it("is never sent for an unpaid hold", async () => {
    const [p] = take(1);
    const id = await booking(p!, { paid: false });
    await dispatchNotifications();
    expect(await rowsFor(id)).toHaveLength(0);
  });
});

describe("the outbox", () => {
  it("queues each message once however often it is asked", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    await delivered(id, "booking_confirmed");
    expect(await enqueueAppointmentMessage(prisma, id, "appointment_reminder")).toBe(true);
    expect(await enqueueAppointmentMessage(prisma, id, "appointment_reminder")).toBe(false);
    expect(await rowsFor(id, "appointment_reminder")).toHaveLength(1);
    await dispatchNotifications();
    await dispatchNotifications();
    expect(
      sentTo(await phoneOf(p!)).filter((m) => m.template === "appointment_reminder"),
    ).toHaveLength(1);
  });

  it("writes nothing if the surrounding transaction rolls back", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    await delivered(id, "booking_confirmed");
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueAppointmentMessage(tx, id, "appointment_reminder");
        throw new Error("something else failed");
      }),
    ).rejects.toThrow("something else failed");
    expect(await rowsFor(id, "appointment_reminder")).toHaveLength(0);
  });

  it("four dispatchers running at once send every message exactly once", async () => {
    const patients = take(5);
    const ids = await Promise.all(patients.map((p) => booking(p)));
    await Promise.all(ids.map((id) => delivered(id, "booking_confirmed")));
    const templates = [
      "appointment_reminder",
      "appointment_cancelled",
      "appointment_rescheduled",
    ] as const;
    for (const id of ids)
      for (const t of templates) await enqueueAppointmentMessage(prisma, id, t, { refund: "" });

    await Promise.all(Array.from({ length: 4 }, () => dispatchNotifications(50)));
    await dispatchNotifications(50); // mop up anything a lease skipped

    for (const [i, p] of patients.entries()) {
      const rows = await rowsFor(ids[i]!);
      expect(rows.every((r) => r.status === "SENT")).toBe(true);
      for (const t of templates) {
        expect(sentTo(await phoneOf(p)).filter((m) => m.template === t)).toHaveLength(1);
      }
    }
  });

  it("uses WhatsApp when the channel is switched", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    await delivered(id, "booking_confirmed");
    env.NOTIFICATION_CHANNEL = "WHATSAPP";
    try {
      await enqueueAppointmentMessage(prisma, id, "appointment_reminder");
    } finally {
      env.NOTIFICATION_CHANNEL = "SMS";
    }
    await dispatchNotifications();
    expect(
      sentTo(await phoneOf(p!)).find((m) => m.template === "appointment_reminder")?.channel,
    ).toBe("WHATSAPP");
  });
});

describe("a provider outage", () => {
  const failing = (): SmsProvider & { calls: number; fail: boolean } => ({
    name: "flaky",
    supportsWhatsApp: false,
    calls: 0,
    fail: true,
    async send(message: SmsMessage) {
      this.calls++;
      if (this.fail) throw new SmsError("provider down");
      mockOutbox.push(message);
      return { providerMessageId: "ok-1" };
    },
  });

  it("is retried with backoff, then delivered when the provider recovers", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    await delivered(id, "booking_confirmed");
    const provider = failing();
    setSmsProviderOverride(provider);
    try {
      await enqueueAppointmentMessage(prisma, id, "appointment_reminder");
      await dispatchNotifications();
      const failed = (await rowsFor(id, "appointment_reminder"))[0]!;
      expect(failed).toMatchObject({ status: "FAILED", attempts: 1, error: "provider down" });
      expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

      await dispatchNotifications(); // not due yet: the provider is not hammered
      expect(provider.calls).toBe(1);

      provider.fail = false;
      await prisma.notificationLog.update({
        where: { id: failed.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await dispatchNotifications();
      expect(
        await prisma.notificationLog.findUniqueOrThrow({ where: { id: failed.id } }),
      ).toMatchObject({
        status: "SENT",
        attempts: 2,
        error: null,
        providerMessageId: "ok-1",
      });
    } finally {
      setSmsProviderOverride(null);
    }
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts instead of retrying forever`, async () => {
    const [p] = take(1);
    const id = await booking(p!);
    await delivered(id, "booking_confirmed");
    const provider = failing();
    setSmsProviderOverride(provider);
    try {
      await enqueueAppointmentMessage(prisma, id, "appointment_reminder");
      const rowId = (await rowsFor(id, "appointment_reminder"))[0]!.id;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await prisma.notificationLog.update({
          where: { id: rowId },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
        await dispatchNotifications();
      }
      expect(provider.calls).toBe(MAX_ATTEMPTS);
      expect(
        await prisma.notificationLog.findUniqueOrThrow({ where: { id: rowId } }),
      ).toMatchObject({
        status: "FAILED",
        attempts: MAX_ATTEMPTS,
        nextAttemptAt: null, // no further retry is scheduled
      });
      // Even if someone forces it to be due, it is not picked up again.
      await prisma.notificationLog.update({
        where: { id: rowId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await dispatchNotifications();
      expect(provider.calls).toBe(MAX_ATTEMPTS);
    } finally {
      setSmsProviderOverride(null);
    }
  });
});

describe("cancellation, rescheduling and the messages they send", () => {
  it("tells the patient the refund they will get", async () => {
    const cases: Array<[string, Date | undefined, string]> = [
      ["full refund", undefined, "Refund of Rs.500 will reach your account in 5-7 days."],
      ["half refund", hoursFromNow(5), "Refund of Rs.250 will reach your account in 5-7 days."],
    ];
    for (const [, startAt, expected] of cases) {
      const [p] = take(1);
      const id = await booking(p!, { startAt });
      await cancelAppointment(p!.auth, id, null, META);
      await delivered(id, "appointment_cancelled");
      expect(
        sentTo(await phoneOf(p!)).find((m) => m.template === "appointment_cancelled")!.body,
      ).toContain(expected);
    }
  });

  it("says no refund applies when the policy gives none", async () => {
    await prisma.hospital.update({
      where: { id: world.hospitalId },
      data: { refundPartialPercent: 0 },
    });
    try {
      const [p] = take(1);
      const id = await booking(p!, { startAt: hoursFromNow(5) });
      await cancelAppointment(p!.auth, id, null, META);
      await delivered(id, "appointment_cancelled");
      expect(
        sentTo(await phoneOf(p!)).find((m) => m.template === "appointment_cancelled")!.body,
      ).toContain("No refund applies");
    } finally {
      await prisma.hospital.update({
        where: { id: world.hospitalId },
        data: { refundPartialPercent: 50 },
      });
    }
  });

  it("says nothing about refunds for a free appointment, and sends nothing for an abandoned hold", async () => {
    const [a, b] = take(2);
    const free = await booking(a!, { doctorId: await createDoctor(world, 0), paid: false });
    await cancelAppointment(a!.auth, free, null, META);
    await delivered(free, "appointment_cancelled");
    const body = sentTo(await phoneOf(a!)).find(
      (m) => m.template === "appointment_cancelled",
    )!.body;
    expect(body).not.toMatch(/refund/i);

    const hold = await booking(b!, { paid: false });
    await cancelAppointment(b!.auth, hold, null, META);
    await dispatchNotifications();
    expect(await rowsFor(hold)).toHaveLength(0);
  });

  it("sends the new time and token when an appointment is rescheduled", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    const target = await makeSlot({ dayOffset: 9 });
    const moved = await rescheduleAppointment(p!.auth, id, target.id, META);
    await delivered(moved.id, "appointment_rescheduled");
    const message = sentTo(await phoneOf(p!)).find(
      (m) => m.template === "appointment_rescheduled",
    )!;
    expect(message.body).toContain(`new token is ${moved.tokenNumber}`);
    expect(message.body).toContain("9:00 am");
  });
});

describe("reminders", () => {
  /** Makes an appointment look like it was booked `bookedHoursAgo` ago for a slot `startsInHours` away. */
  async function appointmentAt(p: Patient, startsInHours: number, bookedHoursAgo: number) {
    const id = await booking(p);
    await delivered(id, "booking_confirmed");
    await prisma.appointment.update({
      where: { id },
      data: { slotStart: hoursFromNow(startsInHours), confirmedAt: hoursFromNow(-bookedHoursAgo) },
    });
    return id;
  }

  it("goes out once, to appointments starting within 2 hours that were booked earlier", async () => {
    const [p] = take(1);
    const id = await appointmentAt(p!, 1.5, 24);
    await enqueueDueReminders();
    await enqueueDueReminders();
    const rows = await rowsFor(id, "appointment_reminder");
    expect(rows).toHaveLength(1);

    await dispatchNotifications();
    const message = sentTo(await phoneOf(p!)).find((m) => m.template === "appointment_reminder")!;
    expect(message.body).toMatch(
      /^MediQ reminder: .+ is today at \d{1,2}:\d{2} (am|pm)\. Token \d+\.$/,
    );
  });

  it("skips appointments that are too far away, were booked inside the window, or are no longer confirmed", async () => {
    const [a, b, c, d] = take(4);
    const far = await appointmentAt(a!, 5, 24);
    const lateBooking = await appointmentAt(b!, 1, 0.1); // booked 6 minutes ago for an hour from now
    const cancelled = await appointmentAt(c!, 1.5, 24);
    await prisma.appointment.update({
      where: { id: cancelled },
      data: { status: "CANCELLED", seatNumber: null },
    });
    const past = await appointmentAt(d!, -1, 24);
    await enqueueDueReminders();
    for (const id of [far, lateBooking, cancelled, past])
      expect(await rowsFor(id, "appointment_reminder")).toHaveLength(0);
  });

  it("is picked up once the appointment enters the window", async () => {
    const [p] = take(1);
    const id = await appointmentAt(p!, 3, 24);
    await enqueueDueReminders();
    expect(await rowsFor(id, "appointment_reminder")).toHaveLength(0);
    await prisma.appointment.update({ where: { id }, data: { slotStart: hoursFromNow(1.9) } });
    await enqueueDueReminders();
    expect(await rowsFor(id, "appointment_reminder")).toHaveLength(1);
  });
});

describe("PDF receipt", () => {
  const getReceipt = async (id: string, token?: string) => {
    const res = await fetch(`${base}/appointments/${id}/receipt`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      cache: res.headers.get("cache-control"),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  };

  it("downloads as a PDF for the patient's own paid appointment", async () => {
    const [p] = take(1);
    const id = await booking(p!);
    const res = await getReceipt(id, tokenFor(p!));
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/pdf");
    expect(res.disposition).toMatch(/^inline; filename="receipt-MQ-\d{6}-[0-9A-F]{8}\.pdf"$/);
    expect(res.cache).toBe("no-store");
    expect(res.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(res.bytes.length).toBeGreaterThan(3_000);
  });

  it("copes with Hindi names and shows refunds", async () => {
    const [p] = take(1);
    await prisma.patientProfile.update({
      where: { id: p!.profileId },
      data: { fullName: "राहुल शर्मा" },
    });
    const id = await booking(p!, { startAt: hoursFromNow(5) });
    await cancelAppointment(p!.auth, id, null, META);
    await processDueRefunds();
    const res = await getReceipt(id, tokenFor(p!));
    expect(res.status).toBe(200);
    expect(res.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("is refused for strangers, anonymous visitors, unpaid holds and free appointments", async () => {
    const [a, b, c, d] = take(4);
    const paid = await booking(a!);
    expect((await getReceipt(paid, tokenFor(b!))).status).toBe(404);
    expect((await getReceipt(paid)).status).toBe(401);

    const hold = await booking(c!, { paid: false });
    expect((await getReceipt(hold, tokenFor(c!))).status).toBe(404);

    const free = await booking(d!, { doctorId: await createDoctor(world, 0), paid: false });
    expect((await getReceipt(free, tokenFor(d!))).status).toBe(404);
  });
});
