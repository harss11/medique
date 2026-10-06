import { describe, expect, it } from "vitest";
import {
  commissionKept,
  eachDate,
  fillDaily,
  percentOf,
  resolveRange,
  roundMinutes,
} from "./analytics-rules.js";

describe("resolveRange", () => {
  it("defaults to the last 30 days ending today", () => {
    expect(resolveRange({}, "2026-10-06")).toEqual({
      from: "2026-09-07",
      to: "2026-10-06",
      days: 30,
    });
  });

  it("keeps a chosen period, inclusive of both ends", () => {
    expect(resolveRange({ from: "2026-10-01", to: "2026-10-07" }, "2026-10-20").days).toBe(7);
    expect(resolveRange({ from: "2026-10-06", to: "2026-10-06" }, "2026-10-20").days).toBe(1);
  });

  it("counts back from a chosen end date when no start is given", () => {
    expect(resolveRange({ to: "2026-03-31" }, "2026-10-06").from).toBe("2026-03-02");
  });

  it("takes a length in days, counted back from today or from a chosen end date", () => {
    expect(resolveRange({ days: 7 }, "2026-10-06")).toEqual({
      from: "2026-09-30",
      to: "2026-10-06",
      days: 7,
    });
    expect(resolveRange({ days: 1 }, "2026-10-06").from).toBe("2026-10-06");
    expect(resolveRange({ days: 7, to: "2026-03-10" }, "2026-10-06").from).toBe("2026-03-04");
    expect(resolveRange({ days: 7, from: "2026-10-01", to: "2026-10-03" }, "2026-10-06").days).toBe(
      3,
    ); // from wins
  });

  it("rejects a reversed range and one longer than a year", () => {
    expect(() => resolveRange({ from: "2026-10-07", to: "2026-10-01" }, "2026-10-20")).toThrow(
      /must not be after/,
    );
    expect(() => resolveRange({ from: "2024-01-01", to: "2026-10-01" }, "2026-10-20")).toThrow(
      /at most 366/,
    );
    expect(resolveRange({ from: "2025-10-06", to: "2026-10-06" }, "2026-10-20").days).toBe(366);
  });
});

describe("daily series", () => {
  it("lists every date including month and leap-day boundaries", () => {
    expect(eachDate("2028-02-27", "2028-03-01")).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("fills missing days with zeroes and keeps real values", () => {
    const rows = [{ date: "2026-10-02", n: 5 }];
    expect(
      fillDaily(rows, { from: "2026-10-01", to: "2026-10-03" }, (date) => ({ date, n: 0 })),
    ).toEqual([
      { date: "2026-10-01", n: 0 },
      { date: "2026-10-02", n: 5 },
      { date: "2026-10-03", n: 0 },
    ]);
  });
});

describe("rates and money", () => {
  it("percentOf is null when there is nothing to divide by", () => {
    expect(percentOf(1, 0)).toBeNull();
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(0, 10)).toBe(0);
    expect(percentOf(10, 10)).toBe(100);
  });

  it("keeps commission only on the part of a payment that was not refunded", () => {
    expect(commissionKept(5000, 50000, 0)).toBe(5000);
    expect(commissionKept(5000, 50000, 25000)).toBe(2500);
    expect(commissionKept(5000, 50000, 50000)).toBe(0);
    expect(commissionKept(5000, 50000, 90000)).toBe(0); // never negative
    expect(commissionKept(0, 50000, 0)).toBe(0);
    expect(commissionKept(5000, 0, 0)).toBe(0);
  });

  it("rounds minutes to one decimal and passes null through", () => {
    expect(roundMinutes(12.349)).toBe(12.3);
    expect(roundMinutes(null)).toBeNull();
    expect(roundMinutes(undefined)).toBeNull();
  });
});
