/**
 * Proves the booking engine never double-books, against a real PostgreSQL server.
 * Run with `pnpm test:integration`.
 *
 * "Concurrent" here is real: every call below is its own transaction on its own
 * connection (pool of 60), started at the same moment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
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
import {
  cancelAppointment,
  confirmAppointment,
  expireStaleHolds,
  lockSlot,
  rescheduleAppointment,
} from "./booking.service.js";
import { processDueRefunds } from "../payments/refunds.service.js";

const META = {};
const PAY = { provider: "MOCK", method: "ONLINE" } as const;

let world: World;
let makeSlot: ReturnType<typeof slotFactory>;
let pool: Patient[];
let cursor = 0;

/** Hands out patients that no earlier test used. */
const take = (n: number) => {
  const out = pool.slice(cursor, cursor + n);
  cursor += n;
  if (out.length < n) throw new Error("test patient pool exhausted");
  return out;
};

const lock = (p: Patient, slotId: string) =>
  lockSlot(p.auth, { slotId, patientProfileId: p.profileId }, META);

/** "OK" or the API error code. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "OK";
  } catch (err) {
    return err instanceof AppError ? err.code : `UNEXPECTED: ${(err as Error).message}`;
  }
}

const tally = (results: string[]) =>
  results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});

/** The invariants that must hold no matter what ran before. */
async function assertInvariants() {
  const slots = await prisma.slot.findMany({
    where: { doctorId: { in: world.doctorIds } },
    include: { appointments: { select: { seatNumber: true } } },
  });
  for (const s of slots) {
    const seats = s.appointments.map((a) => a.seatNumber).filter((x): x is number => x !== null);
    expect(seats.length, `slot ${s.id} bookedCount`).toBe(s.bookedCount);
    expect(seats.length, `slot ${s.id} over capacity`).toBeLessThanOrEqual(s.capacity);
    expect(new Set(seats).size, `slot ${s.id} duplicate seat`).toBe(seats.length);
    for (const seat of seats) expect(seat >= 1 && seat <= s.capacity).toBe(true);
  }
  const days = await prisma.doctorDay.findMany({ where: { doctorId: { in: world.doctorIds } } });
  for (const d of days) {
    const tokens = (
      await prisma.appointment.findMany({
        where: { doctorId: d.doctorId, appointmentDate: d.date, tokenNumber: { not: null } },
        select: { tokenNumber: true },
      })
    )
      .map((a) => a.tokenNumber!)
      .sort((a, b) => a - b);
    expect(tokens, `tokens ${d.doctorId} ${d.date.toISOString()}`).toEqual(
      Array.from({ length: d.lastToken }, (_, i) => i + 1),
    );
  }
}

beforeAll(async () => {
  world = await createWorld();
  makeSlot = slotFactory(world);
  pool = await createPatients(world, 320);
});

