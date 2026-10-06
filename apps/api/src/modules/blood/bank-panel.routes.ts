import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { audit } from "../../utils/audit.js";
import { idParams } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { mount } from "../../utils/mount.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { resetStaffPassword, setStaffStatus, staffUserSelect } from "../staff/staff.service.js";
import { bankScope } from "./bank-scope.js";
import { createBankStaff } from "./bank-staff.service.js";
import { toOwnBankDto } from "./bank.dto.js";
import { createBankStaffSchema, updateBankSchema } from "./bank.schemas.js";
import { bankRequestsRouter } from "./bank-requests.routes.js";
import { donationsRouter, donorLookupRouter } from "./donations.routes.js";
import { updateBloodBank } from "./bank.service.js";
import { bloodGroupSchema } from "./blood-schemas.js";
import { getStock, setStock } from "./stock.service.js";

/**
 * /blood-bank: the blood bank's own panel. The bank always comes from the signed-in staff
 * member (see bank-scope.ts); records of other banks are simply not found.
 */
export const bloodBankRouter = Router();

bloodBankRouter.use(authenticate(), requireRole("BLOOD_BANK_STAFF"));

mount(bloodBankRouter, "/donations", donationsRouter);
mount(bloodBankRouter, "/donors", donorLookupRouter);
mount(bloodBankRouter, "/requests", bankRequestsRouter);

bloodBankRouter.get("/profile", async (req, res) => {
  const { bank } = await bankScope(req);
  ok(res, toOwnBankDto(bank));
});

bloodBankRouter.patch("/profile", async (req, res) => {
  const scope = await bankScope(req);
  const patch = parse(updateBankSchema, req.body);
  ok(res, toOwnBankDto(await updateBloodBank(scope, patch, requestMeta(req))));
});

export const stockSchema = z.object({
  items: z
    .array(z.object({ bloodGroup: bloodGroupSchema, units: z.number().int().min(0).max(9999) }))
    .min(1)
    .max(8)
    .refine(
      (items) => new Set(items.map((i) => i.bloodGroup)).size === items.length,
      "Each blood group once",
    ),
});

bloodBankRouter.get("/stock", async (req, res) => {
  const { bloodBankId } = await bankScope(req);
  ok(res, { items: await getStock(bloodBankId) });
});

bloodBankRouter.put("/stock", async (req, res) => {
  const scope = await bankScope(req, { active: true });
  const { items } = parse(stockSchema, req.body);
  ok(res, { items: await setStock(scope, items, requestMeta(req)) });
});

// ---------------------------------------------------------------------------
// Colleagues at the same blood bank
// ---------------------------------------------------------------------------

async function colleague(bloodBankId: string, id: string) {
  const user = await prisma.user.findFirst({ where: { id, bloodBankId }, select: staffUserSelect });
  if (!user) throw AppError.notFound("Staff member not found");
  return user;
}

bloodBankRouter.get("/staff", async (req, res) => {
  const { bloodBankId } = await bankScope(req);
  const items = await prisma.user.findMany({
    where: { bloodBankId },
    orderBy: { name: "asc" },
    take: 100,
    select: staffUserSelect,
  });
  ok(res, { items });
});

/** Response includes `credentials` (login ID + temporary password) exactly once. */
bloodBankRouter.post("/staff", async (req, res) => {
  const scope = await bankScope(req);
  const body = parse(createBankStaffSchema, req.body);
  const created = await prisma.$transaction(async (tx) => {
    const result = await createBankStaff(tx, scope.bank, {
      ...body,
      createdById: scope.actor.userId,
    });
    await audit(tx, {
      actor: scope.actor,
      action: "blood_bank_staff.created",
      entityType: "User",
      entityId: result.user.id,
      metadata: { bloodBankId: scope.bloodBankId, loginId: result.credentials.loginId },
      meta: requestMeta(req),
    });
    return result;
  });
  ok(res, created, 201);
});

bloodBankRouter.post("/staff/:id/reset-password", async (req, res) => {
  const scope = await bankScope(req);
  const { id } = parse(idParams, req.params);
  await colleague(scope.bloodBankId, id);
  const credentials = await prisma.$transaction(async (tx) => {
    const issued = await resetStaffPassword(tx, id);
    await audit(tx, {
      actor: scope.actor,
      action: "blood_bank_staff.password_reset",
      entityType: "User",
      entityId: id,
      metadata: { bloodBankId: scope.bloodBankId },
      meta: requestMeta(req),
    });
    return issued;
  });
  ok(res, { credentials });
});

for (const [path, blocked] of [
  ["block", true],
  ["unblock", false],
] as const) {
  bloodBankRouter.post(`/staff/:id/${path}`, async (req, res) => {
    const scope = await bankScope(req);
    const { id } = parse(idParams, req.params);
    await colleague(scope.bloodBankId, id);
    if (blocked && id === scope.actor.userId) {
      throw AppError.badRequest("You cannot block your own login", "CANNOT_BLOCK_SELF");
    }
    const user = await prisma.$transaction(async (tx) => {
      const updated = await setStaffStatus(tx, id, blocked);
      await audit(tx, {
        actor: scope.actor,
        action: blocked ? "blood_bank_staff.blocked" : "blood_bank_staff.unblocked",
        entityType: "User",
        entityId: id,
        metadata: { bloodBankId: scope.bloodBankId },
        meta: requestMeta(req),
      });
      return updated;
    });
    ok(res, user);
  });
}
