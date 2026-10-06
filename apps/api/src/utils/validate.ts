import type { z } from "zod";
import { AppError } from "./http.js";

/**
 * Validates untrusted input (body, query, params) against a Zod schema and
 * returns the typed, parsed value. Throws a 400 VALIDATION_ERROR otherwise.
 *
 *   const body = parse(loginSchema, req.body);
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw AppError.badRequest(
      "Some fields are missing or invalid",
      "VALIDATION_ERROR",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
