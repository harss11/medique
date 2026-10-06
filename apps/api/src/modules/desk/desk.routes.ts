import { Router } from "express";
import { assertFeature } from "../subscriptions/subscription.service.js";
import { z } from "zod";
import type { AppointmentStatus, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { audit } from "../../utils/audit.js";
import { idParams, localDate, nullableText } from "../../utils/fields.js";
import { AppError, ok, sendPdf } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { normalizeMobile } from "../../utils/phone.js";
import { requestMeta } from "../../utils/request.js";
import { addDays, dateOnly, todayInZone, zonedTimeToUtc } from "../../utils/time.js";
import { parse } from "../../utils/validate.js";
import { queueSnapshot } from "../queue/queue.service.js";
import { parseStoredFields } from "../slips/slip-fields.js";
import { slipAppointmentInclude, slipValuesFor } from "../slips/slip-data.js";
import { renderSlips } from "../slips/slip-render.js";
import {
  checkIn,
  checkInByCode,
  completeConsultation,
  getStaffAppointment,
  markNoShow,
  recordCash,
  staffCancel,
  startConsultation,
} from "./desk-actions.service.js";
import {
  DESK_ROLES,
  assertDoctorAllowed,
  deskScope,
  requireFrontDesk,
  type DeskScope,
} from "./desk-scope.js";
import { staffAppointmentInclude, toStaffAppointmentDto } from "./desk.dto.js";
import { bookWalkIn } from "./walkin.service.js";

/**
 * /desk: the front desk and the consulting room. Open to receptionists, hospital admins and
 * doctors of ONE hospital; a doctor is further limited to their own patients.
 */
export const deskRouter = Router();

deskRouter.use(authenticate(), requireRole(...DESK_ROLES));

async function hospitalZone(hospitalId: string): Promise<string> {
  const h = await prisma.hospital.findUniqueOrThrow({
    where: { id: hospitalId },
    select: { timezone: true },
  });
  return h.timezone;
}

/** The doctor must belong to this hospital (and, for a doctor login, be themselves). */
async function ownedDoctor(scope: DeskScope, doctorId: string) {
  assertDoctorAllowed(scope, doctorId);
  const doctor = await prisma.doctor.findFirst({
    where: { id: doctorId, hospitalId: scope.hospitalId },
    select: { id: true, name: true, avgConsultMinutes: true, consultationFee: true },
  });
  if (!doctor) throw AppError.notFound("Doctor not found");
  return doctor;
}

// ---------------------------------------------------------------------------
// Doctors and the day's list
// ---------------------------------------------------------------------------

deskRouter.get("/doctors", async (req, res) => {
  const scope = await deskScope(req);
  const doctors = await prisma.doctor.findMany({
    where: {
      hospitalId: scope.hospitalId,
      isActive: true,
      ...(scope.doctorId ? { id: scope.doctorId } : {}),
    },
    orderBy: { name: "asc" },
    take: 200,
    select: {
      id: true,
      name: true,
      specialization: true,
      consultationFee: true,
      avgConsultMinutes: true,
      department: { select: { id: true, name: true } },
    },
  });
  ok(res, { items: doctors, timezone: await hospitalZone(scope.hospitalId) });
});

export const dayQuery = paginationQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  date: localDate.optional(),
  doctorId: z.uuid().optional(),
  status: z.enum(["all", "active", "done", "cancelled"]).default("all"),
  search: z.string().trim().max(100).optional(),
});

const STATUS_GROUPS: Record<z.infer<typeof dayQuery>["status"], AppointmentStatus[]> = {
  // The people who matter today: booked, here, with the doctor, seen, or absent.
  all: ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW"],
  active: ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"],
  done: ["COMPLETED", "NO_SHOW"],
  cancelled: ["CANCELLED"],
};

