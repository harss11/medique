import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Normalises a mobile number from user input ("98765 43210", "+91-98765-43210",
 * "09876543210") to E.164 ("+919876543210"). India is the default country, but
 * numbers with an explicit +CC prefix are accepted so we can go global.
 * Returns null for anything that is not a valid mobile number.
 */
export function normalizeMobile(input: string, defaultCountry: CountryCode = "IN"): string | null {
  // Letters are rejected outright (libphonenumber would map them like a keypad).
  if (/[a-z]/i.test(input)) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  // Indian mobile numbers start with 6-9; landlines cannot receive OTPs.
  if (parsed.country === "IN" && !/^[6-9]/.test(parsed.nationalNumber)) return null;
  return parsed.number;
}

/**
 * Normalises any phone number (mobile or landline, e.g. a hospital's front desk
 * or emergency line) to E.164. Returns null when invalid.
 */
export function normalizeAnyPhone(
  input: string,
  defaultCountry: CountryCode = "IN",
): string | null {
  if (/[a-z]/i.test(input)) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

/** "+919876543210" -> "+91******3210" for logs and UI hints. */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return "*".repeat(e164.length);
  return e164.slice(0, 3) + "*".repeat(e164.length - 7) + e164.slice(-4);
}
