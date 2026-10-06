/**
 * Calendar helpers that respect each hospital's IANA timezone without a date
 * library. A "local date" is always a "YYYY-MM-DD" string; instants are Dates.
 *
 * Postgres `date` columns are passed to Prisma as UTC-midnight Dates
 * (see `dateOnly` / `toLocalDate`).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidLocalDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Offset of `tz` from UTC at the given instant, in milliseconds. */
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant when the wall clock in `tz` shows `date` + `minuteOfDay`. */
export function zonedTimeToUtc(date: string, minuteOfDay: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  // Two passes handle DST transitions (irrelevant for India, needed elsewhere).
  const first = wallAsUtc - offsetMs(wallAsUtc, tz);
  const second = wallAsUtc - offsetMs(first, tz);
  return new Date(second);
}

/** Today's local date in `tz`. */
export function todayInZone(tz: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** "YYYY-MM-DD" -> Date for a Prisma `@db.Date` field. */
export function dateOnly(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Prisma `@db.Date` value -> "YYYY-MM-DD". */
export function toLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 540 -> "09:00" */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "09:00" -> 540, or null when invalid. "24:00" is allowed as end of day. */
export function timeToMinutes(time: string): number | null {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

/** "Mon, 12 Oct" for an instant, in a timezone (used in messages). */
export function formatDateShort(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: tz,
  }).format(instant);
}

/** "9:30 am" for an instant, in a timezone. */
export function formatTimeShort(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  })
    .format(instant)
    .toLowerCase();
}
