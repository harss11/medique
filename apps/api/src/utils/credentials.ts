import { randomInt } from "node:crypto";
import { z } from "zod";

// No 0/O, 1/l/I: temporary passwords are read aloud and typed by hand.
const LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const ALPHABET = LETTERS + DIGITS;

/**
 * Random temporary password like "Kp7m-Xq4z-Rt9b" (12 random characters,
 * ~70 bits). Always contains a letter and a digit, so it satisfies the
 * password policy. The user must replace it on first login.
 */
export function generateTempPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
    const value = chars.join("");
    if (/[A-Za-z]/.test(value) && /\d/.test(value)) {
      return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
    }
  }
}

/** Login IDs: lower-case letters, digits, dot, dash, underscore; 3-64 chars. */
export const loginIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9._-]{2,63}$/,
    "Use 3-64 lower-case letters, digits, dots, dashes or underscores",
  );

/** URL slugs for /h/{slug}: "sunrise-hospital" */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, digits and single dashes");

export function slugify(input: string, maxLength = 50): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength)
      .replace(/-+$/g, "") || "hospital"
  );
}

/**
 * Returns `base`, or `base-2`, `base-3`, ... (`separator` configurable) — the
 * first candidate for which `isTaken` is false.
 */
export async function firstAvailable(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  separator = "-",
): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? base : `${base}${separator}${i}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`No free value for ${base}`);
}
