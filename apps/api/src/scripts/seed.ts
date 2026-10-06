/**
 * Development seed. Safe to run repeatedly (upserts). Re-running resets the
 * seeded accounts' passwords, which is handy for re-testing the forced reset.
 *
 *   pnpm db:seed
 */
import { env } from "../config/env.js";
import type { Role } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { syncDoctorSlots } from "../modules/slots/slots.service.js";
import { randomToken } from "../utils/crypto.js";
import { hashPassword } from "../utils/password.js";
import { seedBlood } from "./seed-blood.js";
import { seedDemoVisits, seedPlans } from "./seed-growth.js";

if (env.NODE_ENV === "production") {
  console.error("Refusing to seed a production database.");
  process.exit(1);
}

const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Admin@12345";

const STAFF: Array<{
  key: string;
  role: Role;
  loginId: string;
  password: string;
  name: string;
  mustChangePassword: boolean;
  hospital: boolean;
}> = [
  {
    key: "admin",
    role: "ADMIN",
    loginId: "admin",
    password: ADMIN_PASSWORD,
    name: "Platform Admin",
    mustChangePassword: false,
    hospital: false,
  },
  {
    key: "hospital",
    role: "HOSPITAL_ADMIN",
    loginId: "sunrise.admin",
    password: "Temp@12345",
    name: "Sunrise Hospital Admin",
    mustChangePassword: true,
    hospital: true,
  },
  {
    key: "reception",
    role: "RECEPTIONIST",
    loginId: "sunrise.reception",
    password: "Reception@123",
    name: "Kavita Rao",
    mustChangePassword: false,
    hospital: true,
  },
  {
    key: "doctor",
    role: "DOCTOR",
    loginId: "dr.sharma",
    password: "Doctor@123",
    name: "Dr. Anil Sharma",
    mustChangePassword: false,
    hospital: true,
  },
];

const DEPARTMENTS = [
  "General Medicine",
  "Cardiology",
  "Paediatrics",
  "Orthopaedics",
  "Dermatology",
];

// Times are minutes from local midnight. Days: 0 = Sunday ... 6 = Saturday.
const MON_SAT = [1, 2, 3, 4, 5, 6];
const DOCTORS = [
  {
    name: "Dr. Anil Sharma",
    department: "General Medicine",
    qualification: "MBBS, MD (Internal Medicine)",
    specialization: "General Physician",
    experienceYears: 14,
    gender: "MALE" as const,
    languages: ["English", "Hindi"],
    fee: 500_00,
    avgConsultMinutes: 10,
    login: true,
    sessions: [{ days: MON_SAT, start: 9 * 60, end: 13 * 60, slot: 15, capacity: 1 }],
  },
  {
    name: "Dr. Priya Mehta",
    department: "Cardiology",
    qualification: "MBBS, MD, DM (Cardiology)",
    specialization: "Interventional Cardiologist",
    experienceYears: 18,
    gender: "FEMALE" as const,
    languages: ["English", "Hindi", "Gujarati"],
    fee: 1000_00,
    avgConsultMinutes: 15,
    login: false,
    sessions: [
      { days: [1, 3, 5], start: 10 * 60, end: 14 * 60, slot: 20, capacity: 1 },
      { days: [2, 4], start: 17 * 60, end: 20 * 60, slot: 20, capacity: 1 },
    ],
  },
  {
    name: "Dr. Rahul Verma",
    department: "Paediatrics",
    qualification: "MBBS, DCH",
    specialization: "Paediatrician",
    experienceYears: 9,
    gender: "MALE" as const,
    languages: ["English", "Hindi"],
    fee: 600_00,
    avgConsultMinutes: 8,
    login: false,
    sessions: [{ days: MON_SAT, start: 9 * 60 + 30, end: 12 * 60 + 30, slot: 15, capacity: 2 }],
  },
  {
    name: "Dr. Sneha Iyer",
    department: "Orthopaedics",
    qualification: "MBBS, MS (Ortho)",
    specialization: "Joint Replacement",
    experienceYears: 12,
    gender: "FEMALE" as const,
    languages: ["English", "Tamil", "Hindi"],
    fee: 800_00,
    avgConsultMinutes: 12,
    login: false,
    sessions: [{ days: [2, 4, 6], start: 11 * 60, end: 15 * 60, slot: 20, capacity: 1 }],
  },
  {
    name: "Dr. Farhan Khan",
    department: "Dermatology",
    qualification: "MBBS, MD (Dermatology)",
    specialization: "Dermatologist",
    experienceYears: 7,
    gender: "MALE" as const,
    languages: ["English", "Hindi", "Urdu"],
    fee: 700_00,
    avgConsultMinutes: 10,
    login: false,
    sessions: [{ days: [1, 2, 3, 4, 5], start: 16 * 60, end: 19 * 60, slot: 15, capacity: 1 }],
  },
];

