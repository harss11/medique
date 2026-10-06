import type { BloodGroup } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import type { RequestMeta } from "../../utils/request.js";
import type { BankScope } from "./bank-scope.js";
import { stockSummary } from "./bank.dto.js";

export async function getStock(bloodBankId: string) {
  return stockSummary(await prisma.bloodStock.findMany({ where: { bloodBankId } }));
}

/** Sets the units for the groups given (others are left as they are). Audited with before and after. */
export async function setStock(
  scope: BankScope,
  items: Array<{ bloodGroup: BloodGroup; units: number }>,
  meta: RequestMeta,
) {
  await prisma.$transaction(async (tx) => {
    const before = await tx.bloodStock.findMany({ where: { bloodBankId: scope.bloodBankId } });
    for (const item of items) {
      await tx.bloodStock.upsert({
        where: {
          bloodBankId_bloodGroup: { bloodBankId: scope.bloodBankId, bloodGroup: item.bloodGroup },
        },
        update: { units: item.units, updatedById: scope.actor.userId },
        create: {
          bloodBankId: scope.bloodBankId,
          bloodGroup: item.bloodGroup,
          units: item.units,
          updatedById: scope.actor.userId,
        },
      });
    }
    const was = Object.fromEntries(before.map((b) => [b.bloodGroup, b.units]));
    await audit(tx, {
      actor: scope.actor,
      action: "blood_stock.updated",
      entityType: "BloodBank",
      entityId: scope.bloodBankId,
      before: Object.fromEntries(items.map((i) => [i.bloodGroup, was[i.bloodGroup] ?? 0])),
      after: Object.fromEntries(items.map((i) => [i.bloodGroup, i.units])),
      meta,
    });
  });
  return getStock(scope.bloodBankId);
}