afterAll(async () => {
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("many users, one slot", () => {
  it("50 simultaneous bookings of a single-seat slot: exactly one wins", async () => {
    const slot = await makeSlot({ capacity: 1 });
    const patients = take(50);
    const results = await Promise.all(patients.map((p) => outcome(lock(p, slot.id))));

    expect(tally(results)).toEqual({ OK: 1, SLOT_FULL: 49 });
    const held = await prisma.appointment.findMany({
      where: { slotId: slot.id, seatNumber: { not: null } },
    });
    expect(held).toHaveLength(1);
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).bookedCount).toBe(1);
    await assertInvariants();
  });

  it("25 simultaneous bookings of a 3-seat slot: exactly three win, on distinct seats", async () => {
    const slot = await makeSlot({ capacity: 3 });
    const results = await Promise.all(take(25).map((p) => outcome(lock(p, slot.id))));

    expect(tally(results)).toEqual({ OK: 3, SLOT_FULL: 22 });
    const seats = (
      await prisma.appointment.findMany({ where: { slotId: slot.id, seatNumber: { not: null } } })
    )
      .map((a) => a.seatNumber)
      .sort();
    expect(seats).toEqual([1, 2, 3]);
    await assertInvariants();
  });

  it("the same patient double-clicking gets one hold, not two", async () => {
    const slot = await makeSlot({ capacity: 5 });
    const [p] = take(1);
    const holds = await Promise.all(Array.from({ length: 10 }, () => lock(p!, slot.id)));

    expect(new Set(holds.map((h) => h.id)).size).toBe(1);
    expect(await prisma.appointment.count({ where: { slotId: slot.id } })).toBe(1);
    await assertInvariants();
  });

  it("one patient racing two slots of the same doctor on the same day: one wins", async () => {
    const a = await makeSlot({ capacity: 1, dayOffset: 5 });
    const b = await makeSlot({ capacity: 1, dayOffset: 5 });
    const [p] = take(1);
    const results = await Promise.all([outcome(lock(p!, a.id)), outcome(lock(p!, b.id))]);

    expect(tally(results)).toEqual({ OK: 1, ALREADY_BOOKED: 1 });
    await assertInvariants();
  });

  it("stress: 40 patients on a 5-seat slot, winners confirm while losers keep retrying", async () => {
    const slot = await makeSlot({ capacity: 5, dayOffset: 6 });
    const patients = take(40);

    const first = await Promise.allSettled(patients.map((p) => lock(p, slot.id)));
    const winners = first.flatMap((r, i) =>
      r.status === "fulfilled" ? [{ p: patients[i]!, id: r.value.id }] : [],
    );
    expect(winners).toHaveLength(5);

    const [confirms, retries] = await Promise.all([
      Promise.all(winners.map((w) => outcome(confirmAppointment(w.id, PAY, null)))),
      Promise.all(
        patients
          .filter((p) => !winners.some((w) => w.p === p))
          .map((p) => outcome(lock(p, slot.id))),
      ),
    ]);
    expect(tally(confirms)).toEqual({ OK: 5 });
    expect(tally(retries)).toEqual({ SLOT_FULL: 35 });
    expect(
      await prisma.appointment.count({ where: { slotId: slot.id, status: "CONFIRMED" } }),
    ).toBe(5);
    await assertInvariants();
  });
});

describe("token numbers", () => {
  it("12 simultaneous confirmations for one doctor and day get tokens 1..12, no gaps or repeats", async () => {
    const slots = await Promise.all(Array.from({ length: 12 }, () => makeSlot({ dayOffset: 8 })));
    const patients = take(12);
    const holds = await Promise.all(patients.map((p, i) => lock(p, slots[i]!.id)));

    const results = await Promise.all(
      holds.map((h) => outcome(confirmAppointment(h.id, PAY, null))),
    );
    expect(tally(results)).toEqual({ OK: 12 });

    const tokens = (
      await prisma.appointment.findMany({ where: { id: { in: holds.map((h) => h.id) } } })
    )
      .map((a) => a.tokenNumber!)
      .sort((a, b) => a - b);
    expect(tokens).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    await assertInvariants();
  });

  it("confirming the same appointment five times at once issues one token and one payment", async () => {
    const slot = await makeSlot({ dayOffset: 9 });
    const [p] = take(1);
    const hold = await lock(p!, slot.id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => confirmAppointment(hold.id, PAY, null)),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "ALREADY_CONFIRMED",
      "ALREADY_CONFIRMED",
      "ALREADY_CONFIRMED",
      "ALREADY_CONFIRMED",
      "CONFIRMED",
    ]);
    expect(await prisma.payment.count({ where: { appointmentId: hold.id } })).toBe(1);
    await assertInvariants();
  });

  it("the payment records the fee and the commission snapshot", async () => {
    const slot = await makeSlot({ dayOffset: 9 });
    const [p] = take(1);
    const hold = await lock(p!, slot.id);
    await confirmAppointment(hold.id, PAY, null);

    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: hold.id } });
    expect(payment).toMatchObject({
      amount: 50_000,
      commissionAmount: 5_000,
      status: "CAPTURED",
      provider: "MOCK",
    });
  });
});

