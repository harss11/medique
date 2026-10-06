/**
 * Money paths, on a real PostgreSQL with a fake Razorpay (no network):
 * signed webhooks, order creation, failed and duplicate payments, refunds by policy.
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { GatewayError } from "../../services/payment/index.js";
import type { AppError } from "../../utils/http.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cancelAppointment,
  lockSlot,
  rescheduleAppointment,
} from "../appointments/booking.service.js";
import { createPaymentOrder } from "./payments.service.js";
import { processDueRefunds, processRefund, queueRefund } from "./refunds.service.js";
import {
  cleanup,
  createDoctor,
  createPatients,
  createWorld,
  slotFactory,
  type Patient,
  type World,
} from "../../../test/fixtures.js";
import type { FakeRazorpay } from "../../../test/payments-helpers.js";
import {
  WEBHOOK_SECRET,
  paymentEvent,
  postWebhook,
  refundEvent,
  until,
  useFakeRazorpay,
} from "../../../test/payments-helpers.js";

const META = {};
const FEE = 50_000;

let server: Server;
let base: string;
let world: World;
let makeSlot: ReturnType<typeof slotFactory>;
let pool: Patient[];
let cursor = 0;
let fake: FakeRazorpay;

const take = (n: number) => {
  const out = pool.slice(cursor, cursor + n);
  cursor += n;
  if (out.length < n) throw new Error("test patient pool exhausted");
  return out;
};

const tokenFor = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** Books a slot up to the point of paying: a held appointment with a Razorpay order. */
async function startPayment(p: Patient, slotId: string) {
  const hold = await lockSlot(p.auth, { slotId, patientProfileId: p.profileId }, META);
  const order = await createPaymentOrder(p.auth, hold.id);
  if (order.mode !== "razorpay") throw new Error("expected Razorpay mode");
  return { appointmentId: hold.id, orderId: order.orderId };
}

/** Razorpay tells us the payment was captured. */
const capture = (
  orderId: string,
  extra: { paymentId?: string; amount?: number; eventId?: string } = {},
) =>
  postWebhook(
    base,
    paymentEvent("payment.captured", {
      orderId,
      amount: extra.amount ?? FEE,
      paymentId: extra.paymentId,
    }),
    {
      eventId: extra.eventId,
    },
  );

async function paid(p: Patient, slotId: string) {
  const started = await startPayment(p, slotId);
  const paymentId = `pay_fake_${started.orderId}`;
  const reply = await capture(started.orderId, { paymentId });
  expect(reply.status).toBe(200);
  return { ...started, paymentId };
}

const appt = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });
const paymentOf = (appointmentId: string) =>
  prisma.payment.findFirstOrThrow({
    where: { appointmentId },
    orderBy: { createdAt: "asc" },
    include: { refunds: true },
  });

/** Waits until the refund queued for a payment has settled at the (fake) gateway. */
async function settled(paymentId: string) {
  await processDueRefunds();
  return until(async () => {
    const p = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refunds: true },
    });
    return p.refunds.length > 0 && p.refunds.every((r) => r.status !== "PENDING") ? p : null;
  });
}

