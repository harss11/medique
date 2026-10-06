import { Router } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { requireImage, singleImage } from "../../middleware/upload.js";
import { deleteFileQuietly, storage } from "../../services/storage/index.js";
import { audit } from "../../utils/audit.js";
import { randomToken } from "../../utils/crypto.js";
import { idParams } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { dateOnly, todayInZone, addDays, zonedTimeToUtc } from "../../utils/time.js";
import { parse } from "../../utils/validate.js";
import { advisoryLock } from "../appointments/booking.service.js";
import { hospitalScope } from "../hospitals/scope.js";
import { syncDoctorSlots } from "../slots/slots.service.js";
import { createStaffAccount, loginPrefix } from "../staff/staff.service.js";
import { assertCanAddDoctor, assertCanAddStaff } from "../subscriptions/subscription.service.js";
import {
  createDoctorLoginSchema,
  createDoctorSchema,
  createLeaveSchema,
  listDoctorsQuery,
  listLeavesQuery,
  listSlotsQuery,
  scheduleSchema,
  toDoctorDto,
  toLeaveDto,
  toScheduleDto,
  updateDoctorSchema,
  updateSlotSchema,
} from "./doctors.schemas.js";

/**
 * Hospital panel: doctors, their photo, optional login, weekly schedule,
 * leaves and generated slots. Mounted at /hospital.
 */
export const doctorsRouter = Router();

const doctorInclude = {
  department: { select: { id: true, name: true } },
  user: { select: { id: true, loginId: true, status: true, mustChangePassword: true } },
} satisfies Prisma.DoctorInclude;

async function getOwnedDoctor(hospitalId: string, id: string) {
  const doctor = await prisma.doctor.findFirst({
    where: { id, hospitalId },
    include: doctorInclude,
  });
  if (!doctor) throw AppError.notFound("Doctor not found");
  return doctor;
}

async function assertOwnDepartment(hospitalId: string, departmentId: string) {
  const exists = await prisma.department.count({ where: { id: departmentId, hospitalId } });
  if (!exists)
    throw AppError.badRequest("Choose a department of your hospital", "INVALID_DEPARTMENT");
}

async function hospitalTimezone(hospitalId: string) {
  const h = await prisma.hospital.findUniqueOrThrow({
    where: { id: hospitalId },
    select: { timezone: true },
  });
  return h.timezone;
}

// ---------------------------------------------------------------------------
// Doctors
// ---------------------------------------------------------------------------

doctorsRouter.get("/doctors", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const q = parse(listDoctorsQuery, req.query);
  const where: Prisma.DoctorWhereInput = {
    hospitalId,
    departmentId: q.departmentId,
    isActive: q.active,
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { specialization: { contains: q.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.doctor.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      ...toSkipTake(q),
      include: doctorInclude,
    }),
    prisma.doctor.count({ where }),
  ]);
  ok(res, paginate(rows.map(toDoctorDto), total, q));
});

doctorsRouter.post("/doctors", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const body = parse(createDoctorSchema, req.body);
  await assertOwnDepartment(hospitalId, body.departmentId);
  const doctor = await prisma.$transaction(async (tx) => {
    // The plan's doctor limit, checked while nobody else adds one at the same moment.
    await advisoryLock(tx, `hospital-doctors:${hospitalId}`);
    await assertCanAddDoctor(tx, hospitalId);
    const created = await tx.doctor.create({
      data: { ...body, hospitalId, qrToken: randomToken(16) },
      include: doctorInclude,
    });
    await audit(tx, {
      actor,
      action: "doctor.created",
      entityType: "Doctor",
      entityId: created.id,
      hospitalId,
      after: toDoctorDto(created),
      meta: requestMeta(req),
    });
    return created;
  });
  ok(res, toDoctorDto(doctor), 201);
});

doctorsRouter.get("/doctors/:id", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const doctor = await getOwnedDoctor(hospitalId, id);
  const schedules = await prisma.doctorSchedule.findMany({
    where: { doctorId: id, isActive: true },
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
  });
  ok(res, { ...toDoctorDto(doctor), schedules: schedules.map(toScheduleDto) });
});

doctorsRouter.patch("/doctors/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const body = parse(updateDoctorSchema, req.body);
  const before = await getOwnedDoctor(hospitalId, id);
  if (body.departmentId) await assertOwnDepartment(hospitalId, body.departmentId);

  const after = await prisma.$transaction(async (tx) => {
    if (body.isActive === true && !before.isActive) {
      await advisoryLock(tx, `hospital-doctors:${hospitalId}`);
      await assertCanAddDoctor(tx, hospitalId);
    }
    const updated = await tx.doctor.update({ where: { id }, data: body, include: doctorInclude });
    await audit(tx, {
      actor,
      action: "doctor.updated",
      entityType: "Doctor",
      entityId: id,
      hospitalId,
      before: toDoctorDto(before),
      after: toDoctorDto(updated),
      meta: requestMeta(req),
    });
    return updated;
  });

  // Deactivating removes future unbooked slots; reactivating recreates them.
  const slotSync =
    body.isActive !== undefined && body.isActive !== before.isActive
      ? await syncDoctorSlots(id)
      : undefined;
  ok(res, { ...toDoctorDto(after), slotSync });
});

