import { z } from "zod";
import { localDate } from "../../utils/fields.js";
import { todayInZone } from "../../utils/time.js";
import { BOTH_COORDS, bothOrNeither, latitudeSchema, longitudeSchema } from "./bank.schemas.js";
import { bloodGroupSchema } from "./blood-schemas.js";

const bornBefore = (v: string) => v <= todayInZone("Asia/Kolkata") && v >= "1900-01-01";

export const donorProfileSchema = z
  .object({
    bloodGroup: bloodGroupSchema,
    gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]),
    dateOfBirth: localDate.refine(bornBefore, "Enter a valid date of birth"),
    city: z.string().trim().min(2, "Enter your city").max(80),
    latitude: latitudeSchema.nullable().optional(),
    longitude: longitudeSchema.nullable().optional(),
    /** Required the first time: the donor agrees to be alerted and to share their number after saying "I can help". */
    acceptAlerts: z.boolean().optional(),
  })
  .refine(bothOrNeither, BOTH_COORDS);

export const availabilitySchema = z.object({ isAvailable: z.boolean() });

export const lookupQuery = z.object({ phone: z.string().trim().min(6).max(20) });

export const recordDonationSchema = z.object({
  donorId: z.uuid("Choose a donor"),
  /** Confirmed by the bank's own test, not just claimed by the donor. */
  bloodGroup: bloodGroupSchema,
  volumeMl: z.number().int().min(200).max(600).default(350),
});

export const voidDonationSchema = z.object({
  reason: z.string().trim().min(5, "Say what went wrong").max(300),
});