/** A day's appointments in token order, with counts and (for one doctor) the live queue. */
deskRouter.get("/appointments", async (req, res) => {
  const scope = await deskScope(req);
  const q = parse(dayQuery, req.query);
  const tz = await hospitalZone(scope.hospitalId);
  const date = q.date ?? todayInZone(tz);
  // Asking for someone else's doctor is a 404 for a doctor login (ownedDoctor); with none asked, a doctor gets their own.
  const doctorId = q.doctorId ?? scope.doctorId ?? undefined;
  if (doctorId) await ownedDoctor(scope, doctorId);

  const base: Prisma.AppointmentWhereInput = {
    hospitalId: scope.hospitalId,
    appointmentDate: dateOnly(date),
    ...(doctorId ? { doctorId } : {}),
  };
  const search = q.search;
  const searchFilter: Prisma.AppointmentWhereInput = search
    ? /^\d{1,5}$/.test(search)
      ? { tokenNumber: Number(search) }
      : {
          patientProfile: {
            OR: [
              { fullName: { contains: search, mode: "insensitive" } },
              ...(/\d{4,}/.test(search)
                ? [{ phone: { contains: search.replace(/\D/g, "") } }]
                : []),
            ],
          },
        }
    : {};
  const where: Prisma.AppointmentWhereInput = {
    ...base,
    ...searchFilter,
    status: { in: STATUS_GROUPS[q.status] },
  };

  const [rows, total, grouped] = await prisma.$transaction([
    prisma.appointment.findMany({
      where,
      orderBy: [{ doctor: { name: "asc" } }, { tokenNumber: "asc" }, { slotStart: "asc" }],
      ...toSkipTake(q),
      include: staffAppointmentInclude,
    }),
    prisma.appointment.count({ where }),
    prisma.appointment.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
  ]);

  const count = (s: AppointmentStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const doctor = doctorId ? await ownedDoctor(scope, doctorId) : null;
  ok(res, {
    date,
    timezone: tz,
    summary: {
      booked: count("CONFIRMED"),
      waiting: count("CHECKED_IN"),
      inProgress: count("IN_PROGRESS"),
      completed: count("COMPLETED"),
      noShow: count("NO_SHOW"),
      cancelled: count("CANCELLED"),
    },
    queue: doctor ? await queueSnapshot(doctor.id, date, doctor.avgConsultMinutes) : null,
    ...paginate(
      rows.map((r) => toStaffAppointmentDto(r)),
      total,
      q,
    ),
  });
});

// ---------------------------------------------------------------------------
// Walk-in booking
// ---------------------------------------------------------------------------

export const slotsQuery = z.object({ doctorId: z.uuid(), date: localDate.optional() });

/** Slots a receptionist can book now: today's current and future slots, or any later day. */
deskRouter.get("/slots", async (req, res) => {
  const scope = await deskScope(req);
  requireFrontDesk(scope);
  const q = parse(slotsQuery, req.query);
  const doctor = await ownedDoctor(scope, q.doctorId);
  const tz = await hospitalZone(scope.hospitalId);
  const date = q.date ?? todayInZone(tz);
  const now = new Date();

  const rows = await prisma.slot.findMany({
    where: {
      doctorId: doctor.id,
      status: "OPEN",
      startAt: { gte: zonedTimeToUtc(date, 0, tz), lt: zonedTimeToUtc(addDays(date, 1), 0, tz) },
      endAt: { gt: now },
    },
    orderBy: { startAt: "asc" },
    select: { id: true, startAt: true, endAt: true, capacity: true, bookedCount: true },
  });
  ok(res, {
    timezone: tz,
    date,
    doctor: { id: doctor.id, name: doctor.name, consultationFee: doctor.consultationFee },
    items: rows.map((s) => {
      const remaining = Math.max(0, s.capacity - s.bookedCount);
      return { id: s.id, startAt: s.startAt, endAt: s.endAt, remaining, available: remaining > 0 };
    }),
  });
});

export const patientSchema = z.object({
  fullName: z.string().trim().min(2, "Enter the patient's name").max(100),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const phone = normalizeMobile(v);
      if (!phone) {
        ctx.addIssue({ code: "custom", message: "Enter a valid mobile number" });
        return z.NEVER;
      }
      return phone;
    }),
  ageYears: z.number().int().min(0).max(120).nullable().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).nullable().optional(),
});

