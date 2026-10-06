/**
 * Patient history through the real HTTP API: what shows, for whom, and that nobody sees anyone
 * else's visits. Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cleanup,
  createDoctor,
  createPatients,
  createStaffUser,
  createWorld,
  pastVisit,
  type Patient,
  type Staff,
  type World,
} from "../../../test/fixtures.js";

let server: Server;
let base: string;
let world: World;
let other: World;
let alice: Patient;
let bob: Patient;
let aliceToken: string;
let bobToken: string;
let reception: Staff;
let childProfileId: string;
let doctor2: string;
const visits: Record<string, string> = {};

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

async function get(path: string, token?: string): Promise<Reply> {
  const res = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return { status: res.status, data: json?.data };
}

const tokenOf = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;
const ids = (r: Reply) => (r.data.items as Array<{ id: string }>).map((i) => i.id);

beforeAll(async () => {
  world = await createWorld();
  other = await createWorld();
  [alice, bob] = (await createPatients(world, 2)) as [Patient, Patient];
  aliceToken = tokenOf(alice);
  bobToken = tokenOf(bob);
  reception = await createStaffUser(world, "RECEPTIONIST");
  doctor2 = await createDoctor(other);

  const child = await prisma.patientProfile.create({
    data: { userId: alice.userId, relation: "CHILD", fullName: "Little Alice" },
  });
  childProfileId = child.id;

  // Alice: a visit with a paid fee, a part-refunded one for her child at another hospital,
  // one from last year, a cancelled one and a missed one. Bob has one visit of his own.
  const v = async (key: string, ...args: Parameters<typeof pastVisit>) => {
    visits[key] = (await pastVisit(...args)).id;
  };
  await v("recent", world, alice, { daysAgo: 2 });
  await v(
    "child",
    other,
    { ...alice, profileId: childProfileId },
    { daysAgo: 5, doctorId: doctor2 },
  );
  await v("old", world, alice, { daysAgo: 400 });
  await v("cancelled", world, alice, { daysAgo: 3, status: "CANCELLED" });
  await v("upcoming", world, alice, { daysAgo: -3, status: "CONFIRMED" });
  await v("bob", world, bob, { daysAgo: 4 });

  await prisma.payment.create({
    data: {
      appointmentId: visits.recent!,
      hospitalId: world.hospitalId,
      method: "ONLINE",
      provider: "MOCK",
      status: "CAPTURED",
      amount: 50_000,
    },
  });
  await prisma.payment.create({
    data: {
      appointmentId: visits.child!,
      hospitalId: other.hospitalId,
      method: "ONLINE",
      provider: "MOCK",
      status: "PARTIALLY_REFUNDED",
      amount: 50_000,
      refundedAmount: 20_000,
    },
  });
  await prisma.payment.create({
    data: {
      appointmentId: visits.cancelled!,
      hospitalId: world.hospitalId,
      method: "ONLINE",
      provider: "MOCK",
      status: "REFUNDED",
      amount: 50_000,
      refundedAmount: 50_000,
    },
  });

  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  // The child profile belongs to the first patient but has a visit at the second hospital: that one goes first.
  if (other) await cleanup(other);
  if (world) await cleanup(world);
  await prisma.$disconnect();
});

describe("what the history shows", () => {
  it("lists the visits that happened, newest first, across hospitals and family profiles", async () => {
    const r = await get("/patient/history", aliceToken);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([visits.recent, visits.child, visits.old]);
    expect(r.data.summary).toMatchObject({ visits: 3, doctors: 2, hospitals: 2 });
    // 50,000 paid, 30,000 kept after the partial refund. Cancelled and refunded money is not counted.
    expect(r.data.summary.spent).toEqual([{ currency: "INR", amount: 80_000 }]);
    const child = r.data.items.find((i: { id: string }) => i.id === visits.child);
    expect(child).toMatchObject({
      patient: { id: childProfileId, fullName: "Little Alice" },
      paidAmount: 30_000,
      hospital: { name: expect.any(String), slug: expect.any(String) },
    });
    expect(r.data.items[0]).toMatchObject({
      status: "COMPLETED",
      canReview: true,
      review: null,
      paidAmount: 50_000,
    });
    expect(r.data.items[2].canReview).toBe(false); // outside the review window
  });

  it("includes cancelled visits only when asked, and never future ones", async () => {
    const all = await get("/patient/history?scope=all", aliceToken);
    expect(ids(all)).toContain(visits.cancelled);
    expect(ids(all)).not.toContain(visits.upcoming);
    expect(ids(await get("/patient/history", aliceToken))).not.toContain(visits.cancelled);
  });

  it("shows the review of a visit", async () => {
    await prisma.review.create({
      data: {
        appointmentId: visits.recent!,
        hospitalId: world.hospitalId,
        doctorId: world.doctorId,
        userId: alice.userId,
        rating: 4,
      },
    });
    const r = await get("/patient/history", aliceToken);
    expect(r.data.items[0]).toMatchObject({
      canReview: false,
      review: { rating: 4, hidden: false },
    });
  });

  it("filters by family profile and by year, and pages", async () => {
    expect(ids(await get(`/patient/history?profileId=${childProfileId}`, aliceToken))).toEqual([
      visits.child,
    ]);
    const selfOnly = await get(`/patient/history?profileId=${alice.profileId}`, aliceToken);
    expect(ids(selfOnly)).toEqual([visits.recent, visits.old]);
    expect(selfOnly.data.summary.visits).toBe(2);

    const old = await prisma.appointment.findUniqueOrThrow({ where: { id: visits.old! } });
    const year = old.appointmentDate.getUTCFullYear();
    expect(ids(await get(`/patient/history?year=${year}`, aliceToken))).toContain(visits.old);
    expect(ids(await get(`/patient/history?year=${year}`, aliceToken))).not.toContain(
      visits.recent,
    );

    const first = await get("/patient/history?limit=2&page=1", aliceToken);
    const second = await get("/patient/history?limit=2&page=2", aliceToken);
    expect(first.data.items).toHaveLength(2);
    expect(second.data.items).toHaveLength(1);
    expect(first.data.pagination).toMatchObject({ total: 3, totalPages: 2 });
    // the summary covers all pages, not just this one
    expect(second.data.summary.visits).toBe(3);
  });
});

describe("who can see it", () => {
  it("shows each patient only their own visits", async () => {
    const mine = await get("/patient/history", bobToken);
    expect(ids(mine)).toEqual([visits.bob]);
    expect(JSON.stringify(mine.data)).not.toContain(alice.userId);
    expect(JSON.stringify(mine.data)).not.toContain("Little Alice");
    // somebody else's profile is simply not there
    expect((await get(`/patient/history?profileId=${childProfileId}`, bobToken)).status).toBe(404);
  });

  it("needs a patient login and valid input", async () => {
    expect((await get("/patient/history")).status).toBe(401);
    expect((await get("/patient/history", reception.token)).status).toBe(403);
    for (const qs of ["scope=everything", "profileId=nope", "year=1800", "year=abc", "limit=0"]) {
      expect((await get(`/patient/history?${qs}`, aliceToken)).status, qs).toBe(400);
    }
  });
});
