import { Router } from "express";
import { z } from "zod";
import type { BloodBankStatus, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/authenticate.js";
import { audit } from "../../utils/audit.js";
import { idParams } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { staffUserSelect } from "../staff/staff.service.js";
import { endStaffSessions } from "./bank-staff.service.js";
import { toOwnBankDto } from "./bank.dto.js";
import { blockBankSchema, rejectBankSchema } from "./bank.schemas.js";

/** /admin/blood-banks: the platform admin checks each blood bank's licence before it is listed. */
export const adminBloodBanksRouter = Router();

export const listBloodBanksQuery = paginationQuery.extend({
  status: z.enum(["PENDING_VERIFICATION", "ACTIVE", "REJECTED", "BLOCKED"]).optional(),
  search: z.string().trim().max(100).optional(),
});

adminBloodBanksRouter.get("/", async (req, res) => {
  const q = parse(listBloodBanksQuery, req.query);
  const where: Prisma.BloodBankWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { city: { contains: q.search, mode: "insensitive" } },
            { licenseNumber: { contains: q.search.toUpperCase() } },
          ],
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.bloodBank.findMany({
      where,
      // Waiting banks first: that is the work to do.
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      ...toSkipTake(q),
    }),
    prisma.bloodBank.count({ where }),
  ]);
  ok(res, paginate(rows.map(toOwnBankDto), total, q));
});

adminBloodBanksRouter.get("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const bank = await prisma.bloodBank.findUnique({
    where: { id },
    include: { verifiedBy: { select: { name: true } } },
  });
  if (!bank) throw AppError.notFound("Blood bank not found");
  const [staff, donations] = await Promise.all([
    prisma.user.findMany({
      where: { bloodBankId: id },
      select: staffUserSelect,
      orderBy: { createdAt: "asc" },
    }),
    prisma.donation.count({ where: { bloodBankId: id, voidedAt: null } }),
  ]);
  ok(res, {
    ...toOwnBankDto(bank),
    verifiedByName: bank.verifiedBy?.name ?? null,
    staff,
    donations,
  });
});

/** The status changes the admin can make, and what each one requires. */
const TRANSITIONS: Record<string, { from: BloodBankStatus[]; to: BloodBankStatus }> = {
  approve: { from: ["PENDING_VERIFICATION"], to: "ACTIVE" },
  reject: { from: ["PENDING_VERIFICATION"], to: "REJECTED" },
  block: { from: ["ACTIVE"], to: "BLOCKED" },
  unblock: { from: ["BLOCKED"], to: "ACTIVE" },
};

const DONE: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  block: "blocked",
  unblock: "unblocked",
};

for (const action of Object.keys(TRANSITIONS)) {
  adminBloodBanksRouter.post(`/:id/${action}`, async (req, res) => {
    const auth = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const rule = TRANSITIONS[action]!;
    const reason =
      action === "reject"
        ? parse(rejectBankSchema, req.body).reason
        : action === "block"
          ? parse(blockBankSchema, req.body).reason
          : null;

    const updated = await prisma.$transaction(async (tx) => {
      const bank = await tx.bloodBank.findUnique({ where: { id } });
      if (!bank) throw AppError.notFound("Blood bank not found");
      if (!rule.from.includes(bank.status)) {
        throw AppError.conflict(
          `A blood bank that is ${bank.status.toLowerCase().replace("_", " ")} cannot be ${DONE[action]}`,
          "INVALID_STATUS",
        );
      }
      const now = new Date();
      const result = await tx.bloodBank.update({
        where: { id },
        data: {
          status: rule.to,
          ...(action === "approve"
            ? { verifiedAt: now, verifiedById: auth.userId, rejectedReason: null }
            : {}),
          ...(action === "reject" ? { rejectedReason: reason } : {}),
          ...(action === "block" ? { blockedAt: now, blockedReason: reason } : {}),
          ...(action === "unblock" ? { blockedAt: null, blockedReason: null } : {}),
        },
      });
      // A blocked bank's staff are signed out at once (and stay out: authenticate checks the bank).
      if (action === "block") await endStaffSessions(tx, id);
      await audit(tx, {
        actor: { userId: auth.userId, role: auth.role },
        action: `blood_bank.${DONE[action]}`,
        entityType: "BloodBank",
        entityId: id,
        before: { status: bank.status },
        after: { status: result.status },
        metadata: reason ? { reason } : undefined,
        meta: requestMeta(req),
      });
      return result;
    });
    ok(res, toOwnBankDto(updated));
  });
}