export const walkInSchema = z.object({
  slotId: z.uuid("Choose a slot"),
  patient: patientSchema,
  reasonForVisit: nullableText(300),
  payment: z.enum(["CASH", "PAY_LATER"]).default("CASH"),
  checkIn: z.boolean().default(true),
  sendSms: z.boolean().default(true),
});

deskRouter.post("/appointments", async (req, res) => {
  const scope = await deskScope(req);
  requireFrontDesk(scope);
  const body = parse(walkInSchema, req.body);
  const id = await bookWalkIn(
    scope,
    {
      slotId: body.slotId,
      patient: {
        fullName: body.patient.fullName,
        phone: body.patient.phone,
        ageYears: body.patient.ageYears ?? null,
        gender: body.patient.gender ?? null,
      },
      reasonForVisit: body.reasonForVisit ?? null,
      payment: body.payment,
      checkIn: body.checkIn,
      sendSms: body.sendSms,
    },
    requestMeta(req),
  );
  ok(res, await getStaffAppointment(scope, id), 201);
});

// ---------------------------------------------------------------------------
// Arrival, consultation and money
// ---------------------------------------------------------------------------

deskRouter.post("/check-in", async (req, res) => {
  const scope = await deskScope(req);
  const { code } = parse(z.object({ code: z.string().trim().min(4).max(30) }), req.body);
  ok(res, await checkInByCode(scope, code, requestMeta(req)));
});

deskRouter.get("/appointments/:id", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  ok(res, await getStaffAppointment(scope, id));
});

deskRouter.post("/appointments/:id/check-in", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  ok(res, await checkIn(scope, id, requestMeta(req)));
});

deskRouter.post("/appointments/:id/start", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  const { completeCurrent } = parse(
    z.object({ completeCurrent: z.boolean().default(false) }),
    req.body ?? {},
  );
  ok(res, await startConsultation(scope, id, completeCurrent, requestMeta(req)));
});

deskRouter.post("/appointments/:id/complete", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  ok(res, await completeConsultation(scope, id, requestMeta(req)));
});

deskRouter.post("/appointments/:id/no-show", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  ok(res, await markNoShow(scope, id, requestMeta(req)));
});

deskRouter.post("/appointments/:id/cash", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  ok(res, await recordCash(scope, id, requestMeta(req)));
});

export const cancelSchema = z.object({
  /** PATIENT_REQUEST follows the hospital's refund policy; HOSPITAL (e.g. doctor unavailable) refunds in full. */
  initiator: z.enum(["PATIENT_REQUEST", "HOSPITAL"]).default("PATIENT_REQUEST"),
  reason: nullableText(300),
});

deskRouter.post("/appointments/:id/cancel", async (req, res) => {
  const scope = await deskScope(req);
  const { id } = parse(idParams, req.params);
  const body = parse(cancelSchema, req.body ?? {});
  ok(
    res,
    await staffCancel(
      scope,
      id,
      { initiator: body.initiator, reason: body.reason ?? null },
      requestMeta(req),
    ),
  );
});

// ---------------------------------------------------------------------------
// Doctor slips (PDF, data only, for pre-printed paper)
// ---------------------------------------------------------------------------