beforeAll(async () => {
  fake = useFakeRazorpay();
  world = await createWorld();
  makeSlot = slotFactory(world);
  pool = await createPatients(world, 120);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300)); // let background refund/message tasks finish
  await prisma.webhookEvent.deleteMany({
    where: {
      eventType: {
        in: [
          "payment.captured",
          "payment.failed",
          "order.paid",
          "refund.processed",
          "refund.failed",
        ],
      },
    },
  });
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("webhook security", () => {
  const event = () => paymentEvent("payment.captured", { orderId: "order_x", amount: FEE });

  it("rejects missing, wrong and tampered signatures, and records nothing", async () => {
    const before = await prisma.webhookEvent.count();
    expect((await postWebhook(base, event(), { signature: null })).status).toBe(401);
    expect((await postWebhook(base, event(), { signature: "deadbeef" })).status).toBe(401);
    expect((await postWebhook(base, event(), { secret: "some-other-secret" })).status).toBe(401);

    // Signed for one body, delivered with another.
    const original = JSON.stringify(event());
    const { razorpayWebhookSignature } = await import("../../services/payment/index.js");
    const tampered = original.replace(String(FEE), "1");
    const forged = await postWebhook(base, event(), {
      rawBody: tampered,
      signature: razorpayWebhookSignature(original, WEBHOOK_SECRET),
    });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("INVALID_SIGNATURE");
    expect(await prisma.webhookEvent.count()).toBe(before);
  });

  it("refuses to run unconfigured (503) and rejects signed non-JSON (400)", async () => {
    expect((await postWebhook(base, "not json", { rawBody: "not json at all" })).status).toBe(400);
    const secret = env.RAZORPAY_WEBHOOK_SECRET;
    env.RAZORPAY_WEBHOOK_SECRET = undefined;
    try {
      expect((await postWebhook(base, event())).status).toBe(503);
    } finally {
      env.RAZORPAY_WEBHOOK_SECRET = secret;
    }
  });

  it("stores and ignores events it does not use", async () => {
    const eventId = `evt_unused_${Date.now()}`;
    const reply = await postWebhook(
      base,
      { event: "subscription.charged", payload: {} },
      { eventId },
    );
    expect(reply.body.data.result).toBe("ignored");
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: "RAZORPAY", eventId } },
      }),
    ).toMatchObject({
      status: "IGNORED",
    });
  });
});

