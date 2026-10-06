import type { BloodGroup, Gender } from "../../generated/prisma/client.js";
import { ageInYears } from "../queue/queue-rules.js";

/**
 * Pure rules for the blood bank module, kept free of I/O so they are easy to test. MediQ only
 * connects people: these rules protect donors from being asked too early and requesters from
 * being shown more than they should, but they are no substitute for a blood bank's own screening.
 */

export const BLOOD_GROUPS: readonly BloodGroup[] = [
  "A_POS",
  "A_NEG",
  "B_POS",
  "B_NEG",
  "AB_POS",
  "AB_NEG",
  "O_POS",
  "O_NEG",
];

/** "A_POS" to "A+". */
export function bloodGroupLabel(group: BloodGroup): string {
  return group.replace("_POS", "+").replace("_NEG", "-");
}

export interface DonorRules {
  gapDaysMale: number;
  gapDaysOther: number;
  minAge: number;
  maxAge: number;
}

const DAY = 86_400_000;

/** Waiting period after a donation: shorter for men; women and anyone who did not say wait longer. */
export function gapDaysFor(gender: Gender, rules: DonorRules): number {
  return gender === "MALE" ? rules.gapDaysMale : rules.gapDaysOther;
}

/** The first moment the donor may donate again, or null if they have never donated. */
export function nextEligibleAt(
  lastDonationAt: Date | null,
  gender: Gender,
  rules: DonorRules,
): Date | null {
  return lastDonationAt
    ? new Date(lastDonationAt.getTime() + gapDaysFor(gender, rules) * DAY)
    : null;
}

export type Ineligible = "TOO_YOUNG" | "TOO_OLD" | "WAITING_PERIOD";

export interface Eligibility {
  eligible: boolean;
  reasons: Ineligible[];
  /** When the waiting period ends (null if not waiting). */
  nextEligibleAt: Date | null;
}

/** Whether a donor may donate now: old enough, not too old, and past the waiting period. */
export function donationEligibility(
  donor: { dateOfBirth: Date; gender: Gender; lastDonationAt: Date | null },
  now: Date,
  rules: DonorRules,
): Eligibility {
  const reasons: Ineligible[] = [];
  const age = ageInYears(donor.dateOfBirth, now) ?? 0;
  if (age < rules.minAge) reasons.push("TOO_YOUNG");
  if (age > rules.maxAge) reasons.push("TOO_OLD");
  const next = nextEligibleAt(donor.lastDonationAt, donor.gender, rules);
  const waiting = next !== null && next.getTime() > now.getTime();
  if (waiting) reasons.push("WAITING_PERIOD");
  return { eligible: reasons.length === 0, reasons, nextEligibleAt: waiting ? next : null };
}

/** Donors are alerted only when they are eligible AND have not paused themselves. */
export function canBeAlerted(
  donor: { dateOfBirth: Date; gender: Gender; lastDonationAt: Date | null; isAvailable: boolean },
  now: Date,
  rules: DonorRules,
): boolean {
  return donor.isAvailable && donationEligibility(donor, now, rules).eligible;
}

/** About 1 km: enough to find requests nearby, not enough to find the person. */
export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A latitude/longitude box that contains every point within `radiusKm` (a cheap first filter). */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** What a requester may learn about a donor's name before meeting them: the first name only. */
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

/** Licence numbers compare case-insensitively and ignore stray spaces. */
export function normalizeLicense(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

/** City names compare case-insensitively and ignore stray spaces. */
export function cityKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function requestExpiry(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() + ttlHours * 3_600_000);
}

/** Stock figures older than this are only a guess: show them as "call to confirm". */
export function stockIsStale(updatedAt: Date | null, now: Date, staleHours: number): boolean {
  return updatedAt === null || now.getTime() - updatedAt.getTime() > staleHours * 3_600_000;
}
