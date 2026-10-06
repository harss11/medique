import type { AuthContext } from "../src/middleware/authenticate.js";
import { prisma } from "../src/lib/prisma.js";
import { randomToken } from "../src/utils/crypto.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";
import { addDays, dateOnly, todayInZone, zonedTimeToUtc } from "../src/utils/time.js";

export const TZ = "Asia/Kolkata";
const RUN = randomToken(4)
  .replace(/[^a-z0-9]/gi, "x")
  .toLowerCase();

export interface World {
  hospitalId: string;
  departmentId: string;
  doctorId: string;
  userIds: string[];
  doctorIds: string[];
}

export interface Patient {
  userId: string;
  profileId: string;
  auth: AuthContext;
}

/** An ACTIVE hospital with one department and one doctor. Names are unique per run. */
export async function createWorld(options: { fee?: number } = {}): Promise<World> {
  const suffix = `${RUN}-${randomToken(3)
    .replace(/[^a-z0-9]/gi, "x")
    .toLowerCase()}`;
  const hospital = await prisma.hospital.create({
    data: {
      name: `Test Hospital ${suffix}`,
      slug: `test-${suffix}`,
      status: "ACTIVE",
      commissionPercent: 10,
    },
  });
  const department = await prisma.department.create({
    data: { hospitalId: hospital.id, name: "General Medicine" },
  });
  const world: World = {
    hospitalId: hospital.id,
    departmentId: department.id,
    doctorId: "",
    userIds: [],
    doctorIds: [],
  };
  world.doctorId = await createDoctor(world, options.fee ?? 50_000);
  return world;
}

export async function createDoctor(world: World, fee = 50_000): Promise<string> {
  const doctor = await prisma.doctor.create({
    data: {
      hospitalId: world.hospitalId,
      departmentId: world.departmentId,
      name: `Dr. Test ${randomToken(3)}`,
      consultationFee: fee,
      qrToken: randomToken(16),
    },
  });
  world.doctorIds.push(doctor.id);
  return doctor.id;
}

let patientSeq = 0;

export async function createPatients(world: World, count: number): Promise<Patient[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const n = ++patientSeq;
      const user = await prisma.user.create({
        data: {
          role: "PATIENT",
          name: `Patient ${n}`,
          // Unique in the database; real numbers are validated at the API edge, not here.
          phone: `+0${RUN}${n}`,
          patientProfiles: { create: { relation: "SELF", fullName: `Patient ${n}` } },
        },
        include: { patientProfiles: true },
      });
      world.userIds.push(user.id);
      return {
        userId: user.id,
        profileId: user.patientProfiles[0]!.id,
        auth: { userId: user.id, role: "PATIENT" as const, name: user.name, hospitalId: null },
      };
    }),
  );
}

/** Slots on one local day for one doctor; start times never collide. */
export function slotFactory(world: World) {
  const counters = new Map<string, number>();
  return async (
    options: {
      doctorId?: string;
      /** days from today (hospital timezone) */
      dayOffset?: number;
      capacity?: number;
      /** exact start instant; overrides dayOffset */
      startAt?: Date;
      /** slot length in minutes (default 5) */
      durationMin?: number;
      status?: "OPEN" | "BLOCKED";
    } = {},
  ) => {
    const doctorId = options.doctorId ?? world.doctorId;
    let startAt: Date;
    if (options.startAt) {
      startAt = options.startAt;
    } else {
      const day = addDays(todayInZone(TZ), options.dayOffset ?? 3);
      const key = `${doctorId}:${day}`;
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      startAt = zonedTimeToUtc(day, 9 * 60 + n * 5, TZ);
    }
    return prisma.slot.create({
      data: {
        hospitalId: world.hospitalId,
        doctorId,
        date: dateOnly(todayInZone(TZ, startAt)),
        startAt,
        endAt: new Date(startAt.getTime() + (options.durationMin ?? 5) * 60_000),
        capacity: options.capacity ?? 1,
        status: options.status ?? "OPEN",
      },
    });
  };
}

