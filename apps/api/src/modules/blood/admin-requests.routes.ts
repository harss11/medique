import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/authenticate.js";
import { audit } from "../../utils/audit.js";
import { idParams } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { maskPhone } from "../../utils/phone.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { effectiveStatus } from "./request.dto.js";
import { cancelByAdminSchema } from "./request.schemas.js";

/** /admin/blood-requests: oversight of emergency requests (the admin can stop an abusive one). */
export const adminBloodRequestsRouter = Router();

export const listBloodRequestsQuery = paginationQuery.extend({
  status: z.enum(["OPEN", "FULFILLED", "CANCELLED", "EXPIRED"]).optional(),
});

adminBloodRequestsRouter.get("/", async (req, res) => {
  const q = parse(listBloodRequestsQuery, req.query);
  const now = new Date();
  // EXPIRED also covers OPEN requests whose time has run out but the job has not yet marked.
  const where: Prisma.BloodRequestWhereInput =
    q.status === "OPEN"
      ? { status: "OPEN", expiresAt: { gt: now } }
      : q.status === "EXPIRED"
        ? { OR: [{ status: "EXPIRED" }, { status: "OPEN", expiresAt: { lte: now } }] }
        : q.status
          ? { status: q.status }
          : {};
  const [rows, total] = await prisma.$transaction([
    prisma.bloodRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...toSkipTake(q),
      include: { _count: { select: { responses: { where: { response: "CAN_HELP" } } } } },
    }),
    prisma.bloodRequest.count({ where }),
  ]);
  ok(
    res,
    paginate(
      rows.map((r) => ({
        id: r.id,
        bloodGroup: r.bloodGroup,
        unitsNeeded: r.unitsNeeded,
        urgency: r.urgency,
        hospitalName: r.hospitalName,
        city: r.city,
        status: effectiveStatus(r, now),
        requesterName: r.requesterName,
        requesterPhone: maskPhone(r.requesterPhone),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        alertedDonors: r.alertedDonors,
        alertedBanks: r.alertedBanks,
        helpers: r._count.responses,
      })),
      total,
      q,
    ),
  );
});

adminBloodRequestsRouter.post("/:id/cancel", async (req, res) => {
  const auth = requireAuth(req);
  const { id } = parse(idParams, req.params);
  const { reason } = parse(cancelByAdminSchema, req.body);
  await prisma.$transaction(async (tx) => {
    const request = await tx.bloodRequest.findUnique({ where: { id }, select: { status: true } });
    if (!request) throw AppError.notFound("Request not found");
    if (request.status !== "OPEN")
      throw AppError.conflict("This request is already closed", "INVALID_STATUS");
    await tx.bloodRequest.update({
      where: { id },
      data: { status: "CANCELLED", closedAt: new Date() },
    });
    await audit(tx, {
      actor: { userId: auth.userId, role: auth.role },
      action: "blood_request.cancelled_by_admin",
      entityType: "BloodRequest",
      entityId: id,
      metadata: { reason },
      meta: requestMeta(req),
    });
  });
  ok(res, null);
});
