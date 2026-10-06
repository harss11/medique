import { describe, expect, it } from "vitest";
import { distanceKm } from "../../utils/geo.js";
import {
  ageInYears,
  dateOfBirthFromAge,
  estimateWait,
  queueState,
  type QueueCounts,
} from "./queue-rules.js";

const counts = (c: Partial<QueueCounts>): QueueCounts => ({
  booked: 0,
  waiting: 0,
  inProgress: 0,
  completed: 0,
  noShow: 0,
  ...c,
});

describe("queueState", () => {
  it("describes each stage of a clinic day", () => {
    expect(queueState(counts({}))).toBe("NO_BOOKINGS");
    expect(queueState(counts({ booked: 5 }))).toBe("NOT_STARTED");
    expect(queueState(counts({ booked: 3, waiting: 2 }))).toBe("NOT_STARTED");
    expect(queueState(counts({ inProgress: 1, waiting: 4 }))).toBe("SERVING");
    expect(queueState(counts({ completed: 3, waiting: 2 }))).toBe("BETWEEN");
    expect(queueState(counts({ completed: 3, booked: 1 }))).toBe("BETWEEN");
    expect(queueState(counts({ completed: 5 }))).toBe("DONE");
    expect(queueState(counts({ completed: 4, noShow: 1 }))).toBe("DONE");
  });

  it("treats a day where everyone was a no-show as done", () => {
    expect(queueState(counts({ noShow: 3 }))).toBe("DONE");
  });

  it("someone with the doctor always means serving", () => {
    expect(queueState(counts({ inProgress: 1 }))).toBe("SERVING");
    expect(queueState(counts({ inProgress: 1, completed: 9, noShow: 2 }))).toBe("SERVING");
  });
});

describe("estimateWait", () => {
  it("is tokens ahead x average consultation minutes", () => {
    expect(estimateWait(4, 10)).toEqual({ ahead: 4, minutes: 40 });
    expect(estimateWait(0, 10)).toEqual({ ahead: 0, minutes: 0 });
    expect(estimateWait(3, 12.4)).toEqual({ ahead: 3, minutes: 36 });
  });

  it("never goes negative or uses a zero average", () => {
    expect(estimateWait(-2, 10)).toEqual({ ahead: 0, minutes: 0 });
    expect(estimateWait(2, 0)).toEqual({ ahead: 2, minutes: 2 });
  });
});

describe("age", () => {
  const now = new Date("2026-10-05T10:00:00Z");

  it("counts whole years and respects the birthday", () => {
    expect(ageInYears(new Date("1990-10-05T00:00:00Z"), now)).toBe(36);
    expect(ageInYears(new Date("1990-10-06T00:00:00Z"), now)).toBe(35);
    expect(ageInYears(new Date("2026-01-01T00:00:00Z"), now)).toBe(0);
    expect(ageInYears(new Date("2030-01-01T00:00:00Z"), now)).toBe(0); // a future date never gives a negative age
    expect(ageInYears(null, now)).toBeNull();
  });

  it("turns a typed age into a birth date that reads back as the same age", () => {
    for (const age of [0, 1, 7, 34, 89]) {
      expect(ageInYears(dateOfBirthFromAge(age, now), now)).toBe(age);
    }
    expect(dateOfBirthFromAge(34, now).toISOString()).toBe("1992-01-01T00:00:00.000Z");
  });
});

describe("distanceKm", () => {
  const delhi = { lat: 28.6139, lng: 77.209 };
  const gurugram = { lat: 28.4595, lng: 77.0266 };

  it("matches real-world distances closely", () => {
    expect(distanceKm(delhi, delhi)).toBe(0);
    expect(distanceKm(delhi, gurugram)).toBeGreaterThan(24);
    expect(distanceKm(delhi, gurugram)).toBeLessThan(28);
    expect(distanceKm(delhi, { lat: 19.076, lng: 72.8777 })).toBeGreaterThan(1100); // Delhi to Mumbai
    expect(distanceKm(delhi, { lat: 19.076, lng: 72.8777 })).toBeLessThan(1200);
  });

  it("is symmetric", () => {
    expect(distanceKm(delhi, gurugram)).toBeCloseTo(distanceKm(gurugram, delhi), 9);
  });
});
