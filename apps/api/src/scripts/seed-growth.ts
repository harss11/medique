/**
 * Sample data for the Phase 8 features: subscription plans, and finished visits with reviews so
 * the history page and the ratings on doctor pages have something to show. Both are safe to run
 * again: they only create what is missing.
 */
import { prisma } from "../lib/prisma.js";

export const SAMPLE_PLANS = [
  {
    code: "pilot",
    name: "Pilot",
    description: "Free during the pilot. No limits.",
    priceMonthly: 0,
    sortOrder: 0,
  },
  {
    code: "starter",
    name: "Starter",
    description: "For a small clinic: a few doctors, essentials only.",
    priceMonthly: 999_00,
    maxDoctors: 3,
    maxStaff: 3,
    maxMonthlyBookings: 300,
    analytics: false,
    slipPrinting: true,
    sortOrder: 10,
  },
  {
    code: "standard",
    name: "Standard",
    description: "For a hospital: more doctors and staff, analytics included.",
    priceMonthly: 2_999_00,
    maxDoctors: 15,
    maxStaff: 15,
    maxMonthlyBookings: 3000,
    sortOrder: 20,
  },
  {
    code: "unlimited",
    name: "Unlimited",
    description: "No limits, every feature.",
    priceMonthly: 7_999_00,
    sortOrder: 30,
  },
];

/** The sample plans, and the hospital on the free pilot plan if it has no subscription yet. */
export async function seedPlans(hospitalId: string, assignedById: string | null) {
  for (const plan of SAMPLE_PLANS) {
    await prisma.plan.upsert({ where: { code: plan.code }, update: plan, create: plan });
  }
  const pilot = await prisma.plan.findUniqueOrThrow({ where: { code: "pilot" } });
  await prisma.subscription.upsert({
    where: { hospitalId },
    update: {},
    create: { hospitalId, planId: pilot.id, status: "ACTIVE", assignedById },
  });
}

export interface DemoVisit {
  /** Unique and stable: it is the visit's check-in code, so running the seed again skips it. */
  key: string;
  doctor: { id: string; departmentId: string; consultationFee: number };
  daysAgo: number;
  /** 0 for no review. */
  rating: number;
  comment: string;
}

/** Finished online visits of one patient (their own profile), some with a review. Returns how many were created. */
export async function seedDemoVisits(
  hospital: { id: string; commissionPercent: { toString(): string } | number },
  patientUserId: string,
  visits: DemoVisit[],
): Promise<number> {
  const profile = await prisma.patientProfile.findFirst({
    where: { userId: patientUserId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!profile) return 0;

  let created = 0;
  for (const v of visits) {
    if (await prisma.appointment.findUnique({ where: { checkInCode: v.key } })) continue;
    const startAt = new Date(Date.now() - v.daysAgo * 86_400_000);
    startAt.setUTCHours(4, 30, 0, 0); // 10:00 in India
    const endAt = new Date(startAt.getTime() + 15 * 60_000);
    const day = new Date(
      Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()),
    );
    const slot =
      (await prisma.slot.findFirst({ where: { doctorId: v.doctor.id, startAt } })) ??
      (await prisma.slot.create({
        data: {
          hospitalId: hospital.id,
          doctorId: v.doctor.id,
          date: day,
          startAt,
          endAt,
          capacity: 1,
          bookedCount: 1,
        },
      }));
    const appointment = await prisma.appointment.create({
      data: {
        hospitalId: hospital.id,
        departmentId: v.doctor.departmentId,
        doctorId: v.doctor.id,
        slotId: slot.id,
        patientProfileId: profile.id,
        bookedById: patientUserId,
        source: "ONLINE",
        status: "COMPLETED",
        appointmentDate: day,
        slotStart: startAt,
        slotEnd: endAt,
        seatNumber: 1,
        tokenNumber: 1,
        confirmedAt: startAt,
        completedAt: endAt,
        feeAmount: v.doctor.consultationFee,
        commissionPercent: Number(hospital.commissionPercent.toString()),
        checkInCode: v.key,
        reasonForVisit: "Check-up (sample data)",
      },
    });
    await prisma.payment.create({
      data: {
        appointmentId: appointment.id,
        hospitalId: hospital.id,
        method: "ONLINE",
        provider: "MOCK",
        status: "CAPTURED",
        amount: v.doctor.consultationFee,
        paidAt: startAt,
      },
    });
    if (v.rating > 0) {
      await prisma.review.create({
        data: {
          appointmentId: appointment.id,
          hospitalId: hospital.id,
          doctorId: v.doctor.id,
          userId: patientUserId,
          rating: v.rating,
          comment: v.comment,
        },
      });
    }
    created++;
  }
  return created;
}