describe("holds and expiry", () => {
  const expireNow = (appointmentId: string) =>
    prisma.appointment.update({
      where: { id: appointmentId },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });

  it("a hold lasts five minutes", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [p] = take(1);
    const before = Date.now();
    const hold = await lock(p!, slot.id);
    const ms = new Date(hold.holdExpiresAt!).getTime() - before;
    expect(ms).toBeGreaterThan(4.9 * 60_000);
    expect(ms).toBeLessThan(5.1 * 60_000);
    expect(hold.status).toBe("PENDING_PAYMENT");
  });

  it("the release job frees an expired hold so someone else can book", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const hold = await lock(a!, slot.id);
    expect(await outcome(lock(b!, slot.id))).toBe("SLOT_FULL"); // held, not yet expired

    await expireNow(hold.id);
    expect(await expireStaleHolds()).toBeGreaterThanOrEqual(1);

    const expired = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.id } });
    expect(expired).toMatchObject({ status: "EXPIRED", seatNumber: null });
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } })).bookedCount).toBe(0);
    expect(await outcome(lock(b!, slot.id))).toBe("OK");
    await assertInvariants();
  });

  it("booking works even if the release job never runs (expired holds are released inline)", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const hold = await lock(a!, slot.id);
    await expireNow(hold.id);

    expect(await outcome(lock(b!, slot.id))).toBe("OK");
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe(
      "EXPIRED",
    );
    await assertInvariants();
  });

  it("a late payment re-takes the seat if it is still free", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a] = take(1);
    const hold = await lock(a!, slot.id);
    await expireNow(hold.id);
    await expireStaleHolds();

    const { outcome: result } = await confirmAppointment(hold.id, PAY, null);
    expect(result).toBe("CONFIRMED");
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.id } });
    expect(appt).toMatchObject({ status: "CONFIRMED", seatNumber: 1 });
    expect(appt.tokenNumber).not.toBeNull();
    await assertInvariants();
  });

  it("a late payment for a seat someone else took (SLOT_LOST): no token, and the money is refunded in full", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const holdA = await lock(a!, slot.id);
    await expireNow(holdA.id);
    await expireStaleHolds();
    const holdB = await lock(b!, slot.id);

    const { outcome: result } = await confirmAppointment(holdA.id, PAY, null);
    expect(result).toBe("SLOT_LOST");
    const lost = await prisma.appointment.findUniqueOrThrow({ where: { id: holdA.id } });
    expect(lost).toMatchObject({ status: "EXPIRED", seatNumber: null, tokenNumber: null });
    // Money that arrived is always recorded, and a full refund is queued in the same transaction.
    const payment = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: holdA.id },
      include: { refunds: true },
    });
    expect(payment.refunds).toHaveLength(1);
    expect(payment.refunds[0]).toMatchObject({ amount: 50_000, percent: 100 });
    await processDueRefunds(); // the refund is also kicked off in the background; either way it settles
    let settled = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    for (let i = 0; i < 50 && settled.status !== "REFUNDED"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      settled = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    }
    expect(settled).toMatchObject({ status: "REFUNDED", refundedAmount: 50_000 });
    expect((await confirmAppointment(holdB.id, PAY, null)).outcome).toBe("CONFIRMED");
    await assertInvariants();
  });

  it("a patient can't hoard seats: at most 3 unpaid holds", async () => {
    const [p] = take(1);
    const slots = await Promise.all([10, 11, 12, 13].map((d) => makeSlot({ dayOffset: d })));
    const results: string[] = [];
    for (const s of slots) results.push(await outcome(lock(p!, s.id)));
    expect(results).toEqual(["OK", "OK", "OK", "TOO_MANY_HOLDS"]);
  });
});

describe("free consultations, blocked slots, closed booking", () => {
  it("a zero-fee doctor is confirmed immediately, with a token and no payment", async () => {
    const freeDoctor = await createDoctor(world, 0);
    const slot = await makeSlot({ doctorId: freeDoctor, dayOffset: 4 });
    const [p] = take(1);
    const appt = await lock(p!, slot.id);

    expect(appt.status).toBe("CONFIRMED");
    expect(appt.tokenNumber).toBe(1);
    expect(await prisma.payment.count({ where: { appointmentId: appt.id } })).toBe(0);
    await assertInvariants();
  });

  it("a blocked slot can't be booked", async () => {
    const slot = await makeSlot({ status: "BLOCKED", dayOffset: 4 });
    expect(await outcome(lock(take(1)[0]!, slot.id))).toBe("SLOT_UNAVAILABLE");
  });

  it("online booking is closed in the last 15 minutes", async () => {
    const slot = await makeSlot({ startAt: new Date(Date.now() + 10 * 60_000) });
    expect(await outcome(lock(take(1)[0]!, slot.id))).toBe("SLOT_UNAVAILABLE");
  });

  it("a blocked hospital's slots can't be booked", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    await prisma.hospital.update({ where: { id: world.hospitalId }, data: { status: "BLOCKED" } });
    try {
      expect(await outcome(lock(take(1)[0]!, slot.id))).toBe("SLOT_UNAVAILABLE");
    } finally {
      await prisma.hospital.update({ where: { id: world.hospitalId }, data: { status: "ACTIVE" } });
    }
  });

  it("a patient can only book for their own profiles", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const result = await outcome(
      lockSlot(a!.auth, { slotId: slot.id, patientProfileId: b!.profileId }, META),
    );
    expect(result).toBe("PROFILE_NOT_FOUND");
  });
});

