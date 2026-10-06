/**
 * Donors and donations: registering with consent, the waiting period and age limits, and
 * donations that only blood bank staff can record. On a real PostgreSQL.
 * Run with `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  call,
  cleanupBlood,
  createBank,
  createDonor,
  newCreated,
  sentTo,
  startServer,
  tokenFor,
  validPhone,
} from "../../../test/blood-helpers.js";

const created = newCreated();
let base: string;
let closeServer: () => Promise<void>;
let bank: Awaited<ReturnType<typeof createBank>>;
let otherBank: Awaited<ReturnType<typeof createBank>>;

const api = (method: string, path: string, token?: string, body?: unknown) =>
  call(base, method, path, token, body);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const enc = encodeURIComponent;

beforeAll(async () => {
  const server = await startServer();
  base = server.base;
  closeServer = server.close;
  bank = await createBank(created, { name: "Donation Bank" });
  otherBank = await createBank(created, { name: "Other Donation Bank" });
});

afterAll(async () => {
  await closeServer();
  await cleanupBlood(created);
  await prisma.$disconnect();
});

describe("registering as a donor", () => {
  async function patient() {
    const phone = validPhone();
    const user = await prisma.user.create({
      data: { role: "PATIENT", name: "Sunita Devi", phone },
    });
    created.userIds.push(user.id);
    created.phones.push(phone);
    return { id: user.id, token: tokenFor(user.id, "PATIENT") };
  }
  const profile = (over: Record<string, unknown> = {}) => ({
    bloodGroup: "B_POS",
    gender: "FEMALE",
    dateOfBirth: "1992-04-10",
    city: "Testville",
    latitude: 28.567712,
    longitude: 77.243391,
    acceptAlerts: true,
    ...over,
  });

  it("starts as not a donor, and needs the donor to agree to alerts the first time", async () => {
    const p = await patient();
    expect((await api("GET", "/donor/profile", p.token)).data.profile).toBeNull();
    expect((await api("PATCH", "/donor/availability", p.token, { isAvailable: false })).code).toBe(
      "NOT_A_DONOR",
    );

    const refused = await api("PUT", "/donor/profile", p.token, profile({ acceptAlerts: false }));
    expect(refused.code).toBe("CONSENT_REQUIRED");
    expect(
      (await api("PUT", "/donor/profile", p.token, profile({ acceptAlerts: undefined }))).code,
    ).toBe("CONSENT_REQUIRED");

    const made = await api("PUT", "/donor/profile", p.token, profile());
    expect(made.status).toBe(200);
    expect(made.data.profile).toMatchObject({
      bloodGroup: "B_POS",
      isAvailable: true,
      eligible: true,
      canBeAlerted: true,
      hasLocation: true,
    });
    const consent = await prisma.consentRecord.findFirst({
      where: { userId: p.id, type: "DONOR_ALERTS" },
    });
    expect(consent).not.toBeNull();
  });

  it("stores the location only to about a kilometre", async () => {
    const p = await patient();
    await api("PUT", "/donor/profile", p.token, profile());
    const row = await prisma.donorProfile.findUniqueOrThrow({ where: { userId: p.id } });
    expect([row.latitude, row.longitude]).toEqual([28.57, 77.24]);
  });

  it("accepts only donors of an allowed age, and checks every field", async () => {
    const p = await patient();
    expect(
      (await api("PUT", "/donor/profile", p.token, profile({ dateOfBirth: "2015-01-01" }))).code,
    ).toBe("DONOR_AGE");
    expect(
      (await api("PUT", "/donor/profile", p.token, profile({ dateOfBirth: "1940-01-01" }))).code,
    ).toBe("DONOR_AGE");
    expect(
      (await api("PUT", "/donor/profile", p.token, profile({ dateOfBirth: "2999-01-01" }))).status,
    ).toBe(400);
    expect(
      (await api("PUT", "/donor/profile", p.token, profile({ bloodGroup: "X_POS" }))).status,
    ).toBe(400);
    expect((await api("PUT", "/donor/profile", p.token, profile({ longitude: null }))).status).toBe(
      400,
    );
    expect((await api("PUT", "/donor/profile", p.token, profile({ city: "" }))).status).toBe(400);
  });

  it("can pause alerts, update details without agreeing again, and stop being a donor", async () => {
    const p = await patient();
    await api("PUT", "/donor/profile", p.token, profile());
    const paused = await api("PATCH", "/donor/availability", p.token, { isAvailable: false });
    expect(paused.data.profile).toMatchObject({
      isAvailable: false,
      canBeAlerted: false,
      eligible: true,
    });

    const moved = await api(
      "PUT",
      "/donor/profile",
      p.token,
      profile({ city: "Newtown", acceptAlerts: undefined }),
    );
    expect(moved.data.profile.city).toBe("Newtown");
    expect(moved.data.profile.isAvailable).toBe(false); // an update does not switch alerts back on

    expect((await api("DELETE", "/donor/profile", p.token)).status).toBe(200);
    expect((await api("GET", "/donor/profile", p.token)).data.profile).toBeNull();
    expect((await api("DELETE", "/donor/profile", p.token)).code).toBe("NOT_A_DONOR");
  });

  it("is for patients only", async () => {
    expect((await api("GET", "/donor/profile", bank.token)).status).toBe(403);
    expect((await api("PUT", "/donor/profile", bank.token, profile())).status).toBe(403);
  });
});

describe("finding a donor at the blood bank", () => {
  it("answers the same way for no account and for an account that is not a donor, and audits each look-up", async () => {
    const stranger = await api(
      "GET",
      "/blood-bank/donors/lookup?phone=" + enc(validPhone()),
      bank.token,
    );
    const phone = validPhone();
    const user = await prisma.user.create({
      data: { role: "PATIENT", name: "Not A Donor", phone },
    });
    created.userIds.push(user.id);
    created.phones.push(phone);
    const notDonor = await api("GET", "/blood-bank/donors/lookup?phone=" + enc(phone), bank.token);
    expect([stranger.status, notDonor.status]).toEqual([404, 404]);
    expect([stranger.code, notDonor.code]).toEqual(["DONOR_NOT_FOUND", "DONOR_NOT_FOUND"]);
    expect(stranger.message).toBe(notDonor.message);
    expect((await api("GET", "/blood-bank/donors/lookup?phone=abc", bank.token)).status).toBe(400);
    expect((await api("GET", "/blood-bank/donors/lookup", bank.token)).status).toBe(400);

    const logs = await prisma.auditLog.findMany({
      where: { action: "donor.looked_up", entityId: bank.bank.id },
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toContain(phone); // only a masked number is kept
  });

  it("shows the donor, their group and whether they may donate now", async () => {
    const d = await createDonor(created, {
      bloodGroup: "A_NEG",
      gender: "FEMALE",
      name: "Meera Shah",
    });
    const found = await api("GET", "/blood-bank/donors/lookup?phone=" + enc(d.phone), bank.token);
    expect(found.data).toMatchObject({
      donorId: d.donorId,
      name: "Meera Shah",
      bloodGroup: "A_NEG",
      eligible: true,
      ineligibleReasons: [],
    });
    expect(found.data.ageYears).toBeGreaterThan(30);
    // Other formats of the same number find the same donor.
    const national = d.phone.replace("+91", "");
    expect(
      (await api("GET", "/blood-bank/donors/lookup?phone=" + enc(national), bank.token)).data
        .donorId,
    ).toBe(d.donorId);
  });
});

describe("the waiting period and age limits", () => {
  const lookup = async (phone: string) =>
    (await api("GET", "/blood-bank/donors/lookup?phone=" + enc(phone), bank.token)).data;

  it("is about 3 months for men: day 89 no, day 91 yes", async () => {
    const early = await createDonor(created, { gender: "MALE", lastDonationAt: daysAgo(89) });
    const late = await createDonor(created, { gender: "MALE", lastDonationAt: daysAgo(91) });
    expect(await lookup(early.phone)).toMatchObject({
      eligible: false,
      ineligibleReasons: ["WAITING_PERIOD"],
    });
    expect((await lookup(early.phone)).nextEligibleAt).toBeTruthy();
    expect((await lookup(late.phone)).eligible).toBe(true);
  });

  it("is about 4 months for women and anyone who did not say: day 100 no, day 121 yes", async () => {
    for (const gender of ["FEMALE", "UNDISCLOSED", "OTHER"] as const) {
      const early = await createDonor(created, { gender, lastDonationAt: daysAgo(100) });
      const late = await createDonor(created, { gender, lastDonationAt: daysAgo(121) });
      expect((await lookup(early.phone)).eligible).toBe(false);
      expect((await lookup(late.phone)).eligible).toBe(true);
    }
  });

  it("refuses donors who are too young or too old", async () => {
    const young = await createDonor(created, { dateOfBirth: "2012-06-01" });
    const old = await createDonor(created, { dateOfBirth: "1940-06-01" });
    expect((await lookup(young.phone)).ineligibleReasons).toEqual(["TOO_YOUNG"]);
    expect((await lookup(old.phone)).ineligibleReasons).toEqual(["TOO_OLD"]);
  });
});

describe("recording a donation", () => {
  it("is something only blood bank staff can do", async () => {
    const d = await createDonor(created);
    const body = { donorId: d.donorId, bloodGroup: "O_POS", volumeMl: 350 };
    expect((await api("POST", "/blood-bank/donations", d.token, body)).status).toBe(403); // the donor cannot add their own
    expect((await api("POST", "/blood-bank/donations", undefined, body)).status).toBe(401);
    expect((await api("POST", "/blood-bank/donations", bank.token, body)).status).toBe(201);
  });

  it("starts the waiting period, settles the blood group, tells the donor and shows in their history", async () => {
    const d = await createDonor(created, { bloodGroup: "O_POS", gender: "MALE" });
    const res = await api("POST", "/blood-bank/donations", bank.token, {
      donorId: d.donorId,
      bloodGroup: "A_POS",
      volumeMl: 450,
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ bloodGroup: "A_POS", volumeMl: 450 });
    const next =
      new Date(res.data.nextEligibleAt).getTime() - new Date(res.data.donatedAt).getTime();
    expect(Math.round(next / 86_400_000)).toBe(90);

    const row = await prisma.donorProfile.findUniqueOrThrow({ where: { id: d.donorId } });
    expect(row.bloodGroup).toBe("A_POS"); // the bank's test settles it
    expect(row.lastDonationAt).not.toBeNull();

    const thanks = await sentTo(d.phone, "donation_recorded");
    expect(thanks).toHaveLength(1);
    expect(thanks[0]!.body).toContain("Donation Bank");
    expect(thanks[0]!.variables?.date).toBeTruthy();

    const mine = await api("GET", "/donor/donations", d.token);
    expect(mine.data.items).toEqual([
      expect.objectContaining({ bloodGroup: "A_POS", volumeMl: 450, bloodBank: "Donation Bank" }),
    ]);
    expect(
      await prisma.auditLog.count({
        where: { action: "donation.recorded", actorId: bank.staff.id },
      }),
    ).toBeGreaterThan(0);
  });

  it("refuses a second donation inside the waiting period and says when they can donate again", async () => {
    const d = await createDonor(created);
    expect(
      (
        await api("POST", "/blood-bank/donations", bank.token, {
          donorId: d.donorId,
          bloodGroup: "O_POS",
        })
      ).status,
    ).toBe(201);
    const again = await api("POST", "/blood-bank/donations", otherBank.token, {
      donorId: d.donorId,
      bloodGroup: "O_POS",
    });
    expect(again.status).toBe(409);
    expect(again.code).toBe("DONOR_NOT_ELIGIBLE");
    expect(again.details.reasons).toEqual(["WAITING_PERIOD"]);
    expect(new Date(again.details.nextEligibleAt).getTime()).toBeGreaterThan(
      Date.now() + 80 * 86_400_000,
    );
  });

  it("lets only one of two simultaneous recordings through", async () => {
    const d = await createDonor(created);
    const results = await Promise.all([
      api("POST", "/blood-bank/donations", bank.token, { donorId: d.donorId, bloodGroup: "O_POS" }),
      api("POST", "/blood-bank/donations", otherBank.token, {
        donorId: d.donorId,
        bloodGroup: "O_POS",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.donation.count({ where: { donorId: d.donorId } })).toBe(1);
  });

  it("checks the details", async () => {
    const d = await createDonor(created);
    const rec = (over: Record<string, unknown>) =>
      api("POST", "/blood-bank/donations", bank.token, {
        donorId: d.donorId,
        bloodGroup: "O_POS",
        ...over,
      });
    expect((await rec({ volumeMl: 100 })).status).toBe(400);
    expect((await rec({ volumeMl: 900 })).status).toBe(400);
    expect((await rec({ bloodGroup: "ZZ" })).status).toBe(400);
    expect((await rec({ donorId: "nope" })).status).toBe(400);
    expect((await rec({ donorId: "00000000-0000-7000-8000-000000000000" })).code).toBe(
      "DONOR_NOT_FOUND",
    );
    expect(await prisma.donation.count({ where: { donorId: d.donorId } })).toBe(0);
  });

  it("locks the blood group in the donor's profile once a bank has confirmed it", async () => {
    const d = await createDonor(created, { bloodGroup: "O_POS" });
    await api("POST", "/blood-bank/donations", bank.token, {
      donorId: d.donorId,
      bloodGroup: "O_POS",
    });
    const change = await api("PUT", "/donor/profile", d.token, {
      bloodGroup: "AB_POS",
      gender: "MALE",
      dateOfBirth: "1990-01-01",
      city: "Testville",
    });
    expect(change.code).toBe("GROUP_CONFIRMED");
  });
});

describe("voiding a donation recorded by mistake", () => {
  it("frees the donor again and restores their earlier waiting period", async () => {
    const d = await createDonor(created, { gender: "MALE", lastDonationAt: daysAgo(200) });
    const earlier = await prisma.donation.create({
      data: {
        donorId: d.donorId,
        bloodBankId: otherBank.bank.id,
        recordedById: otherBank.staff.id,
        bloodGroup: "O_POS",
        volumeMl: 350,
        donatedAt: daysAgo(200),
      },
    });
    const rec = await api("POST", "/blood-bank/donations", bank.token, {
      donorId: d.donorId,
      bloodGroup: "O_POS",
    });
    expect(rec.status).toBe(201);
    expect(
      (
        await api("POST", "/blood-bank/donations", bank.token, {
          donorId: d.donorId,
          bloodGroup: "O_POS",
        })
      ).status,
    ).toBe(409);

    expect(
      (await api("POST", `/blood-bank/donations/${rec.data.id}/void`, bank.token, { reason: "x" }))
        .status,
    ).toBe(400); // a reason
    expect(
      (
        await api("POST", `/blood-bank/donations/${rec.data.id}/void`, otherBank.token, {
          reason: "Not our record",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("POST", `/blood-bank/donations/${rec.data.id}/void`, bank.token, {
          reason: "Wrong donor entered",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("POST", `/blood-bank/donations/${rec.data.id}/void`, bank.token, {
          reason: "Again please",
        })
      ).code,
    ).toBe("ALREADY_VOIDED");

    const row = await prisma.donorProfile.findUniqueOrThrow({ where: { id: d.donorId } });
    expect(row.lastDonationAt?.getTime()).toBe(earlier.donatedAt.getTime()); // back to the real last donation
    expect((await api("GET", "/donor/donations", d.token)).data.items).toHaveLength(1); // the voided one is not shown
    expect(
      (
        await api("POST", "/blood-bank/donations", bank.token, {
          donorId: d.donorId,
          bloodGroup: "O_POS",
        })
      ).status,
    ).toBe(201);
    expect(
      await prisma.auditLog.count({ where: { action: "donation.voided", entityId: rec.data.id } }),
    ).toBe(1);
  });

  it("is possible only within 48 hours", async () => {
    const d = await createDonor(created);
    const rec = await api("POST", "/blood-bank/donations", bank.token, {
      donorId: d.donorId,
      bloodGroup: "O_POS",
    });
    await prisma.donation.update({ where: { id: rec.data.id }, data: { donatedAt: daysAgo(3) } });
    expect(
      (
        await api("POST", `/blood-bank/donations/${rec.data.id}/void`, bank.token, {
          reason: "Too late now",
        })
      ).code,
    ).toBe("VOID_WINDOW_PASSED");
  });

  it("shows the bank its own donations with masked phones and what can still be voided", async () => {
    const list = await api("GET", "/blood-bank/donations?limit=100", bank.token);
    expect(list.data.items.length).toBeGreaterThan(3);
    for (const item of list.data.items)
      expect(item.donorPhone === null || /\*/.test(item.donorPhone)).toBe(true);
    expect(list.data.items.some((i: { canVoid: boolean }) => i.canVoid)).toBe(true);
    expect(list.data.items.some((i: { voided: boolean }) => i.voided)).toBe(true);
    const others = await api("GET", "/blood-bank/donations?limit=100", otherBank.token);
    const mine = new Set(list.data.items.map((i: { id: string }) => i.id));
    expect(others.data.items.every((i: { id: string }) => !mine.has(i.id))).toBe(true);
  });
});
