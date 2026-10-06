import { z } from "zod";
import type { Hospital } from "../../generated/prisma/client.js";
import { loginIdSchema, slugSchema } from "../../utils/credentials.js";
import { nullableEmail, nullablePhone, nullableText, percent } from "../../utils/fields.js";
import { paginationQuery } from "../../utils/pagination.js";
import { isValidTimeZone } from "../../utils/time.js";

const coordinate = (limit: number) => z.number().min(-limit).max(limit).nullable().optional();
const beds = z.number().int().min(0).max(100_000).nullable().optional();

/** Contact and address fields a hospital may edit about itself. */
const profileFields = {
  description: nullableText(2000),
  phone: nullablePhone,
  email: nullableEmail,
  addressLine1: nullableText(200),
  addressLine2: nullableText(200),
  city: nullableText(100),
  state: nullableText(100),
  postalCode: nullableText(12),
  latitude: coordinate(90),
  longitude: coordinate(180),
};

const timezone = z.string().refine(isValidTimeZone, "Unknown timezone");

// ----- admin -----

export const listHospitalsQuery = paginationQuery.extend({
  status: z.enum(["PENDING_APPROVAL", "ACTIVE", "BLOCKED"]).optional(),
  search: z.string().trim().max(100).optional(),
});

export const createHospitalSchema = z.object({
  ...profileFields,
  name: z.string().trim().min(3, "Enter the hospital name").max(120),
  city: z.string().trim().min(2, "Enter the city").max(100),
  /** Defaults to a slug of the name. Becomes the public URL /h/{slug}. */
  slug: slugSchema.optional(),
  emergencyPhone: nullablePhone,
  country: z.string().trim().length(2).toUpperCase().default("IN"),
  timezone: timezone.default("Asia/Kolkata"),
  currency: z.string().trim().length(3).toUpperCase().default("INR"),
  commissionPercent: percent.default(0),
  /** Full refund when a patient cancels at least this many hours before the slot. */
  refundFullHours: z.number().int().min(0).max(720).default(24),
  /** Percent refunded for later cancellations. */
  refundPartialPercent: z.number().int().min(0).max(100).default(50),
  totalBeds: beds,
  /** Hospital admin account. */
  adminName: z.string().trim().min(2).max(100).optional(),
  loginId: loginIdSchema.optional(),
  /** Create as ACTIVE straight away instead of PENDING_APPROVAL. */
  approve: z.boolean().default(false),
});

export const adminUpdateHospitalSchema = z.object({
  ...profileFields,
  name: z.string().trim().min(3).max(120).optional(),
  /** Only while pending approval: printed QR codes depend on the slug. */
  slug: slugSchema.optional(),
  emergencyPhone: nullablePhone,
  country: z.string().trim().length(2).toUpperCase().optional(),
  timezone: timezone.optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  commissionPercent: percent.optional(),
  refundFullHours: z.number().int().min(0).max(720).optional(),
  refundPartialPercent: z.number().int().min(0).max(100).optional(),
  totalBeds: beds,
  availableBeds: beds,
});

export const blockHospitalSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason").max(500),
});

export const resetCredentialsSchema = z.object({
  /** A specific hospital admin user; defaults to the hospital's first admin. */
  userId: z.uuid().optional(),
});

// ----- hospital self-service -----

export const updateProfileSchema = z.object(profileFields);

export const updateEmergencySchema = z
  .object({
    emergencyPhone: nullablePhone,
    totalBeds: beds,
    availableBeds: beds,
  })
  .refine((v) => v.totalBeds == null || v.availableBeds == null || v.availableBeds <= v.totalBeds, {
    message: "Available beds cannot exceed total beds",
    path: ["availableBeds"],
  });

// ----- output -----

/** The only hospital shape returned by the API (Decimal -> number). */
export function toHospitalDto(h: Hospital) {
  return {
    id: h.id,
    name: h.name,
    slug: h.slug,
    status: h.status,
    description: h.description,
    logoUrl: h.logoUrl,
    phone: h.phone,
    email: h.email,
    emergencyPhone: h.emergencyPhone,
    addressLine1: h.addressLine1,
    addressLine2: h.addressLine2,
    city: h.city,
    state: h.state,
    postalCode: h.postalCode,
    country: h.country,
    latitude: h.latitude,
    longitude: h.longitude,
    timezone: h.timezone,
    currency: h.currency,
    commissionPercent: h.commissionPercent.toNumber(),
    refundFullHours: h.refundFullHours,
    refundPartialPercent: h.refundPartialPercent,
    totalBeds: h.totalBeds,
    availableBeds: h.availableBeds,
    bedsUpdatedAt: h.bedsUpdatedAt,
    approvedAt: h.approvedAt,
    blockedAt: h.blockedAt,
    blockedReason: h.blockedReason,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}