describe("cancel", () => {
  it("frees the seat immediately for the next person; the token stays burned", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const hold = await lock(a!, slot.id);
    await confirmAppointment(hold.id, PAY, null);
    expect(await outcome(lock(b!, slot.id))).toBe("SLOT_FULL");

    const cancelled = await cancelAppointment(a!.auth, hold.id, "Plans changed", META);
    expect(cancelled.status).toBe("CANCELLED");
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: hold.id } });
    expect(row).toMatchObject({ seatNumber: null, cancelReason: "Plans changed" });
    expect(row.tokenNumber).not.toBeNull();
    expect(await outcome(lock(b!, slot.id))).toBe("OK");
    await assertInvariants();
  });

  it("abandoning an unpaid hold frees the seat", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const hold = await lock(a!, slot.id);
    await cancelAppointment(a!.auth, hold.id, null, META);
    expect(await outcome(lock(b!, slot.id))).toBe("OK");
  });

  it("is closed in the last hour", async () => {
    const slot = await makeSlot({ startAt: new Date(Date.now() + 30 * 60_000) });
    const [a] = take(1);
    const hold = await lock(a!, slot.id);
    await confirmAppointment(hold.id, PAY, null);
    expect(await outcome(cancelAppointment(a!.auth, hold.id, null, META))).toBe("CHANGE_CLOSED");
  });

  it("only the owner can cancel", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a, b] = take(2);
    const hold = await lock(a!, slot.id);
    expect(await outcome(cancelAppointment(b!.auth, hold.id, null, META))).toBe("NOT_FOUND");
  });

  it("20 simultaneous cancels of one appointment: one succeeds, the rest see it already cancelled", async () => {
    const slot = await makeSlot({ dayOffset: 4 });
    const [a] = take(1);
    const hold = await lock(a!, slot.id);
    await confirmAppointment(hold.id, PAY, null);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => outcome(cancelAppointment(a!.auth, hold.id, null, META))),
    );
    expect(tally(results)).toEqual({ OK: 1, INVALID_STATUS: 19 });
    await assertInvariants();
  });
});

