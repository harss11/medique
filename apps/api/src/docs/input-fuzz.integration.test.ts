/**
 * Input validation review, as a test: every endpoint is sent malformed paths, bodies and
 * query strings, signed in as the role that is allowed to call it. None may answer with a
 * server error, and none may reveal internals (stack traces, SQL, file paths).
 * Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { signAccessToken } from "../modules/auth/tokens.js";
import {
  cleanup,
  createPatients,
  createStaffUser,
  createWorld,
  type World,
} from "../../test/fixtures.js";
import { routeInventory, routeKey, type RouteInfo } from "./route-inventory.js";

let server: Server;
let base: string;
let world: World;
let bloodBankId: string;
const tokens: Record<string, string> = {};

/** Routes that do real work on any call, or that are not JSON endpoints. */
const SKIP = new Set(["POST /api/v1/admin/jobs/generate-slots"]);

const UUID = "00000000-0000-7000-8000-000000000000";
const PATH_VALUES = [
  "not-a-uuid",
  UUID,
  "'; DROP TABLE users; --",
  "%00",
  "a".repeat(3000),
  "..%2f..%2fetc%2fpasswd",
];
const BODIES: Array<{ name: string; raw: string }> = [
  { name: "empty object", raw: "{}" },
  { name: "array", raw: "[]" },
  { name: "null", raw: "null" },
  { name: "broken json", raw: "{bad" },
  { name: "prototype pollution", raw: '{"__proto__":{"role":"ADMIN"},"constructor":{"x":1}}' },
  {
    name: "wrong types",
    raw: JSON.stringify({
      name: 123,
      id: { $ne: null },
      date: [],
      amount: -1,
      phone: false,
      slotId: 5,
      fields: "x",
      template: [],
      code: {},
      email: "x".repeat(500),
    }),
  },
  { name: "huge", raw: JSON.stringify({ a: "x".repeat(200_000) }) },
  {
    name: "deeply nested",
    raw: "[".repeat(2000) + "]".repeat(2000),
  },
];
const QUERY =
  "?page=-1&limit=100000&search=%00%27%22&date=notadate&doctorId=x&status[]=a&status[]=b&from=zzz&lat=1e999&city[a]=b";

async function call(method: string, path: string, token: string | undefined, raw?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(raw !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: raw,
  });
  return {
    status: res.status,
    text: await res.text(),
    type: res.headers.get("content-type") ?? "",
  };
}

const LEAKS = [
  /node_modules/i,
  /\bat .*\(.*:\d+:\d+\)/,
  /prisma/i,
  /\bSELECT\b.*\bFROM\b/i,
  /pg_/i,
  /ECONN/i,
];
const problems: string[] = [];

function check(label: string, r: { status: number; text: string; type: string }) {
  // Deliberate: without a webhook secret configured the endpoint answers 503, never processes anything.
  const notConfigured = r.status === 503 && r.text.includes("WEBHOOK_NOT_CONFIGURED");
  if (r.status >= 500 && !notConfigured)
    problems.push(label + " -> " + r.status + " " + r.text.slice(0, 160));
  for (const re of LEAKS) {
    if (re.test(r.text)) problems.push(label + " leaks " + re + ": " + r.text.slice(0, 160));
  }
  if (r.status >= 400 && r.type.includes("json")) {
    try {
      const body = JSON.parse(r.text);
      if (body.success !== false || !body.error?.code)
        problems.push(label + " has no error envelope");
    } catch {
      problems.push(label + " returned invalid JSON");
    }
  }
}

function fill(path: string, value: string) {
  return path.replace(/:[A-Za-z]+/g, encodeURIComponent(value));
}
const tokenFor = (r: RouteInfo) =>
  r.auth ? tokens[(r.roles?.[0] ?? "PATIENT") as string] : undefined;

