import { randomInt } from "node:crypto";
import { env } from "../../config/env.js";
import type { AppointmentStatus } from "../../generated/prisma/client.js";

/**
 * Pure booking rules, kept free of I/O so they are easy to test.
 *
 * Invariant used everywhere: an appointment holds a seat in its slot if and only
 * if `seatNumber` is not null. Cancelling or expiring clears the seat, and
 * `Slot.bookedCount` is always recomputed as the number of seat holders.
 */

const MINUTE = 60_000;

/** Statuses of an appointment that is (or was) really going to happen. */
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "NO_SHOW",
];

/** Statuses a patient may still cancel or reschedule (time rules apply on top). */
export const CHANGEABLE_STATUSES: readonly AppointmentStatus[] = ["CONFIRMED"];

/** Lowest free seat number in 1..capacity, or null when the slot is full. */
export function pickSeat(usedSeats: readonly number[], capacity: number): number | null {
  const used = new Set(usedSeats);
  for (let seat = 1; seat <= capacity; seat++) {
    if (!used.has(seat)) return seat;
  }
  return null;
}

/** Online booking closes shortly before the slot starts. */
export function isBookable(
  slotStart: Date,
  now: Date,
  closesMinutesBefore = env.BOOKING_CLOSES_MINUTES_BEFORE,
): boolean {
  return slotStart.getTime() - closesMinutesBefore * MINUTE > now.getTime();
}

/** Cancel / reschedule are allowed until shortly before the slot starts. */
export function isChangeable(
  slotStart: Date,
  now: Date,
  closesMinutesBefore = env.CHANGE_CLOSES_MINUTES_BEFORE,
): boolean {
  return slotStart.getTime() - closesMinutesBefore * MINUTE > now.getTime();
}

export function holdExpiry(now: Date, minutes = env.BOOKING_HOLD_MINUTES): Date {
  return new Date(now.getTime() + minutes * MINUTE);
}

/** Platform commission on an amount, in minor units, rounded to the nearest paisa. */
export function commissionAmount(amountMinor: number, percent: number): number {
  return Math.round((amountMinor * percent) / 100);
}

// Check-in codes are read aloud and typed at the desk: no 0/O, 1/I/L look-alikes.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CHECK_IN_CODE_LENGTH = 10;

/** 10 random characters (~50 bits). Unique in the database; unguessable in practice. */
export function generateCheckInCode(): string {
  let code = "";
  for (let i = 0; i < CHECK_IN_CODE_LENGTH; i++)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** "K7M29QXF3R" -> "K7M2-9QXF-3R" for display. */
export function formatCheckInCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** Accepts what a person types: any case, with or without dashes/spaces. */
export function normalizeCheckInCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
