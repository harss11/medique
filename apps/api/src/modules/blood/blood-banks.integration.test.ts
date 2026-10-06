/**
 * Blood banks: registering, being verified by the platform admin, stock by group, the public
 * listing, and keeping banks apart. On a real PostgreSQL. Run with `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  call,
  cleanupBlood,
  codeFor,
  createAdmin,
  createBank,
  newCreated,
  startServer,
  validPhone,
  type Reply,
} from "../../../test/blood-helpers.js";

const created = newCreated();
let base: string;
let closeServer: () => Promise<void>;
let admin: string;

const TAG = Math.random().toString(36).slice(2, 7);
const CITY = "Bloodville" + TAG;

beforeAll(async () => {
  const server = await startServer();
  base = server.base;
  closeServer = server.close;
  admin = await createAdmin(created);
});

afterAll(async () => {
  await closeServer();
  await cleanupBlood(created);
  await prisma.$disconnect();
});

const api = (method: string, path: string, token?: string, body?: unknown) =>
  call(base, method, path, token, body);

function registration(phone: string, code: string, over: Record<string, unknown> = {}) {
  return {
    name: "Lifeline Blood Centre " + TAG,
    licenseNumber: "MH/BB/" + TAG.toUpperCase(),
    licenseAuthority: "State Drugs Control",
    phone,
    code,
    addressLine1: "12 Ring Road",
    city: CITY,
    state: "Delhi",
    latitude: 28.61,
    longitude: 77.2,
    is24x7: true,
    staff: { name: "Dr. Mehra", loginId: "lifeline." + TAG, password: "Str0ng-pass-12" },
    acceptPrivacyPolicy: true,
    acceptTerms: true,
    ...over,
  };
}

async function track(r: Reply) {
  const bank = await prisma.bloodBank.findUnique({ where: { id: r.data.id } });
  if (bank) {
    created.bankIds.push(bank.id);
    created.phones.push(bank.phone);
    const staff = await prisma.user.findMany({
      where: { bloodBankId: bank.id },
      select: { id: true },
    });
    created.userIds.push(...staff.map((s) => s.id));
  }
}

describe("registering a blood bank", () => {
  const phone = validPhone();
  let bankId = "";
  let token = "";

  it("needs the code sent to the contact phone, and does not spend it on a mistake elsewhere", async () => {
    created.phones.push(phone);
    const code = await codeFor(base, phone, "BANK_REGISTRATION");

    const wrong = await api(
      "POST",
      "/blood/banks/register",
      undefined,
      registration(phone, code === "000000" ? "111111" : "000000"),
    );
    expect(wrong.code).toBe("OTP_INVALID");

    // A taken login ID is reported before the code is used up.
    const taken = await prisma.user.create({
      data: { role: "ADMIN", name: "x", loginId: "lifeline." + TAG },
    });
    created.userIds.push(taken.id);
    const clash = await api("POST", "/blood/banks/register", undefined, registration(phone, code));
    expect(clash.code).toBe("LOGIN_ID_TAKEN");
    await prisma.user.delete({ where: { id: taken.id } });
    created.userIds.pop();

    const done = await api("POST", "/blood/banks/register", undefined, registration(phone, code));
    expect(done.status).toBe(201);
    expect(done.data).toMatchObject({ status: "PENDING_VERIFICATION" });
    bankId = done.data.id;
    await track(done);
  });

  it("lets the new staff member sign in, but the bank is not listed and cannot operate yet", async () => {
    const login = await api("POST", "/auth/staff/login", undefined, {
      loginId: "lifeline." + TAG,
      password: "Str0ng-pass-12",
    });
    expect(login.status).toBe(200);
    expect(login.data.user).toMatchObject({
      role: "BLOOD_BANK_STAFF",
      bloodBank: { id: bankId, status: "PENDING_VERIFICATION" },
    });
    token = login.data.accessToken;

    const listed = await api("GET", "/public/blood-banks?city=" + CITY);
    expect(listed.data.items.map((b: { id: string }) => b.id)).not.toContain(bankId);
    expect((await api("GET", "/public/blood-banks/" + bankId)).status).toBe(404);

    const stock = await api("PUT", "/blood-bank/stock", token, {
      items: [{ bloodGroup: "O_POS", units: 3 }],
    });
    expect(stock.status).toBe(403);
    expect(stock.code).toBe("BANK_NOT_VERIFIED");
    expect((await api("GET", "/blood-bank/donors/lookup?phone=9876543210", token)).code).toBe(
      "BANK_NOT_VERIFIED",
    );
    expect(
      (await api("POST", "/blood-bank/donations", token, { donorId: bankId, bloodGroup: "O_POS" }))
        .code,
    ).toBe("BANK_NOT_VERIFIED");
    // It can read its own profile to see where it stands.
    expect((await api("GET", "/blood-bank/profile", token)).data.status).toBe(
      "PENDING_VERIFICATION",
    );
  });

  it("refuses a licence that is already registered (any case or spacing) and bad input", async () => {
    const other = validPhone();
    created.phones.push(other);
    const code = await codeFor(base, other, "BANK_REGISTRATION");
    const dup = await api(
      "POST",
      "/blood/banks/register",
      undefined,
      registration(other, code, {
        licenseNumber: " mh/bb/" + TAG + " ",
        staff: { name: "Other", loginId: "other." + TAG, password: "Str0ng-pass-12" },
      }),
    );
    expect(dup.code).toBe("LICENSE_EXISTS");

    const bad = (over: Record<string, unknown>) =>
      api("POST", "/blood/banks/register", undefined, registration(other, code, over));
    expect((await bad({ acceptTerms: false })).status).toBe(400);
    expect((await bad({ latitude: 95 })).status).toBe(400);
    expect((await bad({ longitude: null })).status).toBe(400); // coordinates come as a pair
    expect((await bad({ phone: "12345" })).status).toBe(400);
    expect(
      (await bad({ staff: { name: "A", loginId: "ok.login", password: "short" } })).status,
    ).toBe(400);
    expect((await bad({ licenseValidUntil: "2020-01-01" })).status).toBe(400);
  });

  it("is listed only after the platform admin approves it, and only the admin can", async () => {
    expect((await api("POST", `/admin/blood-banks/${bankId}/approve`, token)).status).toBe(403);
    const waiting = await api(
      "GET",
      "/admin/blood-banks?status=PENDING_VERIFICATION&search=" + TAG,
      admin,
    );
    expect(waiting.data.items.map((b: { id: string }) => b.id)).toContain(bankId);

    const approved = await api("POST", `/admin/blood-banks/${bankId}/approve`, admin);
    expect(approved.data.status).toBe("ACTIVE");
    expect((await api("POST", `/admin/blood-banks/${bankId}/approve`, admin)).code).toBe(
      "INVALID_STATUS",
    );

    const listed = await api("GET", "/public/blood-banks?city=" + CITY);
    expect(listed.data.items.map((b: { id: string }) => b.id)).toContain(bankId);
    expect(
      (await api("PUT", "/blood-bank/stock", token, { items: [{ bloodGroup: "O_POS", units: 3 }] }))
        .status,
    ).toBe(200);
    expect(
      await prisma.auditLog.count({ where: { action: "blood_bank.approved", entityId: bankId } }),
    ).toBe(1);
  });

  it("locks the name and licence once verified, but lets the staff update contact details", async () => {
    const locked = await api("PATCH", "/blood-bank/profile", token, {
      name: "Another Name Entirely",
    });
    expect(locked.code).toBe("FIELD_LOCKED");
    const edited = await api("PATCH", "/blood-bank/profile", token, {
      operatingHours: "Open all day",
      is24x7: false,
    });
    expect(edited.data).toMatchObject({
      operatingHours: "Open all day",
      is24x7: false,
      status: "ACTIVE",
    });
  });

  it("can be blocked, which ends its staff sessions at once", async () => {
    expect((await api("POST", `/admin/blood-banks/${bankId}/block`, admin, {})).status).toBe(400); // a reason is needed
    const blocked = await api("POST", `/admin/blood-banks/${bankId}/block`, admin, {
      reason: "Licence lapsed",
    });
    expect(blocked.data).toMatchObject({ status: "BLOCKED", blockedReason: "Licence lapsed" });
    expect((await api("GET", "/blood-bank/profile", token)).status).not.toBe(200);
    const login = await api("POST", "/auth/staff/login", undefined, {
      loginId: "lifeline." + TAG,
      password: "Str0ng-pass-12",
    });
    expect(login.code).toBe("BLOOD_BANK_BLOCKED");
    const listed = await api("GET", "/public/blood-banks?city=" + CITY);
    expect(listed.data.items.map((b: { id: string }) => b.id)).not.toContain(bankId);

    expect((await api("POST", `/admin/blood-banks/${bankId}/unblock`, admin)).data.status).toBe(
      "ACTIVE",
    );
    expect(
      (
        await api("POST", "/auth/staff/login", undefined, {
          loginId: "lifeline." + TAG,
          password: "Str0ng-pass-12",
        })
      ).status,
    ).toBe(200);
  });
});

describe("a rejected blood bank", () => {
  it("sees why, fixes the details and goes back for verification", async () => {
    const { bank, token } = await createBank(created, {
      status: "PENDING_VERIFICATION",
      city: CITY,
    });
    const reject = await api("POST", `/admin/blood-banks/${bank.id}/reject`, admin, {
      reason: "Licence number does not match the register",
    });
    expect(reject.data.status).toBe("REJECTED");
    const mine = await api("GET", "/blood-bank/profile", token);
    expect(mine.data).toMatchObject({
      status: "REJECTED",
      rejectedReason: "Licence number does not match the register",
    });
    expect(
      (await api("PUT", "/blood-bank/stock", token, { items: [{ bloodGroup: "A_POS", units: 1 }] }))
        .message,
    ).toMatch(/could not verify/);

    const fixed = await api("PATCH", "/blood-bank/profile", token, {
      licenseNumber: "NEW-LIC-" + TAG.toUpperCase(),
    });
    expect(fixed.data).toMatchObject({
      status: "PENDING_VERIFICATION",
      rejectedReason: null,
      licenseNumber: "NEW-LIC-" + TAG.toUpperCase(),
    });
    expect(
      (await api("POST", `/admin/blood-banks/${bank.id}/reject`, admin, { reason: "Still wrong" }))
        .data.status,
    ).toBe("REJECTED");
    expect((await api("POST", `/admin/blood-banks/${bank.id}/approve`, admin)).code).toBe(
      "INVALID_STATUS",
    ); // rejected must resubmit first
  });
});

describe("stock and the public listing", () => {
  const city = "Stockville" + TAG;
  let near: Awaited<ReturnType<typeof createBank>>;
  let far: Awaited<ReturnType<typeof createBank>>;
  let other: Awaited<ReturnType<typeof createBank>>;

  beforeAll(async () => {
    near = await createBank(created, { city, lat: 28.62, lng: 77.21, name: "Near Bank " + TAG });
    far = await createBank(created, { city, lat: 28.9, lng: 77.5, name: "Far Bank " + TAG });
    other = await createBank(created, { city: "Elsewhere" + TAG, lat: 19.07, lng: 72.87 });
    await createBank(created, { city, status: "PENDING_VERIFICATION" });
  });

  it("starts with eight groups at zero and saves what staff report, audited", async () => {
    const empty = await api("GET", "/blood-bank/stock", near.token);
    expect(empty.data.items).toHaveLength(8);
    expect(empty.data.items.every((s: { units: number }) => s.units === 0)).toBe(true);

    const put = await api("PUT", "/blood-bank/stock", near.token, {
      items: [
        { bloodGroup: "O_POS", units: 12 },
        { bloodGroup: "A_NEG", units: 2 },
      ],
    });
    expect(
      put.data.items.find((s: { bloodGroup: string }) => s.bloodGroup === "O_POS"),
    ).toMatchObject({ units: 12, stale: false });
    const again = await api("PUT", "/blood-bank/stock", near.token, {
      items: [{ bloodGroup: "O_POS", units: 9 }],
    });
    expect(
      again.data.items.find((s: { bloodGroup: string }) => s.bloodGroup === "A_NEG").units,
    ).toBe(2); // others untouched
    const audit = await prisma.auditLog.findFirst({
      where: { action: "blood_stock.updated", entityId: near.bank.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toMatchObject({ before: { O_POS: 12 }, after: { O_POS: 9 } });
  });

  it("rejects impossible stock", async () => {
    const put = (items: unknown) => api("PUT", "/blood-bank/stock", near.token, { items });
    expect((await put([{ bloodGroup: "O_POS", units: -1 }])).status).toBe(400);
    expect((await put([{ bloodGroup: "O_POS", units: 1.5 }])).status).toBe(400);
    expect((await put([{ bloodGroup: "Z_POS", units: 1 }])).status).toBe(400);
    expect(
      (
        await put([
          { bloodGroup: "O_POS", units: 1 },
          { bloodGroup: "O_POS", units: 2 },
        ])
      ).status,
    ).toBe(400);
    expect((await put([])).status).toBe(400);
  });

  it("lists verified banks only, filtered by city, group and stock, nearest first", async () => {
    await api("PUT", "/blood-bank/stock", far.token, {
      items: [
        { bloodGroup: "O_POS", units: 0 },
        { bloodGroup: "B_POS", units: 4 },
      ],
    });

    const here = await api("GET", `/public/blood-banks?city=${city}&lat=28.6139&lng=77.209`);
    expect(here.data.located).toBe(true);
    expect(here.data.items.map((b: { name: string }) => b.name)).toEqual([
      "Near Bank " + TAG,
      "Far Bank " + TAG,
    ]);
    expect(here.data.items[0].distanceKm).toBeLessThan(here.data.items[1].distanceKm);

    const needO = await api(
      "GET",
      `/public/blood-banks?city=${city}&bloodGroup=O_POS&inStock=true`,
    );
    expect(needO.data.items.map((b: { name: string }) => b.name)).toEqual(["Near Bank " + TAG]);
    const needB = await api(
      "GET",
      `/public/blood-banks?city=${city}&bloodGroup=B_POS&inStock=true`,
    );
    expect(needB.data.items.map((b: { name: string }) => b.name)).toEqual(["Far Bank " + TAG]);

    const all = await api("GET", "/public/blood-banks?city=" + city);
    expect(all.data.items).toHaveLength(2); // the pending bank is not there
    expect(all.data.items[0].stock).toHaveLength(8);
    expect(JSON.stringify(all.data)).not.toMatch(/passwordHash|staff|verifiedBy/);
  });

  it("marks old stock figures as a guess", async () => {
    await prisma.bloodStock.updateMany({
      where: { bloodBankId: far.bank.id },
      data: { updatedAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const res = await api("GET", "/public/blood-banks/" + far.bank.id);
    expect(res.data.stockStale).toBe(true);
    expect(
      res.data.stock.find((s: { bloodGroup: string }) => s.bloodGroup === "B_POS"),
    ).toMatchObject({ units: 4, stale: true });
  });

  it("checks its inputs", async () => {
    expect((await api("GET", "/public/blood-banks?lat=28.6")).status).toBe(400);
    expect((await api("GET", "/public/blood-banks?bloodGroup=Q")).status).toBe(400);
    expect((await api("GET", "/public/blood-banks?limit=1000")).status).toBe(400);
  });

  it("keeps banks apart: nobody can read or change another bank's data", async () => {
    // Staff only ever act on their own bank: the bank comes from the login, not the request.
    const mine = await api("GET", "/blood-bank/profile", other.token);
    expect(mine.data.id).toBe(other.bank.id);
    const stock = await api("GET", "/blood-bank/stock", other.token);
    expect(stock.data.items.every((s: { units: number }) => s.units === 0)).toBe(true);
    const donations = await api("GET", "/blood-bank/donations", other.token);
    expect(donations.data.items).toEqual([]);
    expect(near.staff.id).not.toBe(other.staff.id);
  });
});

describe("staff logins of a blood bank", () => {
  it("lets staff add colleagues with a temporary password, and manage only their own bank's", async () => {
    const a = await createBank(created, { city: CITY });
    const b = await createBank(created, { city: CITY });

    const add = await api("POST", "/blood-bank/staff", a.token, { name: "Night Technician" });
    expect(add.status).toBe(201);
    created.userIds.push(add.data.user.id);
    expect(add.data.credentials.temporaryPassword).toMatch(
      /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/,
    );

    const login = await api("POST", "/auth/staff/login", undefined, {
      loginId: add.data.credentials.loginId,
      password: add.data.credentials.temporaryPassword,
    });
    expect(login.data.user).toMatchObject({
      role: "BLOOD_BANK_STAFF",
      mustChangePassword: true,
      bloodBankId: a.bank.id,
    });

    const list = await api("GET", "/blood-bank/staff", a.token);
    expect(list.data.items.map((u: { id: string }) => u.id)).toContain(add.data.user.id);
    expect(
      (await api("GET", "/blood-bank/staff", b.token)).data.items.map((u: { id: string }) => u.id),
    ).not.toContain(add.data.user.id);

    // Another bank's staff cannot reach them, and nobody can block themselves.
    expect((await api("POST", `/blood-bank/staff/${add.data.user.id}/block`, b.token)).status).toBe(
      404,
    );
    expect(
      (await api("POST", `/blood-bank/staff/${add.data.user.id}/reset-password`, b.token)).status,
    ).toBe(404);
    expect((await api("POST", `/blood-bank/staff/${a.staff.id}/block`, a.token)).code).toBe(
      "CANNOT_BLOCK_SELF",
    );

    const blocked = await api("POST", `/blood-bank/staff/${add.data.user.id}/block`, a.token);
    expect(blocked.data.status).toBe("BLOCKED");
    expect(
      (
        await api("POST", "/auth/staff/login", undefined, {
          loginId: add.data.credentials.loginId,
          password: add.data.credentials.temporaryPassword,
        })
      ).status,
    ).not.toBe(200);
  });
});