beforeAll(async () => {
  world = await createWorld();
  const admin = await prisma.user.create({
    data: { role: "ADMIN", name: "Fuzz Admin", loginId: "fuzz-admin-" + Date.now() },
  });
  world.userIds.push(admin.id);
  tokens.ADMIN = signAccessToken({
    id: admin.id,
    role: "ADMIN",
    hospitalId: null,
    tokenVersion: 0,
  }).token;
  tokens.HOSPITAL_ADMIN = (await createStaffUser(world, "HOSPITAL_ADMIN")).token;
  tokens.RECEPTIONIST = (await createStaffUser(world, "RECEPTIONIST")).token;
  tokens.DOCTOR = (await createStaffUser(world, "DOCTOR")).token;
  const bank = await prisma.bloodBank.create({
    data: {
      name: "Fuzz Blood Bank",
      licenseNumber: "FUZZ-" + Date.now(),
      status: "ACTIVE",
      phone: "+919811100000",
      addressLine1: "1 Test Road",
      city: "Testville",
    },
  });
  bloodBankId = bank.id;
  const bankStaff = await prisma.user.create({
    data: {
      role: "BLOOD_BANK_STAFF",
      name: "Fuzz Bank Staff",
      loginId: "fuzz-bank-" + Date.now(),
      bloodBankId,
    },
  });
  world.userIds.push(bankStaff.id);
  tokens.BLOOD_BANK_STAFF = signAccessToken({
    id: bankStaff.id,
    role: "BLOOD_BANK_STAFF",
    hospitalId: null,
    tokenVersion: 0,
  }).token;
  const [patient] = await createPatients(world, 1);
  tokens.PATIENT = signAccessToken({
    id: patient!.userId,
    role: "PATIENT",
    hospitalId: null,
    tokenVersion: 0,
  }).token;
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  // The blood bank staff user belongs to world.userIds, so remove the bank only after cleanup deletes them.
  if (world) await cleanup(world);
  if (bloodBankId) {
    await prisma.auditLog.deleteMany({ where: { entityId: bloodBankId } });
    await prisma.bloodBank.deleteMany({ where: { id: bloodBankId } });
  }
  await prisma.$disconnect();
});

describe("malformed input never causes a server error", () => {
  beforeEach(() => {
    problems.length = 0;
  });
  const routes = routeInventory().filter((r) => !SKIP.has(routeKey(r)));

  it("covers the whole API", () => {
    expect(routes.length).toBeGreaterThan(80);
  });

  it("odd path parameters on every endpoint", async () => {
    for (const r of routes.filter((x) => x.path.includes(":"))) {
      for (const value of PATH_VALUES) {
        const raw = r.method === "GET" ? undefined : "{}";
        check(
          routeKey(r) + " [" + value.slice(0, 20) + "]",
          await call(r.method, fill(r.path, value), tokenFor(r), raw),
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("malformed bodies on every endpoint that takes one", async () => {
    for (const r of routes.filter((x) => x.method !== "GET")) {
      for (const body of BODIES) {
        check(
          routeKey(r) + " (" + body.name + ")",
          await call(r.method, fill(r.path, UUID), tokenFor(r), body.raw),
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("malformed query strings on every endpoint", async () => {
    for (const r of routes) {
      check(
        routeKey(r) + " (query)",
        await call(
          r.method,
          fill(r.path, UUID) + QUERY,
          tokenFor(r),
          r.method === "GET" ? undefined : "{}",
        ),
      );
    }
    expect(problems).toEqual([]);
  });

  it("refuses every authenticated endpoint without a token, and with a forged one", async () => {
    for (const r of routes.filter((x) => x.auth)) {
      for (const token of [undefined, "garbage", "a.b.c"]) {
        const res = await call(
          r.method,
          fill(r.path, UUID),
          token,
          r.method === "GET" ? undefined : "{}",
        );
        if (res.status !== 401)
          problems.push(routeKey(r) + " answered " + res.status + " without a valid token");
      }
    }
    expect(problems).toEqual([]);
  });

  it("refuses every role that an endpoint does not allow (403 or 404, never data)", async () => {
    const roles = [
      "ADMIN",
      "HOSPITAL_ADMIN",
      "RECEPTIONIST",
      "DOCTOR",
      "PATIENT",
      "BLOOD_BANK_STAFF",
    ];
    for (const r of routes.filter((x) => x.auth && x.roles)) {
      for (const role of roles.filter((x) => !r.roles!.includes(x as never))) {
        const res = await call(
          r.method,
          fill(r.path, UUID),
          tokens[role],
          r.method === "GET" ? undefined : "{}",
        );
        if (res.status !== 403)
          problems.push(routeKey(r) + " as " + role + " answered " + res.status);
      }
    }
    expect(problems).toEqual([]);
  });
});