describe("creating the payment order", () => {
  it("creates one order at the server's price, and returns the same one when asked again", async () => {
    const [p] = take(1);
    const slot = await makeSlot();
    const hold = await lockSlot(p!.auth, { slotId: slot.id, patientProfileId: p!.profileId }, META);

    const first = await api("POST", `/appointments/${hold.id}/payment-order`, tokenFor(p!));
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      mode: "razorpay",
      amount: FEE,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID,
    });
    expect(first.body.data.prefill.name).toBeTruthy();
    const second = await api("POST", `/appointments/${hold.id}/payment-order`, tokenFor(p!));
    expect(second.body.data.orderId).toBe(first.body.data.orderId);

    const payment = await paymentOf(hold.id);
    expect(payment).toMatchObject({
      status: "CREATED",
      provider: "RAZORPAY",
      amount: FEE,
      razorpayOrderId: first.body.data.orderId,
    });
    expect(fake.orders.find((o) => o.id === payment.razorpayOrderId)).toMatchObject({
      amountMinor: FEE,
      receipt: hold.id,
    });
  });

  it("five simultaneous requests still end up with one order", async () => {
    const [p] = take(1);
    const slot = await makeSlot();
    const hold = await lockSlot(p!.auth, { slotId: slot.id, patientProfileId: p!.profileId }, META);
    fake.delayMs = 40;
    try {
      const orders = await Promise.all(
        Array.from({ length: 5 }, () => createPaymentOrder(p!.auth, hold.id)),
      );
      expect(new Set(orders.map((o) => (o.mode === "razorpay" ? o.orderId : ""))).size).toBe(1);
    } finally {
      fake.delayMs = 0;
    }
    expect(await prisma.payment.count({ where: { appointmentId: hold.id } })).toBe(1);
  });

  it("only the owner, and only while the hold is valid", async () => {
    const [a, b] = take(2);
    const slot = await makeSlot();
    const hold = await lockSlot(a!.auth, { slotId: slot.id, patientProfileId: a!.profileId }, META);
    expect((await api("POST", `/appointments/${hold.id}/payment-order`, tokenFor(b!))).status).toBe(
      404,
    );
    expect((await api("POST", `/appointments/${hold.id}/payment-order`)).status).toBe(401);

    await prisma.appointment.update({
      where: { id: hold.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    const late = await api("POST", `/appointments/${hold.id}/payment-order`, tokenFor(a!));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("HOLD_EXPIRED");
  });

  it("the test-payment shortcut does not exist in Razorpay mode", async () => {
    const [p] = take(1);
    const hold = await lockSlot(
      p!.auth,
      { slotId: (await makeSlot()).id, patientProfileId: p!.profileId },
      META,
    );
    expect((await api("POST", `/appointments/${hold.id}/mock-pay`, tokenFor(p!))).status).toBe(404);
    expect((await appt(hold.id)).status).toBe("PENDING_PAYMENT");
  });
});

describe("confirmation happens only through the webhook", () => {
  it("stays unpaid until Razorpay says so, then confirms with a token, the payment and commission", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    expect((await appt(appointmentId)).status).toBe("PENDING_PAYMENT"); // nothing the browser does can change this

    const reply = await postWebhook(
      base,
      paymentEvent("payment.captured", {
        orderId,
        amount: FEE,
        paymentId: "pay_abc",
        method: "card",
      }),
    );
    expect(reply.body.data.result).toBe("processed");

    expect(await appt(appointmentId)).toMatchObject({ status: "CONFIRMED", tokenNumber: 1 });
    expect(await paymentOf(appointmentId)).toMatchObject({
      status: "CAPTURED",
      razorpayPaymentId: "pay_abc",
      providerMethod: "card",
      commissionAmount: 5_000,
      amount: FEE,
    });
    const dto = await api("GET", `/appointments/${appointmentId}`, tokenFor(p!));
    expect(dto.body.data).toMatchObject({ status: "CONFIRMED", checkInCode: expect.any(String) });
    expect(dto.body.data.payment).toMatchObject({ status: "CAPTURED", refundedAmount: 0 });
  });

  it("a replayed event does nothing: ten simultaneous deliveries of one event confirm once", async () => {
    const [p] = take(1);
    const slot = await makeSlot();
    const lastToken = () =>
      prisma.doctorDay
        .findUnique({ where: { doctorId_date: { doctorId: world.doctorId, date: slot.date } } })
        .then((d) => d?.lastToken ?? 0);
    const { appointmentId, orderId } = await startPayment(p!, slot.id);
    const tokensBefore = await lastToken();
    const body = paymentEvent("payment.captured", { orderId, amount: FEE, paymentId: "pay_once" });

    const replies = await Promise.all(
      Array.from({ length: 10 }, () => postWebhook(base, body, { eventId: "evt_same_event" })),
    );
    expect(replies.every((r) => r.status === 200)).toBe(true);
    const results = replies.map((r) => r.body.data.result).sort();
    expect(results).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "processed",
    ]);
    expect(await prisma.payment.count({ where: { appointmentId } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { eventId: "evt_same_event" } })).toBe(1);
    expect((await appt(appointmentId)).status).toBe("CONFIRMED");
    expect(await lastToken()).toBe(tokensBefore + 1); // exactly one token was issued
  });

  it("the same payment arriving as a different event (order.paid after payment.captured) changes nothing", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    await postWebhook(
      base,
      paymentEvent("payment.captured", { orderId, amount: FEE, paymentId: "pay_two_events" }),
    );
    const token = (await appt(appointmentId)).tokenNumber;
    const queuedBefore = await prisma.notificationLog.count({ where: { appointmentId } });

    const again = await postWebhook(
      base,
      paymentEvent("order.paid", { orderId, amount: FEE, paymentId: "pay_two_events" }),
    );
    expect(again.status).toBe(200);
    expect((await appt(appointmentId)).tokenNumber).toBe(token);
    expect(await prisma.payment.count({ where: { appointmentId } })).toBe(1);
    expect(await prisma.notificationLog.count({ where: { appointmentId } })).toBe(queuedBefore);
  });

  it("an amount that differs from the order is never confirmed, and is flagged", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    const reply = await capture(orderId, { amount: FEE - 1 });
    expect(reply.body.data.result).toBe("ignored");
    expect((await appt(appointmentId)).status).toBe("PENDING_PAYMENT");
    const payment = await paymentOf(appointmentId);
    expect(payment.status).toBe("CREATED");
    expect(
      await prisma.auditLog.count({
        where: { action: "payment.amount_mismatch", entityId: payment.id },
      }),
    ).toBe(1);
  });

  it("an order we never created is ignored", async () => {
    const reply = await capture("order_not_ours");
    expect(reply.body.data.result).toBe("ignored");
  });

  it("a second payment for an already paid booking is refunded in full, the booking untouched", async () => {
    const [p] = take(1);
    const first = await paid(p!, (await makeSlot()).id);
    const token = (await appt(first.appointmentId)).tokenNumber;

    // The patient opened a second checkout and paid again.
    const second = await prisma.payment.create({
      data: {
        appointmentId: first.appointmentId,
        hospitalId: world.hospitalId,
        method: "ONLINE",
        provider: "RAZORPAY",
        amount: FEE,
        razorpayOrderId: "order_second_checkout",
      },
    });
    const reply = await capture("order_second_checkout", { paymentId: "pay_second" });
    expect(reply.body.data.note ?? "").toBeDefined();

    const settledSecond = await settled(second.id);
    expect(settledSecond).toMatchObject({ status: "REFUNDED", refundedAmount: FEE });
    expect(settledSecond.refunds[0]).toMatchObject({
      amount: FEE,
      percent: 100,
      reason: "Duplicate payment",
    });
    expect(await appt(first.appointmentId)).toMatchObject({
      status: "CONFIRMED",
      tokenNumber: token,
    });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId: first.paymentId } }))
        .status,
    ).toBe("CAPTURED");
  });
});

