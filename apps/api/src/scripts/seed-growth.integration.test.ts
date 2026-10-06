import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import {
  cleanup,
  createDoctor,
  createPatients,
  createWorld,
  type Patient,
  type World,
} from "../../test/fixtures.js";
import { SAMPLE_PLANS, seedDemoVisits, seedPlans } from "./seed-growth.js";

let world: World;
let patient: Patient;
let doctorB: string;
const SAMPLE_ONLY = SAMPLE_PLANS.map((p) => p.code).filter((c) => c !== "pilot");

beforeAll(async () => {
  world = await createWorld();
  [patient] = (await createPatients(world, 1)) as [Patient];
  doctorB = await createDoctor(world);
});

afterAll(async () => {
  if (world) await cleanup(world);
  // The pilot plan comes from a migration and stays; the samples this test added go.
  await prisma.plan.deleteMany({
    where: { code: { in: SAMPLE_ONLY }, subscriptions: { none: {} } },
  });
  await prisma.$disconnect();
});

describe("the sample plans", () => {
  it("are created once, and the hospital starts on the free pilot plan", async () => {
    await seedPlans(world.hospitalId, null);
    await seedPlans(world.hospitalId, null); // again: nothing changes
    const plans = await prisma.plan.findMany({
      where: { code: { in: SAMPLE_PLANS.map((p) => p.code) } },
      orderBy: { sortOrder: "asc" },
    });
    expect(plans.map((p) => p.code)).toEqual(["pilot", "starter", "standard", "unlimited"]);
    expect(plans[1]).toMatchObject({ priceMonthly: 99_900, maxDoctors: 3, analytics: false });
    expect(plans[3]).toMatchObject({ maxDoctors: null, maxStaff: null, maxMonthlyBookings: null });

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { hospitalId: world.hospitalId },
      include: { plan: true },
    });
    expect(sub.plan.code).toBe("pilot");
    expect(await prisma.subscription.count({ where: { hospitalId: world.hospitalId } })).toBe(1);
  });

  it("do not move a hospital that is already on another plan", async () => {
    const standard = await prisma.plan.findUniqueOrThrow({ where: { code: "standard" } });
    await prisma.subscription.update({
      where: { hospitalId: world.hospitalId },
      data: { planId: standard.id },
    });
    await seedPlans(world.hospitalId, null);
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { hospitalId: world.hospitalId },
      include: { plan: true },
    });
    expect(sub.plan.code).toBe("standard");
  });
});

describe("the sample visits", () => {
  it("are finished online visits with payments and reviews, and are not created twice", async () => {
    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });
    const keys = [
      `seed-test-${world.hospitalId.slice(0, 8)}`,
      `seed-test-${world.hospitalId.slice(9, 13)}`,
    ];
    const doctorA = await prisma.doctor.findUniqueOrThrow({ where: { id: world.doctorId } });
    const doctorBRow = await prisma.doctor.findUniqueOrThrow({ where: { id: doctorB } });
    const visits = [
      { key: keys[0]!, doctor: doctorA, daysAgo: 5, rating: 5, comment: "Great" },
      { key: keys[1]!, doctor: doctorBRow, daysAgo: 20, rating: 0, comment: "" },
    ];
    expect(await seedDemoVisits(hospital, patient.userId, visits)).toBe(2);
    expect(await seedDemoVisits(hospital, patient.userId, visits)).toBe(0);

    const appointments = await prisma.appointment.findMany({
      where: { hospitalId: world.hospitalId },
      include: { review: true, payments: true },
      orderBy: { slotStart: "desc" },
    });
    expect(appointments).toHaveLength(2);
    expect(appointments.every((a) => a.status === "COMPLETED" && a.source === "ONLINE")).toBe(true);
    expect(appointments.every((a) => a.slotStart.getTime() < Date.now())).toBe(true);
    expect(appointments[0]!.review).toMatchObject({ rating: 5, comment: "Great" });
    expect(appointments[1]!.review).toBeNull();
    expect(appointments[0]!.payments[0]).toMatchObject({
      status: "CAPTURED",
      amount: doctorA.consultationFee,
    });
  });

  it("do nothing for a patient without a profile", async () => {
    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });
    const none = await prisma.user.create({
      data: { role: "PATIENT", name: "No Profile", phone: `+0seed${Date.now()}` },
    });
    world.userIds.push(none.id);
    const doctor = await prisma.doctor.findUniqueOrThrow({ where: { id: world.doctorId } });
    expect(
      await seedDemoVisits(hospital, none.id, [
        { key: "seed-test-none", doctor, daysAgo: 1, rating: 0, comment: "" },
      ]),
    ).toBe(0);
  });
});