/** Deletes a doctor who never had appointments; otherwise deactivate instead. */
doctorsRouter.delete("/doctors/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const before = await getOwnedDoctor(hospitalId, id);
  if ((await prisma.appointment.count({ where: { doctorId: id } })) > 0) {
    throw AppError.conflict(
      "This doctor has appointments. Deactivate the doctor instead.",
      "DOCTOR_HAS_APPOINTMENTS",
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.doctor.delete({ where: { id } });
    if (before.userId) {
      // The doctor's login can no longer be used.
      await tx.user.update({
        where: { id: before.userId },
        data: { status: "BLOCKED", tokenVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({
        where: { userId: before.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit(tx, {
      actor,
      action: "doctor.deleted",
      entityType: "Doctor",
      entityId: id,
      hospitalId,
      before: toDoctorDto(before),
      meta: requestMeta(req),
    });
  });
  await deleteFileQuietly(before.photoKey);
  ok(res, null);
});

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

doctorsRouter.post("/doctors/:id/photo", singleImage("photo"), async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const before = await getOwnedDoctor(hospitalId, id);
  const image = requireImage(req);

  const stored = await storage.uploadImage(image, {
    folder: `hospitals/${hospitalId}/doctors`,
    avatar: true,
  });
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.doctor.update({
      where: { id },
      data: { photoUrl: stored.url, photoKey: stored.key },
      include: doctorInclude,
    });
    await audit(tx, {
      actor,
      action: "doctor.photo_updated",
      entityType: "Doctor",
      entityId: id,
      hospitalId,
      before: { photoUrl: before.photoUrl },
      after: { photoUrl: updated.photoUrl },
      meta: requestMeta(req),
    });
    return updated;
  });
  await deleteFileQuietly(before.photoKey);
  ok(res, toDoctorDto(after));
});

doctorsRouter.delete("/doctors/:id/photo", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const before = await getOwnedDoctor(hospitalId, id);
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.doctor.update({
      where: { id },
      data: { photoUrl: null, photoKey: null },
      include: doctorInclude,
    });
    await audit(tx, {
      actor,
      action: "doctor.photo_removed",
      entityType: "Doctor",
      entityId: id,
      hospitalId,
      before: { photoUrl: before.photoUrl },
      meta: requestMeta(req),
    });
    return updated;
  });
  await deleteFileQuietly(before.photoKey);
  ok(res, toDoctorDto(after));
});

// ---------------------------------------------------------------------------
// Optional doctor login
// ---------------------------------------------------------------------------

/** Creates a DOCTOR login for this doctor. Credentials are returned once. */
doctorsRouter.post("/doctors/:id/login", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const { loginId } = parse(createDoctorLoginSchema, req.body ?? {});
  const doctor = await getOwnedDoctor(hospitalId, id);
  if (doctor.userId) throw AppError.conflict("This doctor already has a login", "LOGIN_EXISTS");

  const hospital = await prisma.hospital.findUniqueOrThrow({
    where: { id: hospitalId },
    select: { slug: true },
  });
  const firstName = doctor.name.replace(/^dr\.?\s+/i, "").split(/\s+/)[0] ?? "doctor";

  const result = await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `hospital-staff:${hospitalId}`);
    await assertCanAddStaff(tx, hospitalId);
    const { user, credentials } = await createStaffAccount(tx, {
      role: "DOCTOR",
      hospitalId,
      name: doctor.name,
      loginId,
      loginIdBase: `${loginPrefix(hospital.slug)}.dr.${firstName}`,
      createdById: actor.userId,
    });
    await tx.doctor.update({ where: { id }, data: { userId: user.id } });
    await audit(tx, {
      actor,
      action: "credentials.issued",
      entityType: "User",
      entityId: user.id,
      hospitalId,
      metadata: { loginId: credentials.loginId, role: "DOCTOR", doctorId: id },
      meta: requestMeta(req),
    });
    return { user, credentials };
  });
  ok(res, result, 201);
});

// ---------------------------------------------------------------------------
// Weekly schedule
// ---------------------------------------------------------------------------

/** Replaces the weekly schedule and regenerates future slots. */
doctorsRouter.put("/doctors/:id/schedules", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const { sessions } = parse(scheduleSchema, req.body);
  await getOwnedDoctor(hospitalId, id);

  const schedules = await prisma.$transaction(async (tx) => {
    const before = await tx.doctorSchedule.findMany({ where: { doctorId: id } });
    await tx.doctorSchedule.deleteMany({ where: { doctorId: id } });
    await tx.doctorSchedule.createMany({ data: sessions.map((s) => ({ ...s, doctorId: id })) });
    const after = await tx.doctorSchedule.findMany({
      where: { doctorId: id },
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
    });
    await audit(tx, {
      actor,
      action: "doctor.schedule_updated",
      entityType: "Doctor",
      entityId: id,
      hospitalId,
      before: before.map(toScheduleDto),
      after: after.map(toScheduleDto),
      meta: requestMeta(req),
    });
    return after;
  });

  const slotSync = await syncDoctorSlots(id);
  ok(res, { schedules: schedules.map(toScheduleDto), slotSync });
});

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

