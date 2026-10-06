import type { Response } from "express";

/**
 * Every response has the same envelope: { success, data, error }.
 * Errors carry a stable machine-readable `code` the clients can switch on.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: ApiErrorBody | null;
}

export function ok<T>(res: Response, data: T, status = 200): Response<ApiEnvelope<T>> {
  return res.status(status).json({ success: true, data, error: null });
}

export function fail(
  res: Response,
  status: number,
  error: ApiErrorBody,
): Response<ApiEnvelope<null>> {
  return res.status(status).json({ success: false, data: null, error });
}

/** Throw this from anywhere; the error handler turns it into the envelope. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, code = "BAD_REQUEST", details?: unknown) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(message = "Authentication required", code = "UNAUTHORIZED") {
    return new AppError(401, code, message);
  }
  static forbidden(message = "You do not have permission to do this", code = "FORBIDDEN") {
    return new AppError(403, code, message);
  }
  static notFound(message = "Not found", code = "NOT_FOUND") {
    return new AppError(404, code, message);
  }
  static conflict(message: string, code = "CONFLICT") {
    return new AppError(409, code, message);
  }
  static tooMany(message: string, code = "RATE_LIMITED", details?: unknown) {
    return new AppError(429, code, message, details);
  }
}

/** "Rs.500" / "Rs.250.50" for INR, "USD 5.00" otherwise. Minor units in, text out. */
export function formatMoneyText(minor: number, currency = "INR"): string {
  const major = minor / 100;
  const text = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return currency === "INR" ? `Rs.${text}` : `${currency} ${major.toFixed(2)}`;
}

/** Sends a generated PDF to be viewed in the browser (never cached: it contains personal data). */
export function sendPdf(res: Response, filename: string, bytes: Uint8Array): void {
  res
    .status(200)
    .setHeader("Content-Type", "application/pdf")
    .setHeader("Content-Disposition", `inline; filename="${filename.replace(/[^\w.-]/g, "_")}"`)
    .setHeader("Cache-Control", "no-store")
    .send(Buffer.from(bytes));
}
