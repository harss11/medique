import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { BLOOD_STAFF_PASSWORD, seedBlood } from "./seed-blood.js";

const LICENSES = ["DL/BB/2026/0142", "DL/BB/2026/0377"];
const PHONES = ["+919876543221", "+919876543222", "+919876543223"];

/** Removes what the seed created, so other tests never see its sample donors or banks. */
async function removeSeed() {
  const users = await prisma.user.findMany({
    where: { OR: [{ phone: { in: PHONES } }, { bloodBank: { licenseNumber: { in: LICENSES } } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await prisma.donorProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.bloodStock.deleteMany({ where: { bloodBank: { licenseNumber: { in: LICENSES } } } });
  await prisma.bloodBank.deleteMany({ where: { licenseNumber: { in: LICENSES } } });
}

afterAll(async () => {
  await removeSeed();
  await prisma.$disconnect();
});

describe("the blood bank sample data", () => {
  it("creates a verified bank with stock, a waiting bank and three donors, and can run again", async () => {
    await seedBlood();
    await seedBlood(); // repeating changes nothing but resets the staff passwords

    const banks = await prisma.bloodBank.findMany({
      where: { licenseNumber: { in: LICENSES } },
      orderBy: { licenseNumber: "asc" },
    });
    expect(banks.map((b) => b.status)).toEqual(["ACTIVE", "PENDING_VERIFICATION"]);
    expect(await prisma.bloodStock.count({ where: { bloodBankId: banks[0]!.id } })).toBe(8);
    expect(await prisma.bloodStock.count({ where: { bloodBankId: banks[1]!.id } })).toBe(0);

    const staff = await prisma.user.findMany({
      where: { bloodBankId: { in: banks.map((b) => b.id) } },
    });
    expect(staff.map((s) => s.role)).toEqual(["BLOOD_BANK_STAFF", "BLOOD_BANK_STAFF"]);

    const donors = await prisma.donorProfile.findMany({
      where: { user: { phone: { in: PHONES } } },
    });
    expect(donors).toHaveLength(3);
    expect(donors.filter((d) => d.isAvailable)).toHaveLength(2);
    expect(
      await prisma.consentRecord.count({
        where: { type: "DONOR_ALERTS", user: { phone: { in: PHONES } } },
      }),
    ).toBe(3);
    expect(BLOOD_STAFF_PASSWORD.length).toBeGreaterThanOrEqual(10);
  });
});
