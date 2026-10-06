import type { BloodGroup, Gender } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword } from "../utils/password.js";

/**
 * Sample data for the blood bank module (development only): one verified blood bank with stock,
 * one that is waiting for the platform admin to verify it, and three donors. Safe to run again.
 */

export const BLOOD_STAFF_PASSWORD = "Blood@12345";

const BANKS = [
  {
    status: "ACTIVE" as const,
    name: "Lifeline Blood Centre",
    licenseNumber: "DL/BB/2026/0142",
    licenseAuthority: "State Drugs Control, Delhi",
    phone: "+919810000001",
    addressLine1: "4 Defence Colony Road, Lajpat Nagar",
    city: "New Delhi",
    state: "Delhi",
    postalCode: "110024",
    latitude: 28.57,
    longitude: 77.24,
    is24x7: true,
    staffLoginId: "lifeline.staff",
    staffName: "Meena Joshi",
    stock: {
      O_POS: 14,
      O_NEG: 3,
      A_POS: 9,
      A_NEG: 2,
      B_POS: 11,
      B_NEG: 1,
      AB_POS: 4,
      AB_NEG: 0,
    } as Record<BloodGroup, number>,
  },
  {
    status: "PENDING_VERIFICATION" as const,
    name: "Rainbow Blood Bank",
    licenseNumber: "DL/BB/2026/0377",
    licenseAuthority: "State Drugs Control, Delhi",
    phone: "+919810000002",
    addressLine1: "22 Nehru Place",
    city: "New Delhi",
    state: "Delhi",
    postalCode: "110019",
    latitude: 28.549,
    longitude: 77.253,
    is24x7: false,
    staffLoginId: "rainbow.staff",
    staffName: "Arvind Rao",
    stock: null,
  },
];

const DONORS: Array<{
  phone: string;
  name: string;
  bloodGroup: BloodGroup;
  gender: Gender;
  dateOfBirth: string;
  isAvailable: boolean;
  latitude: number;
  longitude: number;
}> = [
  {
    phone: "+919876543221",
    name: "Rahul Mehta",
    bloodGroup: "O_POS",
    gender: "MALE",
    dateOfBirth: "1991-05-14",
    isAvailable: true,
    latitude: 28.57,
    longitude: 77.23,
  },
  {
    phone: "+919876543222",
    name: "Priya Nair",
    bloodGroup: "A_POS",
    gender: "FEMALE",
    dateOfBirth: "1994-11-02",
    isAvailable: true,
    latitude: 28.61,
    longitude: 77.21,
  },
  {
    phone: "+919876543223",
    name: "Imran Sheikh",
    bloodGroup: "B_NEG",
    gender: "MALE",
    dateOfBirth: "1988-03-27",
    isAvailable: false,
    latitude: 28.54,
    longitude: 77.26,
  },
];

export async function seedBlood(): Promise<{ summary: string }> {
  const passwordHash = await hashPassword(BLOOD_STAFF_PASSWORD);
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });

  for (const b of BANKS) {
    const data = {
      name: b.name,
      licenseAuthority: b.licenseAuthority,
      status: b.status,
      phone: b.phone,
      addressLine1: b.addressLine1,
      city: b.city,
      state: b.state,
      postalCode: b.postalCode,
      latitude: b.latitude,
      longitude: b.longitude,
      is24x7: b.is24x7,
      verifiedAt: b.status === "ACTIVE" ? new Date() : null,
      verifiedById: b.status === "ACTIVE" ? (admin?.id ?? null) : null,
    };
    const bank = await prisma.bloodBank.upsert({
      where: { licenseNumber: b.licenseNumber },
      update: data,
      create: { licenseNumber: b.licenseNumber, ...data },
    });
    const staff = {
      role: "BLOOD_BANK_STAFF" as const,
      name: b.staffName,
      status: "ACTIVE" as const,
      passwordHash,
      mustChangePassword: false,
      bloodBankId: bank.id,
      failedLoginCount: 0,
      lockedUntil: null,
    };
    await prisma.user.upsert({
      where: { loginId: b.staffLoginId },
      update: { ...staff, tokenVersion: { increment: 1 } },
      create: { loginId: b.staffLoginId, ...staff },
    });
    if (b.stock) {
      for (const [group, units] of Object.entries(b.stock) as Array<[BloodGroup, number]>) {
        await prisma.bloodStock.upsert({
          where: { bloodBankId_bloodGroup: { bloodBankId: bank.id, bloodGroup: group } },
          update: { units },
          create: { bloodBankId: bank.id, bloodGroup: group, units },
        });
      }
    }
  }

  for (const d of DONORS) {
    const profile = {
      bloodGroup: d.bloodGroup,
      gender: d.gender,
      dateOfBirth: new Date(d.dateOfBirth + "T00:00:00Z"),
      city: "New Delhi",
      latitude: d.latitude,
      longitude: d.longitude,
      isAvailable: d.isAvailable,
      alertsConsentAt: new Date(),
      alertsConsentVersion: env.PRIVACY_POLICY_VERSION,
    };
    await prisma.user.upsert({
      where: { phone: d.phone },
      update: { name: d.name, status: "ACTIVE" },
      create: {
        role: "PATIENT",
        name: d.name,
        phone: d.phone,
        consents: {
          create: [
            { type: "PRIVACY_POLICY", version: env.PRIVACY_POLICY_VERSION },
            { type: "TERMS_OF_SERVICE", version: env.TERMS_VERSION },
            { type: "DONOR_ALERTS", version: env.PRIVACY_POLICY_VERSION },
          ],
        },
      },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { phone: d.phone },
      select: { id: true },
    });
    await prisma.donorProfile.upsert({
      where: { userId: user.id },
      update: profile,
      create: { userId: user.id, ...profile },
    });
  }

  return {
    summary: `
  Blood banks (log in at /blood-bank/login, password ${BLOOD_STAFF_PASSWORD})
    lifeline.staff   Lifeline Blood Centre   verified, with stock
    rainbow.staff    Rainbow Blood Bank      waiting: approve it in Admin > Blood banks
  Donors (log in at /login with the phone, OTP prints in the API terminal)
    98765 43221  Rahul Mehta   O+   available
    98765 43222  Priya Nair    A+   available
    98765 43223  Imran Sheikh  B-   paused`,
  };
}