async function slipTemplateFor(hospitalId: string, templateId: string | undefined) {
  const template = templateId
    ? await prisma.slipTemplate.findFirst({ where: { id: templateId, hospitalId } })
    : await prisma.slipTemplate.findFirst({
        where: { hospitalId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
  if (!template) {
    throw AppError.conflict(
      templateId
        ? "Slip template not found"
        : "No slip template is set up yet. Ask the hospital admin to create one.",
      templateId ? "TEMPLATE_NOT_FOUND" : "NO_SLIP_TEMPLATE",
    );
  }
  return { ...template, fields: parseStoredFields(template.fields) };
}

deskRouter.get("/slip-templates", async (req, res) => {
  const scope = await deskScope(req);
  const rows = await prisma.slipTemplate.findMany({
    where: { hospitalId: scope.hospitalId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, paperWidthMm: true, paperHeightMm: true, isDefault: true },
    take: 20,
  });
  ok(res, { items: rows });
});

const PRINTABLE: AppointmentStatus[] = [
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "NO_SHOW",
];
const MAX_SLIPS = 300;

deskRouter.get("/appointments/:id/slip", async (req, res) => {
  const scope = await deskScope(req);
  await assertFeature(prisma, scope.hospitalId, "slipPrinting");
  const { id } = parse(idParams, req.params);
  const { templateId } = parse(z.object({ templateId: z.uuid().optional() }), req.query);
  const appt = await prisma.appointment.findFirst({
    where: {
      id,
      hospitalId: scope.hospitalId,
      status: { in: PRINTABLE },
      ...(scope.doctorId ? { doctorId: scope.doctorId } : {}),
    },
    include: slipAppointmentInclude,
  });
  if (!appt) throw AppError.notFound("Appointment not found");
  const template = await slipTemplateFor(scope.hospitalId, templateId);
  const bytes = await renderSlips(template, [slipValuesFor(appt)]);
  await audit(prisma, {
    actor: scope.actor,
    action: "slip.printed",
    entityType: "Appointment",
    entityId: id,
    hospitalId: scope.hospitalId,
    metadata: { count: 1, templateId: template.id },
    meta: requestMeta(req),
  });
  sendPdf(res, `slip-token-${appt.tokenNumber ?? "x"}.pdf`, bytes);
});

export const bulkSlipSchema = z.object({
  appointmentIds: z.array(z.uuid()).min(1).max(MAX_SLIPS).optional(),
  doctorId: z.uuid().optional(),
  date: localDate.optional(),
  templateId: z.uuid().optional(),
  /** Also print patients already seen (a reprint of the whole day). */
  includeCompleted: z.boolean().default(false),
});

/** One PDF with a page per appointment: chosen appointments, or everything booked for a day. */
deskRouter.post("/slips", async (req, res) => {
  const scope = await deskScope(req);
  await assertFeature(prisma, scope.hospitalId, "slipPrinting");
  const body = parse(bulkSlipSchema, req.body);
  const tz = await hospitalZone(scope.hospitalId);
  const date = body.date ?? todayInZone(tz);
  const doctorId = body.doctorId ?? scope.doctorId ?? undefined;
  if (doctorId) await ownedDoctor(scope, doctorId);

  const statuses: AppointmentStatus[] = body.includeCompleted
    ? PRINTABLE
    : ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];
  const rows = await prisma.appointment.findMany({
    where: body.appointmentIds
      ? {
          id: { in: body.appointmentIds },
          hospitalId: scope.hospitalId,
          status: { in: PRINTABLE },
          ...(doctorId ? { doctorId } : {}),
        }
      : {
          hospitalId: scope.hospitalId,
          appointmentDate: dateOnly(date),
          status: { in: statuses },
          ...(doctorId ? { doctorId } : {}),
        },
    orderBy: [{ doctor: { name: "asc" } }, { tokenNumber: "asc" }],
    take: MAX_SLIPS + 1,
    include: slipAppointmentInclude,
  });
  if (rows.length === 0)
    throw AppError.notFound("There are no appointments to print", "NOTHING_TO_PRINT");
  if (rows.length > MAX_SLIPS) {
    throw AppError.badRequest(
      `Too many slips for one print job (more than ${MAX_SLIPS}). Pick one doctor.`,
      "TOO_MANY_SLIPS",
    );
  }

  const template = await slipTemplateFor(scope.hospitalId, body.templateId);
  const bytes = await renderSlips(
    template,
    rows.map((r) => slipValuesFor(r)),
  );
  await audit(prisma, {
    actor: scope.actor,
    action: "slip.printed",
    entityType: "Hospital",
    entityId: scope.hospitalId,
    hospitalId: scope.hospitalId,
    metadata: {
      count: rows.length,
      templateId: template.id,
      date,
      doctorId: doctorId ?? null,
      bulk: true,
    },
    meta: requestMeta(req),
  });
  sendPdf(res, `slips-${date}.pdf`, bytes);
});
