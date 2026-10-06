import { z } from "zod";
import { loginIdSchema } from "../../utils/credentials.js";
import { localDate, nullableEmail, nullableText } from "../../utils/fields.js";
import { normalizeMobile } from "../../utils/phone.js";
import { passwordSchema } from "../../utils/password.js";
import { todayInZone } from "../../utils/time.js";

/** A mobile number that can receive a code, normalised to E.164. */
export const mobileSchema = z
  .string()
  .trim()
  .max(20)
  .transform((v, ctx) => {
    const phone = normalizeMobile(v);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "Enter a valid mobile number" });
      return z.NEVER;
    }
    return phone;
  });

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

/** Latitude and longitude must come together. */
export const bothOrNeither = (v: { latitude?: number | null; longitude?: number | null }) =>
  (v.latitude == null) === (v.longitude == null);
export const BOTH_COORDS = { message: "Give both latitude and longitude", path: ["longitude"] };

const futureOrToday = (v: string) => v >= todayInZone("Asia/Kolkata");

export const bankFields = {
  addressLine1: z.string().trim().min(3, "Enter the address").max(200),
  city: z.string().trim().min(2, "Enter the city").max(80),
  state: nullableText(80),
  postalCode: nullableText(12),
  email: nullableEmail,
  latitude: latitudeSchema.nullable().optional(),
  longitude: longitudeSchema.nullable().optional(),
  is24x7: z.boolean().optional(),
  operatingHours: nullableText(200),
  licenseValidUntil: z
    .union([z.literal(""), localDate.refine(futureOrToday, "The licence must still be valid")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
};

export const registerBankSchema = z
  .object({
    name: z.string().trim().min(3, "Enter the blood bank's name").max(120),
    licenseNumber: z.string().trim().min(4, "Enter the licence number").max(40),
    licenseAuthority: nullableText(120),
    ...bankFields,
    phone: mobileSchema,
    code: otpCodeSchema,
    staff: z.object({
      name: z.string().trim().min(2, "Enter your name").max(100),
      loginId: loginIdSchema,
      password: passwordSchema,
    }),
    acceptPrivacyPolicy: z.literal(true, "You must accept the privacy policy"),
    acceptTerms: z.literal(true, "You must accept the terms"),
  })
  .refine(bothOrNeither, BOTH_COORDS);

/** Name, licence number and authority can change only while the bank is REJECTED (resubmitting). */
export const updateBankSchema = z
  .object({
    ...bankFields,
    addressLine1: bankFields.addressLine1.optional(),
    city: bankFields.city.optional(),
    name: z.string().trim().min(3).max(120).optional(),
    licenseNumber: z.string().trim().min(4).max(40).optional(),
    licenseAuthority: nullableText(120),
  })
  .refine(bothOrNeither, BOTH_COORDS);

export const createBankStaffSchema = z.object({
  name: z.string().trim().min(2, "Enter the name").max(100),
  loginId: loginIdSchema.optional(),
});

export const rejectBankSchema = z.object({
  reason: z.string().trim().min(5, "Say why, so the blood bank can fix it").max(500),
});
export const blockBankSchema = z.object({
  reason: z.string().trim().min(5, "Give a reason").max(500),
});
