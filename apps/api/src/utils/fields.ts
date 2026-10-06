import { z } from "zod";
import { normalizeAnyPhone } from "./phone.js";
import { isValidLocalDate } from "./time.js";

/**
 * Reusable Zod field types for forms.
 *
 * "nullable" fields are for PATCH bodies: omitted = leave unchanged,
 * "" or null = clear the value.
 */

export const idParams = z.object({ id: z.uuid("Invalid id") });

/** Trimmed text; "" becomes null. */
export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/** Phone number normalised to E.164; "" becomes null. */
export const nullablePhone = z
  .string()
  .trim()
  .max(20)
  .transform((v, ctx) => {
    if (v === "") return null;
    const phone = normalizeAnyPhone(v);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "Enter a valid phone number" });
      return z.NEVER;
    }
    return phone;
  })
  .nullable()
  .optional();

export const nullableEmail = z
  .union([z.literal(""), z.email("Enter a valid email").max(254)])
  .transform((v) => (v === "" ? null : v.toLowerCase()))
  .nullable()
  .optional();

/** "YYYY-MM-DD" */
export const localDate = z.string().refine(isValidLocalDate, "Use the format YYYY-MM-DD");

/** Money in minor units (paise). Max ₹10,00,000. */
export const amountMinor = z.number().int().min(0).max(1_000_000_00);

/** Percentage with at most two decimals, 0-100. */
export const percent = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, "At most 2 decimal places");

/** Boolean query-string flag: ?active=true */
export const queryBool = z.enum(["true", "false"]).transform((v) => v === "true");
