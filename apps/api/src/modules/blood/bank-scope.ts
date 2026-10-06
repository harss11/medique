import type { Request } from "express";
import type { BloodBank } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, type AuthContext } from "../../middleware/authenticate.js";
import type { AuditActor } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";

export interface BankScope {
  auth: AuthContext;
  bloodBankId: string;
  actor: AuditActor;
  bank: BloodBank;
}

/**
 * Ownership for the blood bank panel: the bank always comes from the signed-in staff member,
 * never from the URL or the body. Anything that records donations, stock or answers requests
 * needs `active: true`: a bank that has not been verified (or was rejected) cannot operate.
 */
export async function bankScope(req: Request, opts: { active?: boolean } = {}): Promise<BankScope> {
  const auth = requireAuth(req);
  if (!auth.bloodBankId) throw AppError.forbidden();
  const bank = await prisma.bloodBank.findUnique({ where: { id: auth.bloodBankId } });
  if (!bank) throw AppError.forbidden();
  if (opts.active && bank.status !== "ACTIVE") {
    throw AppError.forbidden(
      bank.status === "REJECTED"
        ? `MediQ could not verify your blood bank: ${bank.rejectedReason ?? "see your profile"}. Fix the details and resubmit.`
        : "Your blood bank is waiting for MediQ to verify its licence. You can do this once it is approved.",
      "BANK_NOT_VERIFIED",
    );
  }
  return { auth, bloodBankId: bank.id, actor: { userId: auth.userId, role: auth.role }, bank };
}