describe("failed and late payments", () => {
  it("a failed payment records why and releases the held slot for someone else", async () => {
    const [a, b] = take(2);
    const slot = await makeSlot();
    const { appointmentId, orderId } = await startPayment(a!, slot.id);
    await expect(
      lockSlot(b!.auth, { slotId: slot.id, patientProfileId: b!.profileId }, META),
    ).rejects.toMatchObject({ code: "SLOT_FULL" });

    const reply = await postWebhook(
      base,
      paymentEvent("payment.failed", { orderId, amount: FEE, error: "Your card was declined" }),
    );
    expect(reply.body.data.result).toBe("processed");
    expect(await paymentOf(appointmentId)).toMatchObject({
      status: "FAILED",
      failureReason: "Your card was declined",
    });
    expect(await appt(appointmentId)).toMatchObject({ status: "EXPIRED", seatNumber: null });

    await expect(
      lockSlot(b!.auth, { slotId: slot.id, patientProfileId: b!.profileId }, META),
    ).resolves.toMatchObject({ status: "PENDING_PAYMENT" });
  });

  it("if the patient retries and pays after a failure, the seat is re-taken when still free", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    await postWebhook(
      base,
      paymentEvent("payment.failed", { orderId, amount: FEE, error: "OTP not entered" }),
    );
    expect((await appt(appointmentId)).status).toBe("EXPIRED");

    await capture(orderId, { paymentId: "pay_retry_ok" });
    expect(await appt(appointmentId)).toMatchObject({ status: "CONFIRMED", seatNumber: 1 });
    expect((await paymentOf(appointmentId)).status).toBe("CAPTURED");
  });

  it("if someone else took the seat meanwhile, the late payment is refunded in full", async () => {
    const [a, b] = take(2);
    const slot = await makeSlot();
    const { appointmentId, orderId } = await startPayment(a!, slot.id);
    await postWebhook(base, paymentEvent("payment.failed", { orderId, amount: FEE }));
    const taken = await lockSlot(
      b!.auth,
      { slotId: slot.id, patientProfileId: b!.profileId },
      META,
    );

    await capture(orderId, { paymentId: "pay_too_late" });
    expect(await appt(appointmentId)).toMatchObject({ status: "EXPIRED", tokenNumber: null });
    const payment = await paymentOf(appointmentId);
    expect(await settled(payment.id)).toMatchObject({ status: "REFUNDED", refundedAmount: FEE });
    expect(fake.refunds.some((r) => r.paymentId === "pay_too_late" && r.amountMinor === FEE)).toBe(
      true,
    );
    expect((await appt(taken.id)).seatNumber).toBe(1); // the other patient keeps the seat
  });

  it("when releasing on failure is switched off, the hold stays until it times out", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    env.RELEASE_HOLD_ON_PAYMENT_FAILURE = false;
    try {
      const reply = await postWebhook(
        base,
        paymentEvent("payment.failed", { orderId, amount: FEE }),
      );
      expect(reply.body.data.result).toBe("processed");
    } finally {
      env.RELEASE_HOLD_ON_PAYMENT_FAILURE = true;
    }
    expect(await paymentOf(appointmentId)).toMatchObject({ status: "FAILED" });
    expect((await appt(appointmentId)).status).toBe("PENDING_PAYMENT");
  });

  it("a failure event that arrives after the payment succeeded cannot undo it", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    await capture(orderId, { paymentId: "pay_ok_first" });
    const late = await postWebhook(base, paymentEvent("payment.failed", { orderId, amount: FEE }));
    expect(late.body.data.result).toBe("ignored");
    expect((await paymentOf(appointmentId)).status).toBe("CAPTURED");
    expect((await appt(appointmentId)).status).toBe("CONFIRMED");
  });

  it("a payment for a booking the patient cancelled is refunded in full", async () => {
    const [p] = take(1);
    const { appointmentId, orderId } = await startPayment(p!, (await makeSlot()).id);
    await cancelAppointment(p!.auth, appointmentId, null, META); // gave up while checkout was open
    await capture(orderId, { paymentId: "pay_after_cancel" });
    expect(await appt(appointmentId)).toMatchObject({ status: "CANCELLED", tokenNumber: null });
    const payment = await paymentOf(appointmentId);
    expect(await settled(payment.id)).toMatchObject({ status: "REFUNDED", refundedAmount: FEE });
  });
});

