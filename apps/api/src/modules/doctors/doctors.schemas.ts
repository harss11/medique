import { z } from "zod";
import type { Doctor, DoctorSchedule } from "../../generated/prisma/client.js";
import { loginIdSchema } from "../../utils/credentials.js";
import { amountMinor, localDate, nullableText, queryBool } from "../../utils/fields.js";
import { MAX_PAGE_SIZE, paginationQuery } from "../../utils/pagination.js";
import { minutesToTime, timeToMinutes, toLocalDate } from "../../utils/time.js";
import { sessionsOverlap } from "../slots/slot-plan.js";

const gender = z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]);

const doctorFields = {
  departmentId: z.uuid("Choose a department"),
  name: z.string().trim().min(2, "Enter the doctor's name").max(100),
  qualification: nullableText(200),
  specialization: nullableText(120),
  registrationNumber: nullableText(60),
  experienceYears: z.number().int().min(0).max(70).nullable().optional(),
  gender: gender.nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  bio: nullableText(2000),
  /** Minor units (paise): ₹500 = 50000 */
  consultationFee: amountMinor,
  avgConsultMinutes: z.number().int().min(1).max(120).optional(),
};

export const listDoctorsQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  departmentId: z.uuid().optional(),
  active: queryBool.optional(),
});

export const createDoctorSchema = z.object(doctorFields);

export const updateDoctorSchema = z
  .object(doctorFields)
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const createDoctorLoginSchema = z.object({ loginId: loginIdSchema.optional() });

// ----- weekly schedule -----

const sessionSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string(),
    endTime: z.string(),
    slotMinutes: z.number().int().min(5).max(240),
    capacityPerSlot: z.number().int().min(1).max(50).default(1),
  })
  .transform((s, ctx) => {
    const startMinute = timeToMinutes(s.startTime);
    const endMinute = timeToMinutes(s.endTime);
    if (startMinute === null || endMinute === null) {
      ctx.addIssue({ code: "custom", message: "Use 24-hour times like 09:30" });
      return z.NEVER;
    }
    if (endMinute <= startMinute) {
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time",
      });
      return z.NEVER;
    }
    if (endMinute - startMinute < s.slotMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["slotMinutes"],
        message: "Session is shorter than one slot",
      });
      return z.NEVER;
    }
    return {
      dayOfWeek: s.dayOfWeek,
      startMinute,
      endMinute,
      slotMinutes: s.slotMinutes,
      capacityPerSlot: s.capacityPerSlot,
    };
  });

/** PUT replaces the whole weekly schedule. */
export const scheduleSchema = z
  .object({ sessions: z.array(sessionSchema).max(42) })
  .superRefine(({ sessions }, ctx) => {
    sessions.forEach((a, i) => {
      sessions.slice(i + 1).forEach((b, j) => {
        if (sessionsOverlap(a, b)) {
          ctx.addIssue({
            code: "custom",
            path: ["sessions", i + 1 + j],
            message: "Overlaps another session on the same day",
          });
        }
      });
    });
  });

// ----- leaves and slots -----

export const createLeaveSchema = z
  .object({
    startDate: localDate,
    endDate: localDate,
    reason: nullableText(200),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "End date must be on or after start date",
    path: ["endDate"],
  });

export const listLeavesQuery = paginationQuery.extend({ includePast: queryBool.optional() });

export const listSlotsQuery = paginationQuery
  .extend({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
    from: localDate.optional(),
    to: localDate.optional(),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, { message: "to must be on or after from" });

export const updateSlotSchema = z.object({ status: z.enum(["OPEN", "BLOCKED"]) });

// ----- output -----

export function toScheduleDto(s: DoctorSchedule) {
  return {
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: minutesToTime(s.startMinute),
    endTime: minutesToTime(s.endMinute),
    slotMinutes: s.slotMinutes,
    capacityPerSlot: s.capacityPerSlot,
  };
}

type DoctorWithRelations = Doctor & {
  department?: { id: string; name: string } | null;
  user?: { id: string; loginId: string | null; status: string; mustChangePassword: boolean } | null;
};

export function toDoctorDto(d: DoctorWithRelations) {
  return {
    id: d.id,
    departmentId: d.departmentId,
    department: d.department ?? undefined,
    name: d.name,
    qualification: d.qualification,
    specialization: d.specialization,
    registrationNumber: d.registrationNumber,
    experienceYears: d.experienceYears,
    gender: d.gender,
    languages: d.languages,
    bio: d.bio,
    photoUrl: d.photoUrl,
    consultationFee: d.consultationFee,
    avgConsultMinutes: d.avgConsultMinutes,
    qrToken: d.qrToken,
    isActive: d.isActive,
    login: d.user ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function toLeaveDto(l: {
  id: string;
  startDate: Date;
  endDate: Date;
  reason: string | null;
  createdAt: Date;
}) {
  return {
    id: l.id,
    startDate: toLocalDate(l.startDate),
    endDate: toLocalDate(l.endDate),
    reason: l.reason,
    createdAt: l.createdAt,
  };
}