async function main() {
  console.warn("Seeding database...");

  const hospitalData = {
    name: "Sunrise Multispeciality Hospital",
    status: "ACTIVE" as const,
    description: "A 120-bed multispeciality hospital (sample data).",
    phone: "+911140000000",
    email: "contact@sunrise.example",
    emergencyPhone: "+911140000911",
    addressLine1: "12 Ring Road, Lajpat Nagar",
    city: "New Delhi",
    state: "Delhi",
    postalCode: "110024",
    country: "IN",
    latitude: 28.5677,
    longitude: 77.2433,
    commissionPercent: 10,
    totalBeds: 120,
    availableBeds: 18,
    bedsUpdatedAt: new Date(),
    approvedAt: new Date(),
  };
  const hospital = await prisma.hospital.upsert({
    where: { slug: "sunrise-hospital" },
    update: hospitalData,
    create: { slug: "sunrise-hospital", ...hospitalData },
  });

  const users: Record<string, { id: string }> = {};
  for (const s of STAFF) {
    const data = {
      role: s.role,
      name: s.name,
      status: "ACTIVE" as const,
      passwordHash: await hashPassword(s.password),
      mustChangePassword: s.mustChangePassword,
      hospitalId: s.hospital ? hospital.id : null,
      failedLoginCount: 0,
      lockedUntil: null,
    };
    users[s.key] = await prisma.user.upsert({
      where: { loginId: s.loginId },
      update: { ...data, tokenVersion: { increment: 1 } },
      create: { loginId: s.loginId, ...data },
      select: { id: true },
    });
  }
  // Ensure the hospital row records who created and approved it.
  await prisma.hospital.update({
    where: { id: hospital.id },
    data: { createdById: users.admin!.id, approvedById: users.admin!.id },
  });

  const departments: Record<string, string> = {};
  for (const [i, name] of DEPARTMENTS.entries()) {
    const d = await prisma.department.upsert({
      where: { hospitalId_name: { hospitalId: hospital.id, name } },
      update: { sortOrder: i, isActive: true },
      create: { hospitalId: hospital.id, name, sortOrder: i },
    });
    departments[name] = d.id;
  }

  for (const doc of DOCTORS) {
    const data = {
      hospitalId: hospital.id,
      departmentId: departments[doc.department]!,
      userId: doc.login ? users.doctor!.id : null,
      name: doc.name,
      qualification: doc.qualification,
      specialization: doc.specialization,
      experienceYears: doc.experienceYears,
      gender: doc.gender,
      languages: doc.languages,
      consultationFee: doc.fee,
      avgConsultMinutes: doc.avgConsultMinutes,
      isActive: true,
    };
    const existing = await prisma.doctor.findFirst({
      where: { hospitalId: hospital.id, name: doc.name },
      select: { id: true },
    });
    const doctor = existing
      ? await prisma.doctor.update({ where: { id: existing.id }, data })
      : await prisma.doctor.create({ data: { ...data, qrToken: randomToken(16) } });

    await prisma.doctorSchedule.deleteMany({ where: { doctorId: doctor.id } });
    await prisma.doctorSchedule.createMany({
      data: doc.sessions.flatMap((s) =>
        s.days.map((dayOfWeek) => ({
          doctorId: doctor.id,
          dayOfWeek,
          startMinute: s.start,
          endMinute: s.end,
          slotMinutes: s.slot,
          capacityPerSlot: s.capacity,
        })),
      ),
    });
  }

  // A default A5 slip template (148 x 210 mm), so printing works out of the box. Positions are
  // illustrative: the hospital adjusts them on its own pre-printed paper in the slip editor.
  const slipFields = [
    {
      key: "patientName",
      xMm: 32,
      yMm: 52,
      maxWidthMm: 70,
      fontSizePt: 12,
      bold: true,
      align: "left",
    },
    {
      key: "patientAgeGender",
      xMm: 108,
      yMm: 52,
      maxWidthMm: 30,
      fontSizePt: 11,
      bold: false,
      align: "left",
    },
    { key: "date", xMm: 32, yMm: 62, maxWidthMm: 40, fontSizePt: 11, bold: false, align: "left" },
    { key: "time", xMm: 78, yMm: 62, maxWidthMm: 24, fontSizePt: 11, bold: false, align: "left" },
    {
      key: "tokenNumber",
      xMm: 108,
      yMm: 60,
      maxWidthMm: 30,
      fontSizePt: 20,
      bold: true,
      align: "left",
    },
    {
      key: "doctorName",
      xMm: 32,
      yMm: 72,
      maxWidthMm: 70,
      fontSizePt: 11,
      bold: false,
      align: "left",
    },
    {
      key: "department",
      xMm: 32,
      yMm: 80,
      maxWidthMm: 70,
      fontSizePt: 10,
      bold: false,
      align: "left",
    },
    {
      key: "reasonForVisit",
      xMm: 32,
      yMm: 90,
      maxWidthMm: 106,
      fontSizePt: 10,
      bold: false,
      align: "left",
    },
  ];
  const existingSlip = await prisma.slipTemplate.findFirst({
    where: { hospitalId: hospital.id, name: "OPD slip (A5)" },
  });
  if (!existingSlip) {
    await prisma.slipTemplate.create({
      data: {
        hospitalId: hospital.id,
        name: "OPD slip (A5)",
        paperWidthMm: 148,
        paperHeightMm: 210,
        fields: slipFields,
        isDefault: true,
      },
    });
  }

  // Generate bookable slots for the rolling window from the schedules above.
  let slotCount = 0;
  const seededDoctors = await prisma.doctor.findMany({
    where: { hospitalId: hospital.id },
    select: { id: true },
  });
  for (const { id } of seededDoctors) {
    const summary = await syncDoctorSlots(id);
    slotCount += summary.created;
  }

  // A test patient with one family member. Log in with this number; the OTP prints in the API console.
  const patientPhone = "+919876543210";
  const patient = await prisma.user.upsert({
    where: { phone: patientPhone },
    update: { name: "Test Patient", status: "ACTIVE" },
    create: {
      role: "PATIENT",
      name: "Test Patient",
      phone: patientPhone,
      consents: {
        create: [
          { type: "PRIVACY_POLICY", version: env.PRIVACY_POLICY_VERSION },
          { type: "TERMS_OF_SERVICE", version: env.TERMS_VERSION },
        ],
      },
      patientProfiles: {
        create: [
          {
            relation: "SELF",
            fullName: "Test Patient",
            phone: patientPhone,
            gender: "UNDISCLOSED",
          },
          {
            relation: "CHILD",
            fullName: "Aarav (child)",
            dateOfBirth: new Date("2018-04-12"),
            gender: "MALE",
          },
        ],
      },
    },
    select: { id: true },
  });

  // Subscription plans, and sample visits and reviews for the test patient.
  await seedPlans(hospital.id, users.admin!.id);
  const byName = new Map(
    (await prisma.doctor.findMany({ where: { hospitalId: hospital.id } })).map((d) => [d.name, d]),
  );
  const visit = (key: string, name: string, daysAgo: number, rating: number, comment: string) => ({
    key,
    doctor: byName.get(name)!,
    daysAgo,
    rating,
    comment,
  });
  await seedDemoVisits(hospital, patient.id, [
    visit(
      "seed-visit-1",
      "Dr. Rahul Verma",
      5,
      5,
      "Very patient with my son. Explained everything clearly.",
    ),
    visit("seed-visit-2", "Dr. Sneha Iyer", 12, 4, "Short wait and a clear plan."),
    visit("seed-visit-3", "Dr. Farhan Khan", 40, 0, ""),
  ]);

  const blood = await seedBlood();

  console.warn(`
Seed complete.

  Hospital : ${hospital.name}  (/h/${hospital.slug})
  Doctors  : ${DOCTORS.length} across ${DEPARTMENTS.length} departments
  Slots    : ${slotCount} new slots generated for the next ${env.SLOT_WINDOW_DAYS} days

  Logins (staff portal)            password
  admin              /admin/login      ${process.env.SEED_ADMIN_PASSWORD ? "(SEED_ADMIN_PASSWORD)" : ADMIN_PASSWORD}
  sunrise.admin      /hospital/login   Temp@12345   (must change on first login)
  sunrise.reception  /reception/login  Reception@123
  dr.sharma          /doctor/login     Doctor@123

  Patient: /login with 98765 43210 (OTP is printed in the API console)
  Patient user id: ${patient.id}
  Plans    : pilot (this hospital), starter, standard, unlimited. Sample visits and reviews for the test patient.
${blood.summary}
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