export interface Staff {
  userId: string;
  token: string;
}

/** A staff login for the world's hospital. A DOCTOR login is linked to `doctorId`. */
export async function createStaffUser(
  world: World,
  role: "RECEPTIONIST" | "HOSPITAL_ADMIN" | "DOCTOR",
  options: { doctorId?: string } = {},
): Promise<Staff> {
  const user = await prisma.user.create({
    data: {
      role,
      name: `${role.toLowerCase()} ${randomToken(3)}`,
      loginId: `${role.toLowerCase()}-${randomToken(5).toLowerCase()}`,
      hospitalId: world.hospitalId,
    },
  });
  world.userIds.push(user.id);
  if (role === "DOCTOR") {
    await prisma.doctor.update({
      where: { id: options.doctorId ?? world.doctorId },
      data: { userId: user.id },
    });
  }
  const { token } = signAccessToken({
    id: user.id,
    role,
    hospitalId: world.hospitalId,
    tokenVersion: 0,
  });
  return { userId: user.id, token };
}

let visitSeq = 0;

/**
 * A visit that already happened: a past slot and a COMPLETED appointment booked online by the
 * patient (or another status/source for the cases that must not be reviewable).
 */
export async function pastVisit(
  world: World,
  patient: Patient,
  options: {
    daysAgo?: number;
    status?: "COMPLETED" | "CANCELLED" | "CONFIRMED";
    source?: "ONLINE" | "WALK_IN";
    doctorId?: string;
  } = {},
) {
  const doctorId = options.doctorId ?? world.doctorId;
  const n = ++visitSeq;
  const startAt = new Date(Date.now() - (options.daysAgo ?? 1) * 86_400_000 - n * 300_000);
  const endAt = new Date(startAt.getTime() + 300_000);
  const day = dateOnly(todayInZone(TZ, startAt));
  const slot = await prisma.slot.create({
    data: { hospitalId: world.hospitalId, doctorId, date: day, startAt, endAt, capacity: 1 },
  });
  const status = options.status ?? "COMPLETED";
  return prisma.appointment.create({
    data: {
      hospitalId: world.hospitalId,
      departmentId: world.departmentId,
      doctorId,
      slotId: slot.id,
      patientProfileId: patient.profileId,
      bookedById: patient.userId,
      source: options.source ?? "ONLINE",
      status,
      appointmentDate: day,
      slotStart: startAt,
      slotEnd: endAt,
      seatNumber: status === "CANCELLED" ? null : 1,
      tokenNumber: status === "CANCELLED" ? null : n,
      confirmedAt: startAt,
      completedAt: status === "COMPLETED" ? endAt : null,
      feeAmount: 50_000,
      checkInCode: `pv-${RUN}-${n}`,
    },
  });
}

/** Removes everything a world created (matters only when running against a shared database). */
export async function cleanup(world: World): Promise<void> {
  const { hospitalId, userIds } = world;
  await prisma.review.deleteMany({ where: { hospitalId } });
  await prisma.waitlistEntry.deleteMany({ where: { doctorId: { in: world.doctorIds } } });
  await prisma.refund.deleteMany({ where: { payment: { hospitalId } } });
  await prisma.payment.deleteMany({ where: { hospitalId } });
  const profiles = await prisma.appointment.findMany({
    where: { hospitalId },
    select: { patientProfileId: true },
    distinct: ["patientProfileId"],
  });
  await prisma.appointment.deleteMany({ where: { hospitalId } });
  // Walk-in profiles belong to no user account, so remove them with their appointments.
  await prisma.patientProfile.deleteMany({
    where: { id: { in: profiles.map((p) => p.patientProfileId) }, userId: null },
  });
  await prisma.doctorDay.deleteMany({ where: { doctorId: { in: world.doctorIds } } });
  await prisma.patientProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { hospitalId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.hospital.delete({ where: { id: hospitalId } }); // cascades slots, doctors, departments
}
