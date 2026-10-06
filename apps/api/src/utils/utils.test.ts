import { describe, expect, it } from "vitest";
import { redact } from "./audit.js";
import { randomNumericCode } from "./crypto.js";
import { paginate, paginationQuery, toSkipTake } from "./pagination.js";
import { passwordSchema } from "./password.js";
import { maskPhone, normalizeMobile } from "./phone.js";

describe("normalizeMobile", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["+91-98765-43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["+14155552671", "+14155552671"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeMobile(input)).toBe(expected);
  });

  it.each(["12345", "abcdefghij", "+91 12345", "011 4000 0000"])("rejects %s", (input) => {
    expect(normalizeMobile(input)).toBeNull();
  });

  it("masks numbers", () => {
    expect(maskPhone("+919876543210")).toBe("+91******3210");
  });
});

describe("pagination", () => {
  it("applies defaults and bounds", () => {
    expect(paginationQuery.parse({})).toEqual({ page: 1, limit: 20 });
    expect(paginationQuery.parse({ page: "3", limit: "10" })).toEqual({ page: 3, limit: 10 });
    expect(paginationQuery.safeParse({ limit: "1000" }).success).toBe(false);
    expect(paginationQuery.safeParse({ page: "0" }).success).toBe(false);
  });

  it("computes skip/take and totals", () => {
    expect(toSkipTake({ page: 3, limit: 10 })).toEqual({ skip: 20, take: 10 });
    expect(paginate([1, 2], 21, { page: 1, limit: 10 }).pagination.totalPages).toBe(3);
    expect(paginate([], 0, { page: 1, limit: 10 }).pagination.totalPages).toBe(1);
  });
});

describe("redact", () => {
  it("removes secrets at any depth", () => {
    const out = redact({
      name: "x",
      passwordHash: "hash",
      nested: { refreshToken: "t", list: [{ code: "123456", ok: 1 }] },
      at: new Date("2026-01-01T00:00:00Z"),
    });
    expect(out).toEqual({
      name: "x",
      passwordHash: "[redacted]",
      nested: { refreshToken: "[redacted]", list: [{ code: "[redacted]", ok: 1 }] },
      at: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("passwordSchema", () => {
  it("enforces the policy", () => {
    expect(passwordSchema.safeParse("Temp@12345").success).toBe(true);
    expect(passwordSchema.safeParse("short1").success).toBe(false);
    expect(passwordSchema.safeParse("onlyletterslong").success).toBe(false);
    expect(passwordSchema.safeParse("1234567890").success).toBe(false);
    expect(passwordSchema.safeParse("a1" + "x".repeat(80)).success).toBe(false);
  });
});

describe("randomNumericCode", () => {
  it("returns zero-padded digits", () => {
    for (let i = 0; i < 50; i++) expect(randomNumericCode(6)).toMatch(/^\d{6}$/);
  });
});
