import { z } from "zod";
import { nullableText } from "../../utils/fields.js";
import {
  BOTH_COORDS,
  bothOrNeither,
  latitudeSchema,
  longitudeSchema,
  mobileSchema,
  otpCodeSchema,
} from "./bank.schemas.js";
import { bloodGroupSchema } from "./blood-schemas.js";

export const createRequestSchema = z
  .object({
    phone: mobileSchema,
    code: otpCodeSchema,
    requesterName: z.string().trim().min(2, "Enter your name").max(80),
    bloodGroup: bloodGroupSchema,
    unitsNeeded: z.number().int().min(1).max(10),
    urgency: z.enum(["EMERGENCY", "URGENT"]).default("EMERGENCY"),
    /** The hospital where the patient is. */
    hospitalName: z.string().trim().min(3, "Enter the hospital").max(120),
    city: z.string().trim().min(2, "Enter the city").max(80),
    latitude: latitudeSchema.nullable().optional(),
    longitude: longitudeSchema.nullable().optional(),
    radiusKm: z.number().int().min(5).max(50).default(25),
    /** Shown to donors: keep it short and free of medical detail. */
    note: nullableText(200),
    /** The requester confirms they understand what MediQ does and does not do. */
    acceptDisclaimer: z.literal(true, "Please confirm you understand how this works"),
  })
  .refine(bothOrNeither, BOTH_COORDS);

export const recoverRequestsSchema = z.object({ phone: mobileSchema, code: otpCodeSchema });

export const closeRequestSchema = z.object({ outcome: z.enum(["FULFILLED", "CANCELLED"]) });

export const respondSchema = z.object({ response: z.enum(["CAN_HELP", "CANNOT"]) });

export const cancelByAdminSchema = z.object({
  reason: z.string().trim().min(5, "Give a reason").max(300),
});
