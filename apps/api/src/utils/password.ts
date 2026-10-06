import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "../config/env.js";

/**
 * Password policy (NIST 800-63B style): length over composition rules, but we
 * still require a letter and a digit because staff passwords are often short.
 * bcrypt only uses the first 72 bytes, so longer inputs are rejected instead of
 * being silently truncated.
 */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "Password must be at most 72 bytes")
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Password must contain a letter and a number");

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Compared against when the login ID does not exist, so that response time does
// not reveal which login IDs are valid.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing-1", 10);

export async function burnPasswordCheck(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}
