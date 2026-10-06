import { AppError } from "../../utils/http.js";
import { addDays } from "../../utils/time.js";

/** Pure rules for the dashboards, kept free of I/O so they are easy to test. */

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

export interface DateRange {
  from: string;
  to: string;
  days: number;
}

const DAY = 86_400_000;
const dayNumber = (date: string) => Date.parse(date + "T00:00:00Z") / DAY;

/**
 * The period to report on. Defaults to the last 30 days ending today; `days` picks another length
 * (counted back from `to`, in the caller's timezone, so "last 7 days" is right at any hour). `from` and `to` are
 * inclusive local dates. A reversed or oversized range is rejected rather than silently fixed.
 */
export function resolveRange(
  input: { from?: string; to?: string; days?: number },
  today: string,
): DateRange {
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -((input.days ?? DEFAULT_DAYS) - 1));
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (days < 1) {
    throw AppError.badRequest("The start date must not be after the end date", "INVALID_RANGE");
  }
  if (days > MAX_DAYS) {
    throw AppError.badRequest(`Choose a period of at most ${MAX_DAYS} days`, "INVALID_RANGE");
  }
  return { from, to, days };
}

/** Every date from `from` to `to`, inclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A complete series: days with no data are present with zeroes, so charts show real gaps. */
export function fillDaily<T extends { date: string }>(
  rows: T[],
  range: Pick<DateRange, "from" | "to">,
  zero: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return eachDate(range.from, range.to).map((d) => byDate.get(d) ?? zero(d));
}

/** Percentage with one decimal, or null when there is nothing to divide by. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Commission kept on a payment after refunds: the share of the amount that was not returned. */
export function commissionKept(commission: number, amount: number, refunded: number): number {
  if (amount <= 0 || commission <= 0) return 0;
  const keptShare = Math.max(0, Math.min(1, (amount - refunded) / amount));
  return Math.round(commission * keptShare);
}

/** Rounds minutes to one decimal; null stays null (no data). */
export function roundMinutes(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}
