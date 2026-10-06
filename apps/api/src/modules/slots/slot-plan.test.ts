import { describe, expect, it } from "vitest";
import { generateTempPassword, slugify } from "../../utils/credentials.js";
import { passwordSchema } from "../../utils/password.js";
import {
  addDays,
  dayOfWeek,
  isValidLocalDate,
  minutesToTime,
  timeToMinutes,
  todayInZone,
  zonedTimeToUtc,
} from "../../utils/time.js";
import { planSlots, sessionsOverlap } from "./slot-plan.js";

describe("time helpers", () => {
  it("converts hospital wall-clock time to UTC", () => {
    // India is UTC+05:30 with no DST.
    expect(zonedTimeToUtc("2026-10-05", 9 * 60, "Asia/Kolkata").toISOString()).toBe(
      "2026-10-05T03:30:00.000Z",
    );
    // New York switches from EDT (UTC-4) to EST (UTC-5) on 2026-11-01.
    expect(zonedTimeToUtc("2026-10-30", 9 * 60, "America/New_York").toISOString()).toBe(
      "2026-10-30T13:00:00.000Z",
    );
    expect(zonedTimeToUtc("2026-11-02", 9 * 60, "America/New_York").toISOString()).toBe(
      "2026-11-02T14:00:00.000Z",
    );
  });

  it("finds the local date in a timezone", () => {
    // 20:00 UTC on 4 Oct is already 5 Oct in India.
    expect(todayInZone("Asia/Kolkata", new Date("2026-10-04T20:00:00Z"))).toBe("2026-10-05");
  });

  it("does calendar arithmetic", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayOfWeek("2026-10-05")).toBe(1); // Monday
    expect(isValidLocalDate("2026-02-30")).toBe(false);
    expect(isValidLocalDate("2026-02-28")).toBe(true);
  });

  it("parses and formats times", () => {
    expect(timeToMinutes("09:30")).toBe(570);
    expect(timeToMinutes("24:00")).toBe(1440);
    expect(timeToMinutes("24:30")).toBeNull();
    expect(timeToMinutes("9:30")).toBeNull();
    expect(minutesToTime(570)).toBe("09:30");
  });
});

describe("planSlots", () => {
  const monday = {
    dayOfWeek: 1,
    startMinute: 540,
    endMinute: 600,
    slotMinutes: 15,
    capacityPerSlot: 2,
  };

  it("creates slots for matching weekdays only", () => {
    // 2026-10-05 is a Monday; a 7-day window contains one Monday.
    const slots = planSlots({
      schedules: [monday],
      leaves: [],
      timezone: "Asia/Kolkata",
      fromDate: "2026-10-05",
      days: 7,
    });
    expect(slots).toHaveLength(4); // 09:00, 09:15, 09:30, 09:45
    expect(slots[0]!.date).toBe("2026-10-05");
    expect(slots[0]!.startAt.toISOString()).toBe("2026-10-05T03:30:00.000Z");
    expect(slots[0]!.endAt.toISOString()).toBe("2026-10-05T03:45:00.000Z");
    expect(slots.every((s) => s.capacity === 2)).toBe(true);
  });

  it("skips leave dates (inclusive range)", () => {
    const slots = planSlots({
      schedules: [monday],
      leaves: [{ startDate: "2026-10-05", endDate: "2026-10-05" }],
      timezone: "Asia/Kolkata",
      fromDate: "2026-10-05",
      days: 14,
    });
    expect(new Set(slots.map((s) => s.date))).toEqual(new Set(["2026-10-12"]));
  });

  it("drops a trailing partial slot", () => {
    const slots = planSlots({
      schedules: [{ ...monday, endMinute: 590 }], // 50 min of a 15-min grid
      leaves: [],
      timezone: "Asia/Kolkata",
      fromDate: "2026-10-05",
      days: 1,
    });
    expect(slots).toHaveLength(3);
  });

  it("supports several sessions a day, sorted by time", () => {
    const evening = { ...monday, startMinute: 17 * 60, endMinute: 17 * 60 + 30 };
    const slots = planSlots({
      schedules: [evening, monday],
      leaves: [],
      timezone: "Asia/Kolkata",
      fromDate: "2026-10-05",
      days: 1,
    });
    expect(slots).toHaveLength(6);
    const times = slots.map((s) => s.startAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("detects overlapping sessions", () => {
    expect(sessionsOverlap(monday, { ...monday, startMinute: 590, endMinute: 700 })).toBe(true);
    expect(sessionsOverlap(monday, { ...monday, startMinute: 600, endMinute: 700 })).toBe(false);
    expect(sessionsOverlap(monday, { ...monday, dayOfWeek: 2 })).toBe(false);
  });
});

describe("credentials", () => {
  it("generates temporary passwords that satisfy the policy", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword();
      expect(p).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      expect(passwordSchema.safeParse(p).success).toBe(true);
    }
  });

  it("slugifies names", () => {
    expect(slugify("Sunrise Multispeciality Hospital")).toBe("sunrise-multispeciality-hospital");
    expect(slugify("  Dr. Ram's  Clinic & Nursing Home ")).toBe("dr-ram-s-clinic-nursing-home");
    expect(slugify("!!!")).toBe("hospital");
  });
});
