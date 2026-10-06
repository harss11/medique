import type { BloodGroup, Gender } from "../../generated/prisma/client.js";
import { distanceKm } from "../../utils/geo.js";
import { canBeAlerted, cityKey, type DonorRules } from "./blood-rules.js";

/**
 * Who is told about a blood request. Pure, so the rules can be tested without a database:
 * the caller loads candidates (cheaply filtered by blood group and a bounding box) and this
 * decides, in order, who qualifies and who is nearest.
 */

export interface RequestPlace {
  city: string;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
}

export interface DonorCandidate {
  id: string;
  userId: string;
  phone: string;
  bloodGroup: BloodGroup;
  gender: Gender;
  dateOfBirth: Date;
  lastDonationAt: Date | null;
  isAvailable: boolean;
  city: string;
  latitude: number | null;
  longitude: number | null;
  /** Alerts this donor already received in the last 24 hours. */
  alertsToday: number;
}

export interface BankCandidate {
  id: string;
  phone: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
}

export interface Recipient<T> {
  candidate: T;
  /** Null when the match was by city (a coordinate is missing on one side). */
  distanceKm: number | null;
}

/**
 * A place counts as near when both have coordinates and are within the radius, or, when a
 * coordinate is missing on either side, when they are in the same city.
 */
export function nearBy(
  place: RequestPlace,
  other: { city: string; latitude: number | null; longitude: number | null },
): { near: boolean; distanceKm: number | null } {
  const bothLocated =
    place.latitude != null &&
    place.longitude != null &&
    other.latitude != null &&
    other.longitude != null;
  if (bothLocated) {
    const km = distanceKm(
      { lat: place.latitude!, lng: place.longitude! },
      { lat: other.latitude!, lng: other.longitude! },
    );
    return { near: km <= place.radiusKm, distanceKm: Math.round(km * 10) / 10 };
  }
  return { near: cityKey(place.city) === cityKey(other.city), distanceKm: null };
}

const nearestFirst = <T extends { id: string }>(a: Recipient<T>, b: Recipient<T>) =>
  (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
  a.candidate.id.localeCompare(b.candidate.id);

export function rankDonors(
  candidates: DonorCandidate[],
  request: RequestPlace & { bloodGroup: BloodGroup; requesterPhone: string },
  now: Date,
  rules: DonorRules,
  limits: { maxDonors: number; maxAlertsPerDay: number },
): Recipient<DonorCandidate>[] {
  return (
    candidates
      .filter((d) => d.bloodGroup === request.bloodGroup)
      // Never alert the person asking, even if they are a donor too.
      .filter((d) => d.phone !== request.requesterPhone)
      .filter((d) => canBeAlerted(d, now, rules))
      .filter((d) => d.alertsToday < limits.maxAlertsPerDay)
      .map((d) => ({ candidate: d, ...nearBy(request, d) }))
      .filter((m) => m.near)
      .map((m) => ({ candidate: m.candidate, distanceKm: m.distanceKm }))
      .sort(nearestFirst)
      .slice(0, limits.maxDonors)
  );
}

export function rankBanks(
  candidates: BankCandidate[],
  request: RequestPlace,
  maxBanks: number,
): Recipient<BankCandidate>[] {
  return candidates
    .map((b) => ({ candidate: b, ...nearBy(request, b) }))
    .filter((m) => m.near)
    .map((m) => ({ candidate: m.candidate, distanceKm: m.distanceKm }))
    .sort(nearestFirst)
    .slice(0, maxBanks);
}
