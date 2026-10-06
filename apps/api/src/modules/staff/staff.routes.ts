import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { loginIdSchema } from "../../utils/credentials.js";
import { idParams, nullableEmail, nullablePhone } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { advisoryLock } from "../appointments/booking.service.js";
import { hospitalScope } from "../hospitals/scope.js";
import { assertCanAddStaff } from "../subscriptions/subscription.service.js";
import {
  createStaffAccount,
  loginPrefix,
  resetStaffPassword,
  setStaffStatus,
  staffUserSelect,
} from "./staff.service.js";

/**
 * /hospital/staff — receptionist (and doctor) logins of the signed-in hospital.
 * Hospital admins cannot manage other hospital-admin accounts here; that's the
 * platform admin's job.
 */
export const staffRouter = Router();

const MANAGED_ROLES = ["RECEPTIONIST", "DOCTOR"] as const;

export const listQuery = paginationQuery.extend({
  role: z.enum(MANAGED_ROLES).optional(),
  search: z.string().trim().max(100).optional(),
});

export const createReceptionistSchema = z.object({
  name: z.string().trim().min(2, "Enter the name").max(100),
  loginId: loginIdSchema.optional(),
  contactPhone: nullablePhone,
  email: nullableEmail,
});

async function getManagedUser(hospitalId: string, id: string) {
  const user = await prisma.user.findFirst({
    where: { id, hospitalId, role: { in: [...MANAGED_ROLES] } },
    select: staffUserSelect,
  });
  if (!user) throw AppError.notFound("Staff member not found");
  return user;
}

staffRouter.get("/", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const q = parse(listQuery, req.query);
  const where: Prisma.UserWhereInput = {
    hospitalId,
    role: q.role ?? { in: [...MANAGED_ROLES] },
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { loginId: { contains: q.search.toLowerCase() } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      orderBy: [{ role: "asc" }, { name: "asc" }],
      ...toSkipTake(q),
      select: staffUserSelect,
    }),
    prisma.user.count({ where }),
  ]);
  ok(res, paginate(items, total, q));
});

/** Response includes `credentials` (login ID + temporary password) exactly once. */
staffRouter.post("/receptionists", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const body = parse(createReceptionistSchema, req.body);
  const hospital = await prisma.hospital.findUniqueOrThrow({
    where: { id: hospitalId },
    select: { slug: true },
  });
  const firstName = body.name.split(/\s+/)[0] ?? "reception";

  const result = await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `hospital-staff:${hospitalId}`);
    await assertCanAddStaff(tx, hospitalId);
    const { user, credentials } = await createStaffAccount(tx, {
      role: "RECEPTIONIST",
      hospitalId,
      name: body.name,
      loginId: body.loginId,
      loginIdBase: `${loginPrefix(hospital.slug)}.${firstName}`,
      contactPhone: body.contactPhone,
      email: body.email,
      createdById: actor.userId,
    });
    await audit(tx, {
      actor,
      action: "credentials.issued",
      entityType: "User",
      entityId: user.id,
      hospitalId,
      metadata: { loginId: credentials.loginId, role: "RECEPTIONIST" },
      meta: requestMeta(req),
    });
    return { user, credentials };
  });
  ok(res, result, 201);
});

staffRouter.post("/:id/reset-password", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const user = await getManagedUser(hospitalId, id);
  const credentials = await prisma.$transaction(async (tx) => {
    const issued = await resetStaffPassword(tx, id);
    await audit(tx, {
      actor,
      action: "credentials.reset",
      entityType: "User",
      entityId: id,
      hospitalId,
      metadata: { loginId: issued.loginId, role: user.role },
      meta: requestMeta(req),
    });
    return issued;
  });
  ok(res, credentials);
});

for (const [path, blocked] of [
  ["block", true],
  ["unblock", false],
] as const) {
  staffRouter.post(`/:id/${path}`, async (req, res) => {
    const { hospitalId, actor } = hospitalScope(req);
    const { id } = parse(idParams, req.params);
    const before = await getManagedUser(hospitalId, id);
    const after = await prisma.$transaction(async (tx) => {
      if (!blocked && before.status === "BLOCKED") {
        // Switching a login back on uses a place in the plan again.
        await advisoryLock(tx, `hospital-staff:${hospitalId}`);
        await assertCanAddStaff(tx, hospitalId);
      }
      const updated = await setStaffStatus(tx, id, blocked);
      await audit(tx, {
        actor,
        action: blocked ? "staff.blocked" : "staff.unblocked",
        entityType: "User",
        entityId: id,
        hospitalId,
        before: { status: before.status },
        after: { status: updated.status },
        meta: requestMeta(req),
      });
      return updated;
    });
    ok(res, after);
  });
}
