import { describe, expect, it } from "vitest";
import {
  commissionAmount,
  formatCheckInCode,
  generateCheckInCode,
  holdExpiry,
  isBookable,
  isChangeable,
  normalizeCheckInCode,
  pickSeat,
} from "./booking-rules.js";

const NOW = new Date("2026-10-05T10:00:00Z");
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("pickSeat", () => {
  it("takes the lowest free seat", () => {
    expect(pickSeat([], 3)).toBe(1);
    expect(pickSeat([1], 3)).toBe(2);
    expect(pickSeat([1, 3], 3)).toBe(2);
    expect(pickSeat([2, 3], 3)).toBe(1);
  });

  it("returns null when full", () => {
    expect(pickSeat([1], 1)).toBeNull();
    expect(pickSeat([1, 2, 3], 3)).toBeNull();
  });
});

describe("time windows", () => {
  it("online booking closes 15 minutes before the slot", () => {
    expect(isBookable(inMinutes(16), NOW, 15)).toBe(true);
    expect(isBookable(inMinutes(15), NOW, 15)).toBe(false);
    expect(isBookable(inMinutes(-5), NOW, 15)).toBe(false);
  });

  it("cancel and reschedule close 60 minutes before the slot", () => {
    expect(isChangeable(inMinutes(61), NOW, 60)).toBe(true);
    expect(isChangeable(inMinutes(60), NOW, 60)).toBe(false);
    expect(isChangeable(inMinutes(30), NOW, 60)).toBe(false);
  });

  it("a hold lasts the configured minutes", () => {
    expect(holdExpiry(NOW, 5).getTime() - NOW.getTime()).toBe(5 * 60_000);
  });
});

describe("commission", () => {
  it("rounds to the nearest paisa", () => {
    expect(commissionAmount(50_000, 10)).toBe(5_000);
    expect(commissionAmount(50_000, 12.5)).toBe(6_250);
    expect(commissionAmount(33_333, 10)).toBe(3_333);
    expect(commissionAmount(50_000, 0)).toBe(0);
  });
});

describe("check-in codes", () => {
  it("are 10 unambiguous characters", () => {
    for (let i = 0; i < 200; i++) expect(generateCheckInCode()).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);
  });

  it("do not repeat", () => {
    const codes = new Set(Array.from({ length: 5000 }, generateCheckInCode));
    expect(codes.size).toBe(5000);
  });

  it("format for display and parse what people type", () => {
    expect(formatCheckInCode("K7M29QXF3R")).toBe("K7M2-9QXF-3R");
    expect(normalizeCheckInCode(" k7m2-9qxf 3r ")).toBe("K7M29QXF3R");
  });
});
