import { Router } from "express";
import { z } from "zod";
import type { PatientProfile } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { audit } from "../../utils/audit.js";
import { idParams, localDate, nullablePhone } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { dateOnly, todayInZone, toLocalDate } from "../../utils/time.js";
import { parse } from "../../utils/validate.js";

/**
 * /patient/profiles — the people a patient books for (themselves and family).
 * Only name, relation and optional date of birth, gender and phone are collected:
 * nothing else is needed to book an appointment.
 */
export const profilesRouter = Router();

profilesRouter.use(authenticate(), requireRole("PATIENT"));

const MAX_PROFILES = 10;

const fields = {
  fullName: z.string().trim().min(2, "Enter the full name").max(100),
  relation: z.enum(["SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"]),
  dateOfBirth: z
    .union([z.literal(""), localDate])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .refine((v) => !v || v <= todayInZone("Asia/Kolkata"), "Date of birth cannot be in the future"),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).nullable().optional(),
  phone: nullablePhone,
};

export const createSchema = z.object(fields);
/** The SELF profile's relation never changes. */
export const updateSchema = z.object(fields).partial();

function toDto(p: PatientProfile) {
  return {
    id: p.id,
    relation: p.relation,
    fullName: p.fullName,
    dateOfBirth: p.dateOfBirth ? toLocalDate(p.dateOfBirth) : null,
    gender: p.gender,
    phone: p.phone,
  };
}

async function getOwned(userId: string, id: string) {
  const profile = await prisma.patientProfile.findFirst({ where: { id, userId, deletedAt: null } });
  if (!profile) throw AppError.notFound("Profile not found");
  return profile;
}

function toData(body: z.output<typeof updateSchema>) {
  const { dateOfBirth, ...rest } = body;
  return {
    ...rest,
    ...(dateOfBirth !== undefined
      ? { dateOfBirth: dateOfBirth ? dateOnly(dateOfBirth) : null }
      : {}),
  };
}

profilesRouter.get("/", async (req, res) => {
  const { userId } = requireAuth(req);
  const rows = await prisma.patientProfile.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ relation: "asc" }, { createdAt: "asc" }],
    take: MAX_PROFILES + 5,
  });
  // SELF first, then family in the order they were added.
  rows.sort((a, b) => Number(b.relation === "SELF") - Number(a.relation === "SELF"));
  ok(res, { items: rows.map(toDto) });
});

profilesRouter.post("/", async (req, res) => {
  const auth = requireAuth(req);
  const body = parse(createSchema, req.body);
  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.patientProfile.count({
      where: { userId: auth.userId, deletedAt: null },
    });
    if (count >= MAX_PROFILES) {
      throw AppError.conflict(`You can add up to ${MAX_PROFILES} people`, "PROFILE_LIMIT");
    }
    const profile = await tx.patientProfile.create({
      data: {
        ...toData(body),
        fullName: body.fullName,
        relation: body.relation,
        userId: auth.userId,
      },
    });
    await audit(tx, {
      actor: { userId: auth.userId, role: auth.role },
      action: "profile.created",
      entityType: "PatientProfile",
      entityId: profile.id,
      metadata: { relation: profile.relation },
      meta: requestMeta(req),
    });
    return profile;
  });
  ok(res, toDto(created), 201);
});

profilesRouter.patch("/:id", async (req, res) => {
  const auth = requireAuth(req);
  const { id } = parse(idParams, req.params);
  const { relation, ...body } = parse(updateSchema, req.body);
  const before = await getOwned(auth.userId, id);
  if (relation && before.relation === "SELF") {
    throw AppError.badRequest("Your own profile's relation cannot change", "SELF_PROFILE");
  }
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.patientProfile.update({
      where: { id },
      data: { ...toData(body), ...(relation ? { relation } : {}) },
    });
    await audit(tx, {
      actor: { userId: auth.userId, role: auth.role },
      action: "profile.updated",
      entityType: "PatientProfile",
      entityId: id,
      meta: requestMeta(req),
    });
    return updated;
  });
  ok(res, toDto(after));
});

/** Soft delete: past appointments keep their patient details. */
profilesRouter.delete("/:id", async (req, res) => {
  const auth = requireAuth(req);
  const { id } = parse(idParams, req.params);
  const profile = await getOwned(auth.userId, id);
  if (profile.relation === "SELF") {
    throw AppError.badRequest("You can't remove your own profile", "SELF_PROFILE");
  }
  const upcoming = await prisma.appointment.count({
    where: {
      patientProfileId: id,
      seatNumber: { not: null },
      slotEnd: { gt: new Date() },
      OR: [{ status: { not: "PENDING_PAYMENT" } }, { holdExpiresAt: { gt: new Date() } }],
    },
  });
  if (upcoming > 0) {
    throw AppError.conflict("Cancel this person's upcoming appointments first", "PROFILE_IN_USE");
  }
  await prisma.$transaction(async (tx) => {
    await tx.patientProfile.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit(tx, {
      actor: { userId: auth.userId, role: auth.role },
      action: "profile.deleted",
      entityType: "PatientProfile",
      entityId: id,
      meta: requestMeta(req),
    });
  });
  ok(res, null);
});