describe("refunds on cancellation follow the hospital's policy", () => {
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

  async function cancelAt(startAt: Date | undefined) {
    const [p] = take(1);
    const { appointmentId } = await paid(p!, (await makeSlot(startAt ? { startAt } : {})).id);
    const cancelled = await cancelAppointment(p!.auth, appointmentId, null, META);
    return { p: p!, appointmentId, cancelled, payment: await paymentOf(appointmentId) };
  }

  it("a full refund when cancelled well in advance", async () => {
    const { payment, cancelled } = await cancelAt(undefined); // 3+ days ahead
    expect(cancelled.status).toBe("CANCELLED");
    const done = await settled(payment.id);
    expect(done).toMatchObject({ status: "REFUNDED", refundedAmount: FEE });
    expect(done.refunds[0]).toMatchObject({
      amount: FEE,
      percent: 100,
      status: "PROCESSED",
      reason: "Cancelled by patient",
    });
  });

  it("50% when cancelled inside the full-refund window", async () => {
    const { payment } = await cancelAt(hoursFromNow(5));
    const done = await settled(payment.id);
    expect(done).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedAmount: 25_000 });
    expect(done.refunds[0]).toMatchObject({ amount: 25_000, percent: 50 });
  });

  it("uses each hospital's own numbers", async () => {
    await prisma.hospital.update({
      where: { id: world.hospitalId },
      data: { refundFullHours: 48, refundPartialPercent: 20 },
    });
    try {
      const { payment } = await cancelAt(hoursFromNow(30)); // inside 48h: 20%
      expect(await settled(payment.id)).toMatchObject({
        status: "PARTIALLY_REFUNDED",
        refundedAmount: 10_000,
      });
    } finally {
      await prisma.hospital.update({
        where: { id: world.hospitalId },
        data: { refundFullHours: 24, refundPartialPercent: 50 },
      });
    }
  });

  it("no refund at all when the policy says 0% (nothing is queued)", async () => {
    await prisma.hospital.update({
      where: { id: world.hospitalId },
      data: { refundPartialPercent: 0 },
    });
    try {
      const { payment, cancelled } = await cancelAt(hoursFromNow(5));
      expect(cancelled.status).toBe("CANCELLED");
      expect(payment.refunds).toHaveLength(0);
      expect(payment.status).toBe("CAPTURED");
    } finally {
      await prisma.hospital.update({
        where: { id: world.hospitalId },
        data: { refundPartialPercent: 50 },
      });
    }
  });

  it("tells the patient what a cancellation would refund before they confirm", async () => {
    const [p] = take(1);
    const { appointmentId } = await paid(p!, (await makeSlot({ startAt: hoursFromNow(5) })).id);
    const dto = await api("GET", `/appointments/${appointmentId}`, tokenFor(p!));
    expect(dto.body.data.cancelRefund).toEqual({ amount: 25_000, percent: 50 });
    expect(dto.body.data.refundPolicy).toEqual({ fullRefundHours: 24, partialPercent: 50 });
  });

  it("an unpaid hold, a free appointment and a repeat cancel never produce refunds", async () => {
    const [a, b] = take(2);
    const hold = await startPayment(a!, (await makeSlot()).id);
    await cancelAppointment(a!.auth, hold.appointmentId, null, META);
    expect((await paymentOf(hold.appointmentId)).refunds).toHaveLength(0);

    const freeDoctor = await createDoctor(world, 0);
    const free = await lockSlot(
      b!.auth,
      { slotId: (await makeSlot({ doctorId: freeDoctor })).id, patientProfileId: b!.profileId },
      META,
    );
    expect(free.status).toBe("CONFIRMED");
    await cancelAppointment(b!.auth, free.id, null, META);
    expect(await prisma.payment.count({ where: { appointmentId: free.id } })).toBe(0);
  });

  it("twenty simultaneous cancels queue exactly one refund", async () => {
    const [p] = take(1);
    const { appointmentId } = await paid(p!, (await makeSlot()).id);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        cancelAppointment(p!.auth, appointmentId, null, META).then(
          () => "OK",
          (e) => (e as AppError).code,
        ),
      ),
    );
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    const payment = await paymentOf(appointmentId);
    expect(payment.refunds).toHaveLength(1);
    await settled(payment.id);
  });

  it("the payment follows a reschedule, so a later cancel refunds by the new time", async () => {
    const [p] = take(1);
    const { appointmentId } = await paid(p!, (await makeSlot()).id);
    const moved = await rescheduleAppointment(
      p!.auth,
      appointmentId,
      (await makeSlot({ startAt: hoursFromNow(6) })).id,
      META,
    );
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { appointmentId: moved.id } })).amount,
    ).toBe(FEE);

    await cancelAppointment(p!.auth, moved.id, null, META);
    const done = await settled((await paymentOf(moved.id)).id);
    expect(done.refunds[0]).toMatchObject({ amount: 25_000, percent: 50 }); // 6 hours out: partial
  });
});

