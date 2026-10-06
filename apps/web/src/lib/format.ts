/** Display helpers. Money is always minor units (paise) in the API. */

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatMoney(minor: number, currency = "INR"): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

/** "500" or "500.50" (rupees, as typed) -> 50000 / 50050 paise. NaN when invalid. */
export function toMinor(major: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(major.trim())) return Number.NaN;
  return Math.round(Number(major) * 100);
}

export function toMajor(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

/** Time of an instant in the hospital's timezone, e.g. "9:30 am". */
export function formatTime(iso: string, timeZone = "Asia/Kolkata"): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

/** "2026-10-12" -> "Mon, 12 Oct 2026" without timezone shifts. */
export function formatDate(localDate: string): string {
  return new Date(`${localDate}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/** Today's date in a timezone as "YYYY-MM-DD". */
export function todayIn(timeZone = "Asia/Kolkata"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

export function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Form helper: trimmed text, or null when empty (the API treats null as "clear"). */
export function textOrNull(value: string): string | null {
  const t = value.trim();
  return t === "" ? null : t;
}

/** Form helper: integer from an input, or null when empty. */
export function intOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

/** "K7M29QXF3R" -> "K7M2-9QXF-3R" for display and reading aloud. */
export function formatCheckInCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** Google Maps directions link: coordinates when known, otherwise the address text. */
export function directionsUrl(h: {
  latitude: number | null;
  longitude: number | null;
  name: string;
  addressLine1: string | null;
  city: string | null;
}): string {
  const destination =
    h.latitude != null && h.longitude != null
      ? `${h.latitude},${h.longitude}`
      : [h.name, h.addressLine1, h.city].filter(Boolean).join(", ");
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** "Full refund if you cancel at least 24 hours before; 50% refund after that." */
export function describeRefundPolicy(policy: {
  fullRefundHours: number;
  partialPercent: number;
}): string {
  const after = policy.partialPercent === 0 ? "no refund" : `${policy.partialPercent}% refund`;
  if (policy.fullRefundHours <= 0) {
    return `${after.charAt(0).toUpperCase()}${after.slice(1)} when you cancel.`;
  }
  return `Full refund if you cancel at least ${policy.fullRefundHours} hours before; ${after} after that.`;
}
