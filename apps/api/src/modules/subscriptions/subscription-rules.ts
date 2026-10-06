import { addDays, todayInZone, zonedTimeToUtc } from "../../utils/time.js";

/**
 * Hospital subscription rules, kept pure. A hospital's plan decides how many doctors and staff it
 * can have, how many online bookings a month it can take, and which extras it can use. The money
 * is handled offline: an admin assigns the plan and records the payments.
 */

export type StoredStatus = "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";

/**
 * What the hospital can do right now, from the stored status and the dates:
 * GRACE is a short time after a paid period or trial ended during which nothing stops yet.
 */
export type AccessState = "TRIALING" | "ACTIVE" | "GRACE" | "EXPIRED" | "SUSPENDED" | "CANCELLED";

export interface SubscriptionDates {
  status: StoredStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

const DAY = 86_400_000;

export function accessState(sub: SubscriptionDates, now: Date, graceDays: number): AccessState {
  if (sub.status === "SUSPENDED") return "SUSPENDED";
  if (sub.status === "CANCELLED") return "CANCELLED";
  const end = sub.status === "TRIALING" ? sub.trialEndsAt : sub.currentPeriodEnd;
  // No end date: a free plan or an open-ended arrangement.
  if (end === null) return sub.status;
  if (now.getTime() <= end.getTime()) return sub.status;
  if (now.getTime() <= end.getTime() + graceDays * DAY) return "GRACE";
  return "EXPIRED";
}

/** New online bookings are taken only while the subscription is in good standing (or in its grace days). */
export function acceptsBookings(state: AccessState): boolean {
  return state === "TRIALING" || state === "ACTIVE" || state === "GRACE";
}

/** Can one more be added? `limit` null means unlimited. */
export function withinLimit(limit: number | null, used: number): boolean {
  return limit === null || used < limit;
}

/** The same day of the month `months` later, or the last day of a shorter month (31 Jan + 1 = 28 Feb). */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/**
 * The period a payment buys. It continues from the end of the current paid period, so paying
 * early loses nothing; after a lapse it starts today.
 */
export function paidPeriod(
  currentPeriodEnd: Date | null,
  now: Date,
  months: number,
): { start: Date; end: Date } {
  const start =
    currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime() ? currentPeriodEnd : now;
  return { start, end: addMonths(start, months) };
}

/** Whole days until `end` (0 on the last day, negative once it has passed); null when there is no end. */
export function daysLeft(end: Date | null, now: Date): number | null {
  if (end === null) return null;
  return Math.ceil((end.getTime() - now.getTime()) / DAY);
}

/** The calendar month containing `now` in the hospital's time zone, as [from, to) instants. */
export function monthRange(now: Date, timezone: string): { from: Date; to: Date } {
  const today = todayInZone(timezone, now);
  const first = `${today.slice(0, 7)}-01`;
  // 32 days after the 1st is always in the next month; snap back to its 1st.
  const next = `${addDays(first, 32).slice(0, 7)}-01`;
  return { from: zonedTimeToUtc(first, 0, timezone), to: zonedTimeToUtc(next, 0, timezone) };
}

/** What to tell the hospital admin about the subscription, if anything. */
export type Notice = "none" | "ending_soon" | "grace" | "expired" | "suspended" | "cancelled";

export function noticeFor(state: AccessState, end: Date | null, now: Date, warnDays = 7): Notice {
  if (state === "SUSPENDED") return "suspended";
  if (state === "CANCELLED") return "cancelled";
  if (state === "EXPIRED") return "expired";
  if (state === "GRACE") return "grace";
  const left = daysLeft(end, now);
  return left !== null && left <= warnDays ? "ending_soon" : "none";
}
