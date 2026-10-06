import { describe, expect, it } from "vitest";
import { nearBy, rankBanks, rankDonors, type DonorCandidate } from "./matching.js";

const rules = { gapDaysMale: 90, gapDaysOther: 120, minAge: 18, maxAge: 65 };
const now = new Date("2026-10-06T10:00:00Z");
const limits = { maxDonors: 100, maxAlertsPerDay: 2 };
const delhi = { city: "New Delhi", latitude: 28.6139, longitude: 77.209, radiusKm: 25 };
const request = { ...delhi, bloodGroup: "O_POS" as const, requesterPhone: "+919000000000" };

let n = 0;
const donor = (over: Partial<DonorCandidate> = {}): DonorCandidate => ({
  id: "d" + String(++n).padStart(3, "0"),
  userId: "u" + n,
  phone: "+9198000000" + String(n).padStart(2, "0"),
  bloodGroup: "O_POS",
  gender: "MALE",
  dateOfBirth: new Date("1990-01-01T00:00:00Z"),
  lastDonationAt: null,
  isAvailable: true,
  city: "New Delhi",
  latitude: 28.62,
  longitude: 77.21,
  alertsToday: 0,
  ...over,
});

describe("what counts as near", () => {
  it("uses the distance when both sides have coordinates", () => {
    expect(nearBy(delhi, { city: "X", latitude: 28.57, longitude: 77.24 }).near).toBe(true);
    expect(nearBy(delhi, { city: "New Delhi", latitude: 19.07, longitude: 72.87 }).near).toBe(
      false,
    );
    expect(
      nearBy(delhi, { city: "X", latitude: 28.57, longitude: 77.24 }).distanceKm,
    ).toBeGreaterThan(4);
  });

  it("falls back to the same city when a coordinate is missing on either side", () => {
    const sameCity = { city: "  new  delhi ", latitude: null, longitude: null };
    expect(nearBy(delhi, sameCity)).toEqual({ near: true, distanceKm: null });
    expect(nearBy(delhi, { city: "Mumbai", latitude: null, longitude: null }).near).toBe(false);
    const noCoords = { ...delhi, latitude: null, longitude: null };
    expect(nearBy(noCoords, { city: "New Delhi", latitude: 28.6, longitude: 77.2 }).near).toBe(
      true,
    );
  });

  it("respects the radius the requester chose", () => {
    const gurugram = { city: "Gurugram", latitude: 28.4595, longitude: 77.0266 };
    expect(nearBy({ ...delhi, radiusKm: 50 }, gurugram).near).toBe(true);
    expect(nearBy({ ...delhi, radiusKm: 10 }, gurugram).near).toBe(false);
  });
});

describe("who is alerted about a request", () => {
  it("only donors of exactly that blood group", () => {
    const pool = [donor(), donor({ bloodGroup: "A_POS" }), donor({ bloodGroup: "O_NEG" })];
    expect(rankDonors(pool, request, now, rules, limits)).toHaveLength(1);
  });

  it("not donors who paused, are still waiting after a donation, or are too young or old", () => {
    const pool = [
      donor(),
      donor({ isAvailable: false }),
      donor({ lastDonationAt: new Date("2026-09-20T00:00:00Z") }),
      donor({ dateOfBirth: new Date("2012-01-01T00:00:00Z") }),
      donor({ dateOfBirth: new Date("1950-01-01T00:00:00Z") }),
    ];
    expect(rankDonors(pool, request, now, rules, limits)).toHaveLength(1);
  });

  it("not the person who is asking, and not someone already alerted twice today", () => {
    const pool = [
      donor({ phone: request.requesterPhone }),
      donor({ alertsToday: 2 }),
      donor({ alertsToday: 1 }),
    ];
    expect(rankDonors(pool, request, now, rules, limits)).toHaveLength(1);
  });

  it("not donors who are far away, but yes those in the same city with no coordinates", () => {
    const pool = [
      donor({ latitude: 19.07, longitude: 72.87, city: "Mumbai" }),
      donor({ latitude: null, longitude: null, city: "New Delhi" }),
      donor({ latitude: null, longitude: null, city: "Pune" }),
    ];
    const hits = rankDonors(pool, request, now, rules, limits);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distanceKm).toBeNull();
  });

  it("nearest first, those matched by city last, and never more than the cap", () => {
    const far = donor({ latitude: 28.75, longitude: 77.3 });
    const close = donor({ latitude: 28.615, longitude: 77.21 });
    const byCity = donor({ latitude: null, longitude: null });
    const ranked = rankDonors([byCity, far, close], request, now, rules, limits);
    expect(ranked.map((r) => r.candidate.id)).toEqual([close.id, far.id, byCity.id]);
    expect(
      rankDonors([byCity, far, close], request, now, rules, { ...limits, maxDonors: 2 }),
    ).toHaveLength(2);
  });

  it("is stable: equal distances come out in the same order every time", () => {
    const a = donor({ latitude: null, longitude: null });
    const b = donor({ latitude: null, longitude: null });
    expect(rankDonors([b, a], request, now, rules, limits).map((r) => r.candidate.id)).toEqual([
      a.id,
      b.id,
    ]);
  });
});

describe("which blood banks are told", () => {
  const bank = (id: string, lat: number | null, lng: number | null, city = "New Delhi") => ({
    id,
    phone: "+91110000000" + id,
    city,
    latitude: lat,
    longitude: lng,
  });

  it("nearby banks, nearest first, capped", () => {
    const pool = [
      bank("3", 28.8, 77.3),
      bank("1", 28.62, 77.21),
      bank("2", 19.07, 72.87, "Mumbai"),
    ];
    expect(rankBanks(pool, delhi, 10).map((r) => r.candidate.id)).toEqual(["1", "3"]);
    expect(rankBanks([bank("1", 28.62, 77.21), bank("3", 28.8, 77.3)], delhi, 1)).toHaveLength(1);
  });
});
