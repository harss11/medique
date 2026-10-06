import { describe, expect, it } from "vitest";
import { distanceKm } from "../../utils/geo.js";
import {
  BLOOD_GROUPS,
  bloodGroupLabel,
  boundingBox,
  canBeAlerted,
  cityKey,
  donationEligibility,
  firstName,
  gapDaysFor,
  nextEligibleAt,
  normalizeLicense,
  requestExpiry,
  roundCoord,
  stockIsStale,
} from "./blood-rules.js";

const rules = { gapDaysMale: 90, gapDaysOther: 120, minAge: 18, maxAge: 65 };
const now = new Date("2026-10-06T10:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const born = (years: number) => new Date(Date.UTC(now.getUTCFullYear() - years, 0, 1));

describe("blood groups", () => {
  it("lists all eight and prints them the usual way", () => {
    expect(BLOOD_GROUPS).toHaveLength(8);
    expect(BLOOD_GROUPS.map(bloodGroupLabel)).toEqual([
      "A+",
      "A-",
      "B+",
      "B-",
      "AB+",
      "AB-",
      "O+",
      "O-",
    ]);
  });
});

describe("the waiting period between donations", () => {
  it("is about 3 months for men and 4 months for women and anyone else", () => {
    expect(gapDaysFor("MALE", rules)).toBe(90);
    expect(gapDaysFor("FEMALE", rules)).toBe(120);
    expect(gapDaysFor("OTHER", rules)).toBe(120);
    expect(gapDaysFor("UNDISCLOSED", rules)).toBe(120);
  });

  it("ends exactly that many days after the last donation, and never for a first-timer", () => {
    expect(nextEligibleAt(null, "MALE", rules)).toBeNull();
    expect(nextEligibleAt(daysAgo(0), "MALE", rules)?.toISOString()).toBe(
      "2027-01-04T10:00:00.000Z",
    );
  });

  it("lets a man donate on day 90 but not 89, and a woman on day 120 but not 119", () => {
    const man = { dateOfBirth: born(30), gender: "MALE" as const };
    expect(donationEligibility({ ...man, lastDonationAt: daysAgo(89) }, now, rules).eligible).toBe(
      false,
    );
    expect(donationEligibility({ ...man, lastDonationAt: daysAgo(90) }, now, rules).eligible).toBe(
      true,
    );
    const woman = { dateOfBirth: born(30), gender: "FEMALE" as const };
    expect(
      donationEligibility({ ...woman, lastDonationAt: daysAgo(119) }, now, rules).eligible,
    ).toBe(false);
    expect(
      donationEligibility({ ...woman, lastDonationAt: daysAgo(120) }, now, rules).eligible,
    ).toBe(true);
  });

  it("says when the wait ends, and says nothing once it is over", () => {
    const base = { dateOfBirth: born(30), gender: "MALE" as const };
    const waiting = donationEligibility({ ...base, lastDonationAt: daysAgo(10) }, now, rules);
    expect(waiting.reasons).toEqual(["WAITING_PERIOD"]);
    expect(waiting.nextEligibleAt?.toISOString()).toBe("2026-12-25T10:00:00.000Z");
    const free = donationEligibility({ ...base, lastDonationAt: daysAgo(200) }, now, rules);
    expect(free).toEqual({ eligible: true, reasons: [], nextEligibleAt: null });
  });
});

describe("age limits", () => {
  const base = { gender: "MALE" as const, lastDonationAt: null };
  it("accepts 18 to 65 and nothing outside", () => {
    expect(
      donationEligibility({ ...base, dateOfBirth: new Date("2008-10-06T00:00:00Z") }, now, rules)
        .eligible,
    ).toBe(true);
    expect(
      donationEligibility({ ...base, dateOfBirth: new Date("2008-10-07T00:00:00Z") }, now, rules)
        .reasons,
    ).toEqual(["TOO_YOUNG"]);
    expect(donationEligibility({ ...base, dateOfBirth: born(65) }, now, rules).eligible).toBe(true);
    expect(donationEligibility({ ...base, dateOfBirth: born(66) }, now, rules).reasons).toEqual([
      "TOO_OLD",
    ]);
  });
});

describe("who may be alerted", () => {
  const donor = {
    dateOfBirth: born(30),
    gender: "MALE" as const,
    lastDonationAt: null,
    isAvailable: true,
  };
  it("needs both to be eligible and to have chosen to be available", () => {
    expect(canBeAlerted(donor, now, rules)).toBe(true);
    expect(canBeAlerted({ ...donor, isAvailable: false }, now, rules)).toBe(false);
    expect(canBeAlerted({ ...donor, lastDonationAt: daysAgo(5) }, now, rules)).toBe(false);
    expect(canBeAlerted({ ...donor, dateOfBirth: born(70) }, now, rules)).toBe(false);
  });
});

describe("locations", () => {
  it("rounds coordinates to about a kilometre", () => {
    expect(roundCoord(28.567712)).toBe(28.57);
    expect(roundCoord(77.243391)).toBe(77.24);
    expect(roundCoord(-33.8688)).toBe(-33.87);
  });

  it("a bounding box contains the points inside the radius", () => {
    const here = { lat: 28.6139, lng: 77.209 };
    const box = boundingBox(here.lat, here.lng, 25);
    const north = { lat: here.lat + 25 / 110.574, lng: here.lng };
    const east = {
      lat: here.lat,
      lng: here.lng + 25 / (111.32 * Math.cos((here.lat * Math.PI) / 180)),
    };
    for (const p of [north, east]) {
      expect(p.lat).toBeLessThanOrEqual(box.maxLat + 1e-9);
      expect(p.lng).toBeLessThanOrEqual(box.maxLng + 1e-9);
      expect(distanceKm(here, p)).toBeLessThan(25.5);
    }
    expect(box.minLat).toBeLessThan(here.lat);
    expect(box.maxLng).toBeGreaterThan(here.lng);
  });

  it("stays finite near the poles", () => {
    expect(Number.isFinite(boundingBox(89.99, 10, 25).maxLng)).toBe(true);
  });
});

describe("text helpers", () => {
  it("shows requesters only a donor's first name", () => {
    expect(firstName("  Sunita  Devi Sharma ")).toBe("Sunita");
    expect(firstName("Madonna")).toBe("Madonna");
    expect(firstName("")).toBe("");
  });

  it("compares licence numbers and cities without caring about case or spacing", () => {
    expect(normalizeLicense("  mh/bb  1234 ")).toBe("MH/BB 1234");
    expect(cityKey("  New   Delhi ")).toBe("new delhi");
  });
});

describe("expiry and freshness", () => {
  it("closes a request after the set number of hours", () => {
    expect(requestExpiry(now, 24).toISOString()).toBe("2026-10-07T10:00:00.000Z");
  });

  it("treats stock older than the limit, or never reported, as a guess", () => {
    expect(stockIsStale(null, now, 24)).toBe(true);
    expect(stockIsStale(new Date("2026-10-06T09:00:00Z"), now, 24)).toBe(false);
    expect(stockIsStale(new Date("2026-10-05T09:00:00Z"), now, 24)).toBe(true);
  });
});
