import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** URL-safe random token, e.g. for refresh tokens and QR tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Cryptographically random numeric code with leading zeros, e.g. "042917". */
export function randomNumericCode(length = 6): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, "0");
}
