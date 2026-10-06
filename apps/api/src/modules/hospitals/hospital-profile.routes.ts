import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError, ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { toHospitalDto, updateEmergencySchema, updateProfileSchema } from "./hospitals.schemas.js";
import { hospitalScope } from "./scope.js";

/** /hospital/summary, /hospital/profile, /hospital/emergency */
export const hospitalProfileRouter = Router();

hospitalProfileRouter.get("/summary", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const weekAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [hospital, departments, doctors, activeDoctors, receptionists, upcomingSlots] =
    await Promise.all([
      prisma.hospital.findUniqueOrThrow({ where: { id: hospitalId } }),
      prisma.department.count({ where: { hospitalId } }),
      prisma.doctor.count({ where: { hospitalId } }),
      prisma.doctor.count({ where: { hospitalId, isActive: true } }),
      prisma.user.count({ where: { hospitalId, role: "RECEPTIONIST" } }),
      prisma.slot.count({
        where: { hospitalId, status: "OPEN", startAt: { gt: new Date(), lt: weekAhead } },
      }),
    ]);
  ok(res, {
    hospital: toHospitalDto(hospital),
    counts: { departments, doctors, activeDoctors, receptionists, upcomingSlots },
  });
});

hospitalProfileRouter.get("/profile", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  ok(res, toHospitalDto(await prisma.hospital.findUniqueOrThrow({ where: { id: hospitalId } })));
});

/** Contact details and address. Name, URL and commission are admin-controlled. */
hospitalProfileRouter.patch("/profile", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const body = parse(updateProfileSchema, req.body);
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.hospital.findUniqueOrThrow({ where: { id: hospitalId } });
    const after = await tx.hospital.update({ where: { id: hospitalId }, data: body });
    await audit(tx, {
      actor,
      action: "hospital.profile_updated",
      entityType: "Hospital",
      entityId: hospitalId,
      hospitalId,
      before: toHospitalDto(before),
      after: toHospitalDto(after),
      meta: requestMeta(req),
    });
    return toHospitalDto(after);
  });
  ok(res, result);
});

/** Emergency number and live bed availability (shown on the emergency page later). */
hospitalProfileRouter.patch("/emergency", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const body = parse(updateEmergencySchema, req.body);
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.hospital.findUniqueOrThrow({ where: { id: hospitalId } });
    const total = body.totalBeds !== undefined ? body.totalBeds : before.totalBeds;
    const available = body.availableBeds !== undefined ? body.availableBeds : before.availableBeds;
    if (total != null && available != null && available > total) {
      throw AppError.badRequest("Available beds cannot exceed total beds", "INVALID_BEDS");
    }
    const after = await tx.hospital.update({
      where: { id: hospitalId },
      data: { ...body, bedsUpdatedAt: new Date() },
    });
    await audit(tx, {
      actor,
      action: "hospital.emergency_updated",
      entityType: "Hospital",
      entityId: hospitalId,
      hospitalId,
      before: {
        emergencyPhone: before.emergencyPhone,
        totalBeds: before.totalBeds,
        availableBeds: before.availableBeds,
      },
      after: {
        emergencyPhone: after.emergencyPhone,
        totalBeds: after.totalBeds,
        availableBeds: after.availableBeds,
      },
      meta: requestMeta(req),
    });
    return toHospitalDto(after);
  });
  ok(res, result);
});