describe("refund processing is safe to retry", () => {
  async function paidPayment() {
    const [p] = take(1);
    const { appointmentId, paymentId } = await paid(p!, (await makeSlot()).id);
    return {
      p: p!,
      appointmentId,
      payment: await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId: paymentId } }),
    };
  }
  const queue = (paymentId: string, amount: number) =>
    prisma.$transaction((tx) =>
      queueRefund(tx, paymentId, amount, { reason: "test", percent: 100, initiatedById: null }),
    );

  it("never refunds more than was paid, however many refunds are requested", async () => {
    const { payment } = await paidPayment();
    const results = await Promise.all([
      queue(payment.id, 40_000),
      queue(payment.id, 40_000),
      queue(payment.id, 40_000),
    ]);
    const created = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(created.reduce((n, r) => n + r.amount, 0)).toBe(FEE);
    expect(results.filter(Boolean).length).toBe(created.length);
    expect(await queue(payment.id, 1)).toBeNull();
  });

  it("ten workers racing on one refund call the gateway once, with the refund id as idempotency key", async () => {
    const { payment } = await paidPayment();
    const refundId = (await queue(payment.id, 10_000))!;
    fake.delayMs = 30;
    const before = fake.refunds.length;
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => processRefund(refundId)));
      expect(results.filter((r) => r === "processed")).toHaveLength(1);
      expect(results.filter((r) => r === "skipped")).toHaveLength(9);
    } finally {
      fake.delayMs = 0;
    }
    const calls = fake.refunds.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      idempotencyKey: refundId,
      amountMinor: 10_000,
      paymentId: payment.razorpayPaymentId,
    });
  });

  it("a temporary outage keeps the refund queued and the job completes it later", async () => {
    const { payment } = await paidPayment();
    fake.refundError = new GatewayError("Razorpay unreachable", true);
    const refundId = (await queue(payment.id, 20_000))!;
    expect(await processRefund(refundId)).toBe("retry");
    const waiting = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(waiting).toMatchObject({
      status: "PENDING",
      attempts: 1,
      error: expect.stringContaining("unreachable"),
    });
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    fake.refundError = null;
    expect(await processRefund(refundId)).toBe("skipped"); // not due yet: no hammering the gateway
    await prisma.refund.update({
      where: { id: refundId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await processDueRefunds();
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({
      status: "PROCESSED",
      error: null,
    });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: "PARTIALLY_REFUNDED",
      refundedAmount: 20_000,
    });
  });

  it("a permanent rejection fails the refund once and flags it for a human", async () => {
    const { payment } = await paidPayment();
    fake.refundError = new GatewayError("Razorpay: payment already fully refunded", false, 400);
    const refundId = (await queue(payment.id, 5_000))!;
    try {
      expect(await processRefund(refundId)).toBe("failed");
    } finally {
      fake.refundError = null;
    }
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({
      status: "FAILED",
    });
    expect(
      await prisma.auditLog.count({ where: { action: "refund.failed", entityId: refundId } }),
    ).toBe(1);
    await processDueRefunds();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).attempts).toBe(1); // never retried
  });

  it("a refund Razorpay leaves pending is completed by its webhook, once", async () => {
    const { payment } = await paidPayment();
    fake.refundStatus = "pending";
    const refundId = (await queue(payment.id, 15_000))!;
    try {
      expect(await processRefund(refundId)).toBe("pending");
    } finally {
      fake.refundStatus = "processed";
    }
    const pending = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(pending.status).toBe("PENDING");
    expect(pending.razorpayRefundId).toBeTruthy();
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmount,
    ).toBe(0);
    expect(await processRefund(refundId)).toBe("skipped"); // already with Razorpay

    const done = refundEvent("refund.processed", {
      refundId: pending.razorpayRefundId!,
      amount: 15_000,
    });
    expect((await postWebhook(base, done)).body.data.result).toBe("processed");
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: "PARTIALLY_REFUNDED",
      refundedAmount: 15_000,
    });
    // Razorpay delivers it again: nothing is counted twice.
    await postWebhook(base, done);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmount,
    ).toBe(15_000);
  });

  it("finds our refund through the notes when the gateway id is not stored yet", async () => {
    const { payment } = await paidPayment();
    const refundId = (await queue(payment.id, 7_000))!;
    const reply = await postWebhook(
      base,
      refundEvent("refund.processed", { refundId: "rfnd_unknown_to_us", notes: { refundId } }),
    );
    expect(reply.body.data.result).toBe("processed");
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({
      status: "PROCESSED",
      razorpayRefundId: "rfnd_unknown_to_us",
    });
  });

  it("ignores refunds that were not made by us, and records refund failures", async () => {
    expect(
      (
        await postWebhook(
          base,
          refundEvent("refund.processed", { refundId: "rfnd_dashboard_manual" }),
        )
      ).body.data.result,
    ).toBe("ignored");

    const { payment } = await paidPayment();
    fake.refundStatus = "pending";
    const refundId = (await queue(payment.id, 3_000))!;
    await processRefund(refundId);
    fake.refundStatus = "processed";
    const gatewayId = (await prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
      .razorpayRefundId!;
    await postWebhook(base, refundEvent("refund.failed", { refundId: gatewayId }));
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({
      status: "FAILED",
    });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmount,
    ).toBe(0);
  });
});