describe("reschedule", () => {
  const confirmed = async (p: Patient, slotId: string) => {
    const hold = await lock(p, slotId);
    await confirmAppointment(hold.id, PAY, null);
    return hold.id;
  };

  it("moves the booking: new token and code, old seat freed, payment follows", async () => {
    const s1 = await makeSlot({ dayOffset: 4 });
    const s2 = await makeSlot({ dayOffset: 7 });
    const [p] = take(1);
    const oldId = await confirmed(p!, s1.id);
    const oldRow = await prisma.appointment.findUniqueOrThrow({ where: { id: oldId } });

    const moved = await rescheduleAppointment(p!.auth, oldId, s2.id, META);
    expect(moved.status).toBe("CONFIRMED");
    expect(moved.rescheduledFromId).toBe(oldId);
    expect(moved.tokenNumber).not.toBeNull();
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: oldId } });
    expect(after).toMatchObject({
      status: "CANCELLED",
      seatNumber: null,
      cancelReason: "Rescheduled",
    });
    expect(after.checkInCode).not.toBe(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: moved.id } })).checkInCode,
    );
    expect(oldRow.slotId).toBe(s1.id);
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: s1.id } })).bookedCount).toBe(0);
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: s2.id } })).bookedCount).toBe(1);
    expect(await prisma.payment.count({ where: { appointmentId: moved.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { appointmentId: oldId } })).toBe(0);
    await assertInvariants();
  });

  it("can move within the same day (new token, still one seat)", async () => {
    const s1 = await makeSlot({ dayOffset: 14 });
    const s2 = await makeSlot({ dayOffset: 14 });
    const [p] = take(1);
    const oldId = await confirmed(p!, s1.id);
    expect((await rescheduleAppointment(p!.auth, oldId, s2.id, META)).status).toBe("CONFIRMED");
    await assertInvariants();
  });

  it("only to another slot of the same doctor", async () => {
    const other = await createDoctor(world, 50_000);
    const s1 = await makeSlot({ dayOffset: 4 });
    const s2 = await makeSlot({ doctorId: other, dayOffset: 4 });
    const [p] = take(1);
    const id = await confirmed(p!, s1.id);
    expect(await outcome(rescheduleAppointment(p!.auth, id, s2.id, META))).toBe("SAME_DOCTOR_ONLY");
    expect(await outcome(rescheduleAppointment(p!.auth, id, s1.id, META))).toBe("SAME_SLOT");
  });

  it("at most twice per appointment", async () => {
    const slots = await Promise.all([15, 16, 17, 18].map((d) => makeSlot({ dayOffset: d })));
    const [p] = take(1);
    let id = await confirmed(p!, slots[0]!.id);
    id = (await rescheduleAppointment(p!.auth, id, slots[1]!.id, META)).id;
    id = (await rescheduleAppointment(p!.auth, id, slots[2]!.id, META)).id;
    expect(await outcome(rescheduleAppointment(p!.auth, id, slots[3]!.id, META))).toBe(
      "MAX_RESCHEDULES",
    );
  });

  it("two patients racing for the last seat: one wins, the loser keeps their original booking", async () => {
    const s1 = await makeSlot({ dayOffset: 19 });
    const s2 = await makeSlot({ dayOffset: 19 });
    const target = await makeSlot({ dayOffset: 20, capacity: 1 });
    const [a, b] = take(2);
    const idA = await confirmed(a!, s1.id);
    const idB = await confirmed(b!, s2.id);

    const results = await Promise.all([
      outcome(rescheduleAppointment(a!.auth, idA, target.id, META)),
      outcome(rescheduleAppointment(b!.auth, idB, target.id, META)),
    ]);
    expect(tally(results)).toEqual({ OK: 1, SLOT_FULL: 1 });
    const stillConfirmed = await prisma.appointment.count({
      where: { id: { in: [idA, idB] }, status: "CONFIRMED", seatNumber: { not: null } },
    });
    expect(stillConfirmed).toBe(1); // exactly one of them stayed put; the other moved
    expect((await prisma.slot.findUniqueOrThrow({ where: { id: target.id } })).bookedCount).toBe(1);
    await assertInvariants();
  });

  it("two patients swapping slots at the same instant can't deadlock", async () => {
    const s1 = await makeSlot({ dayOffset: 21 });
    const s2 = await makeSlot({ dayOffset: 22 });
    const [a, b] = take(2);
    const idA = await confirmed(a!, s1.id);
    const idB = await confirmed(b!, s2.id);

    const results = await Promise.all([
      outcome(rescheduleAppointment(a!.auth, idA, s2.id, META)),
      outcome(rescheduleAppointment(b!.auth, idB, s1.id, META)),
    ]);
    // Neither seat is free at the moment the other asks for it: both are refused, cleanly.
    expect(results.every((r) => r === "SLOT_FULL" || r === "OK")).toBe(true);
    await assertInvariants();
  });
});

describe("the whole day at once", () => {
  it("100 patients book, pay, cancel and reschedule against 10 slots in parallel; invariants hold", async () => {
    const slots = await Promise.all(
      Array.from({ length: 10 }, () => makeSlot({ dayOffset: 25, capacity: 4 })),
    );
    const patients = take(100);

    // Everyone grabs a random slot at the same time.
    const holds = await Promise.allSettled(
      patients.map((p, i) => lock(p, slots[(i * 7) % slots.length]!.id)),
    );
    const won = holds.flatMap((r, i) =>
      r.status === "fulfilled" ? [{ p: patients[i]!, id: r.value.id }] : [],
    );
    expect(won).toHaveLength(40); // 10 slots x 4 seats

    // Winners pay; a quarter of them cancel at the same moment; others try to move to a full slot.
    await Promise.all(
      won.map(async (w, i) => {
        await confirmAppointment(w.id, PAY, null);
        if (i % 4 === 0) await outcome(cancelAppointment(w.p.auth, w.id, null, META));
        else if (i % 4 === 1)
          await outcome(
            rescheduleAppointment(w.p.auth, w.id, slots[(i + 1) % slots.length]!.id, META),
          );
      }),
    );

    await assertInvariants();
    for (const s of slots) {
      const row = await prisma.slot.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.bookedCount).toBeLessThanOrEqual(4);
    }
  });

  it("keeps the hospital's timezone: slot dates match the local calendar day", async () => {
    const slot = await makeSlot({ dayOffset: 2 });
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(slot.startAt);
    expect(slot.date.toISOString().slice(0, 10)).toBe(local);
  });
});
