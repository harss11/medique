import { describe, expect, it } from "vitest";
import { routeInventory, routeKey } from "./route-inventory.js";

/**
 * Endpoints that may be called without a login. Adding an endpoint here is a deliberate
 * decision: everything else must require authentication and a role.
 */
export const PUBLIC_ENDPOINTS = new Set([
  "GET /health",
  "POST /api/v1/auth/staff/login",
  "POST /api/v1/auth/otp/request",
  "POST /api/v1/auth/otp/verify",
  "POST /api/v1/auth/patient/signup",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/logout",
  "POST /api/v1/webhooks/razorpay",
  // The blood module: each is proved with a code sent to the phone, rate limited, or opened only
  // with the requester's secret key (an unguessable value that is stored hashed).
  "POST /api/v1/blood/otp",
  "POST /api/v1/blood/banks/register",
  "POST /api/v1/blood/requests",
  "POST /api/v1/blood/requests/recover",
  "GET /api/v1/blood/requests/:id",
  "POST /api/v1/blood/requests/:id/close",
]);

describe("route inventory", () => {
  const routes = routeInventory();

  it("finds the API's routes", () => {
    expect(routes.length).toBeGreaterThan(80);
    expect(routes.some((r) => routeKey(r) === "POST /api/v1/desk/appointments/:id/start")).toBe(
      true,
    );
    expect(routes.some((r) => routeKey(r) === "GET /api/v1/hospital/doctors/:id")).toBe(true);
  });

  it("has no duplicate method + path", () => {
    const keys = routes.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("requires a login on every endpoint except the deliberately public ones", () => {
    const open = routes.filter((r) => !r.auth).map(routeKey);
    const public_ = routes.filter((r) => r.path.startsWith("/api/v1/public/")).map(routeKey);
    expect(open.filter((k) => !PUBLIC_ENDPOINTS.has(k) && !public_.includes(k))).toEqual([]);
  });

  it("only exposes read endpoints under /public (nothing there changes data)", () => {
    const writes = routes.filter((r) => r.path.startsWith("/api/v1/public/") && r.method !== "GET");
    expect(writes.map(routeKey)).toEqual([]);
  });

  it("puts a role gate on every authenticated endpoint except the account ones", () => {
    const ACCOUNT = new Set(["GET /api/v1/auth/me", "POST /api/v1/auth/change-password"]);
    const ungated = routes.filter((r) => r.auth && r.roles === null && !ACCOUNT.has(routeKey(r)));
    expect(ungated.map(routeKey)).toEqual([]);
  });

  it("rate limits every unauthenticated login, OTP and refresh endpoint", () => {
    const limited = (k: string) => routes.find((r) => routeKey(r) === k)?.limiters ?? [];
    expect(limited("POST /api/v1/auth/staff/login")).toContain("login");
    expect(limited("POST /api/v1/auth/otp/request")).toContain("otpRequest");
    expect(limited("POST /api/v1/auth/otp/verify")).toContain("otpVerify");
    expect(limited("POST /api/v1/auth/refresh")).toContain("refresh");
  });

  it("limits how fast one patient can hold slots, reschedule and start payments", () => {
    for (const k of [
      "POST /api/v1/appointments/lock",
      "POST /api/v1/appointments/:id/reschedule",
      "POST /api/v1/appointments/:id/payment-order",
    ]) {
      expect(routes.find((r) => routeKey(r) === k)?.limiters).toContain("booking");
    }
  });

  it("keeps hospital, desk and admin areas to their own roles", () => {
    const rolesOf = (prefix: string) =>
      new Set(routes.filter((r) => r.path.startsWith(prefix)).flatMap((r) => r.roles ?? ["NONE"]));
    expect([...rolesOf("/api/v1/admin/")]).toEqual(["ADMIN"]);
    expect([...rolesOf("/api/v1/hospital/")]).toEqual(["HOSPITAL_ADMIN"]);
    expect([...rolesOf("/api/v1/appointments")]).toEqual(["PATIENT"]);
    expect(rolesOf("/api/v1/desk/")).toEqual(new Set(["RECEPTIONIST", "HOSPITAL_ADMIN", "DOCTOR"]));
    expect([...rolesOf("/api/v1/blood-bank/")]).toEqual(["BLOOD_BANK_STAFF"]);
    expect([...rolesOf("/api/v1/donor/")]).toEqual(["PATIENT"]);
  });

  it("rate limits everything in the blood module that anyone can call and that sends a message", () => {
    const limited = (k: string) => routes.find((r) => routeKey(r) === k)?.limiters ?? [];
    expect(limited("POST /api/v1/blood/otp")).toContain("bloodOtp");
    expect(limited("POST /api/v1/blood/banks/register")).toContain("bloodRegister");
    expect(limited("POST /api/v1/blood/requests")).toContain("bloodRequest");
    expect(limited("POST /api/v1/blood/requests/recover")).toContain("bloodRequest");
    expect(limited("GET /api/v1/blood-bank/donors/lookup")).toContain("bloodLookup");
  });

  it("has no coupon or voucher endpoints: donations are records, nothing is issued or redeemed", () => {
    expect(routes.filter((r) => /coupon|voucher|redeem/i.test(r.path)).map(routeKey)).toEqual([]);
  });
});