doctorsRouter.get("/doctors/:id/leaves", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const q = parse(listLeavesQuery, req.query);
  await getOwnedDoctor(hospitalId, id);
  const today = todayInZone(await hospitalTimezone(hospitalId));
  const where: Prisma.DoctorLeaveWhereInput = {
    doctorId: id,
    ...(q.includePast ? {} : { endDate: { gte: dateOnly(today) } }),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.doctorLeave.findMany({ where, orderBy: { startDate: "asc" }, ...toSkipTake(q) }),
    prisma.doctorLeave.count({ where }),
  ]);
  ok(res, paginate(rows.map(toLeaveDto), total, q));
});

doctorsRouter.post("/doctors/:id/leaves", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const body = parse(createLeaveSchema, req.body);
  await getOwnedDoctor(hospitalId, id);

  const today = todayInZone(await hospitalTimezone(hospitalId));
  if (body.startDate < today) {
    throw AppError.badRequest("Leave cannot start in the past", "LEAVE_IN_PAST");
  }
  if (body.endDate > addDays(body.startDate, 365)) {
    throw AppError.badRequest("A single leave can be at most one year", "LEAVE_TOO_LONG");
  }

  const leave = await prisma.$transaction(async (tx) => {
    const created = await tx.doctorLeave.create({
      data: {
        doctorId: id,
        startDate: dateOnly(body.startDate),
        endDate: dateOnly(body.endDate),
        reason: body.reason ?? null,
        createdById: actor.userId,
      },
    });
    await audit(tx, {
      actor,
      action: "doctor.leave_added",
      entityType: "Doctor",
      entityId: id,
      hospitalId,
      after: toLeaveDto(created),
      meta: requestMeta(req),
    });
    return created;
  });

  const slotSync = await syncDoctorSlots(id);
  ok(res, { leave: toLeaveDto(leave), slotSync }, 201);
});

doctorsRouter.delete("/leaves/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const leave = await prisma.doctorLeave.findFirst({ where: { id, doctor: { hospitalId } } });
  if (!leave) throw AppError.notFound("Leave not found");

  await prisma.$transaction(async (tx) => {
    await tx.doctorLeave.delete({ where: { id } });
    await audit(tx, {
      actor,
      action: "doctor.leave_removed",
      entityType: "Doctor",
      entityId: leave.doctorId,
      hospitalId,
      before: toLeaveDto(leave),
      meta: requestMeta(req),
    });
  });
  const slotSync = await syncDoctorSlots(leave.doctorId);
  ok(res, { slotSync });
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** GET /hospital/doctors/:id/slots?from=YYYY-MM-DD&to=YYYY-MM-DD (default: today) */
doctorsRouter.get("/doctors/:id/slots", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const q = parse(listSlotsQuery, req.query);
  await getOwnedDoctor(hospitalId, id);
  const tz = await hospitalTimezone(hospitalId);
  const from = q.from ?? todayInZone(tz);
  const to = q.to ?? from;

  const where: Prisma.SlotWhereInput = {
    doctorId: id,
    startAt: { gte: zonedTimeToUtc(from, 0, tz), lt: zonedTimeToUtc(addDays(to, 1), 0, tz) },
  };
  const [rows, total] = await prisma.$transaction([
    prisma.slot.findMany({ where, orderBy: { startAt: "asc" }, ...toSkipTake(q) }),
    prisma.slot.count({ where }),
  ]);
  const items = rows.map((s) => ({
    id: s.id,
    date: s.date.toISOString().slice(0, 10),
    startAt: s.startAt,
    endAt: s.endAt,
    capacity: s.capacity,
    bookedCount: s.bookedCount,
    status: s.status,
  }));
  ok(res, paginate(items, total, q));
});

/** Regenerate this doctor's slots now (normally automatic). */
doctorsRouter.post("/doctors/:id/slots/generate", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  await getOwnedDoctor(hospitalId, id);
  ok(res, await syncDoctorSlots(id));
});

/** Block or reopen a single slot. Blocking keeps existing bookings. */
doctorsRouter.patch("/slots/:id", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const { status } = parse(updateSlotSchema, req.body);
  const slot = await prisma.slot.findFirst({ where: { id, hospitalId } });
  if (!slot) throw AppError.notFound("Slot not found");
  if (slot.startAt <= new Date()) {
    throw AppError.badRequest("Past slots cannot be changed", "SLOT_IN_PAST");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const after = await tx.slot.update({ where: { id }, data: { status } });
    await audit(tx, {
      actor,
      action: status === "BLOCKED" ? "slot.blocked" : "slot.reopened",
      entityType: "Slot",
      entityId: id,
      hospitalId,
      metadata: { doctorId: slot.doctorId, startAt: slot.startAt.toISOString() },
      meta: requestMeta(req),
    });
    return after;
  });
  ok(res, updated);
});
