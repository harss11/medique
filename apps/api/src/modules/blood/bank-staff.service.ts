import type { BloodBank, Prisma } from "../../generated/prisma/client.js";
import type { DbClient } from "../../lib/prisma.js";
import { generateTempPassword } from "../../utils/credentials.js";
import { AppError } from "../../utils/http.js";
import { hashPassword } from "../../utils/password.js";
import { revokeAllForUser } from "../auth/tokens.js";
import { staffUserSelect, suggestLoginId, type IssuedCredentials } from "../staff/staff.service.js";

/** A new login for a colleague at the same blood bank. The password is shown once. */
export async function createBankStaff(
  db: DbClient,
  bank: Pick<BloodBank, "id" | "name">,
  input: { name: string; loginId?: string; createdById: string },
) {
  let loginId: string;
  if (input.loginId) {
    if ((await db.user.count({ where: { loginId: input.loginId } })) > 0) {
      throw AppError.conflict("That login ID is already taken", "LOGIN_ID_TAKEN");
    }
    loginId = input.loginId;
  } else {
    const words = bank.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ");
    loginId = await suggestLoginId(db, (words[0] || "bloodbank") + ".staff");
  }
  const temporaryPassword = generateTempPassword();
  const user = await db.user.create({
    data: {
      role: "BLOOD_BANK_STAFF",
      bloodBankId: bank.id,
      name: input.name,
      loginId,
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      createdById: input.createdById,
    },
    select: staffUserSelect,
  });
  const credentials: IssuedCredentials = { loginId, temporaryPassword };
  return { user, credentials };
}

/** Ends every session of a bank's staff (used when a bank is blocked). */
export async function endStaffSessions(tx: Prisma.TransactionClient, bloodBankId: string) {
  const staff = await tx.user.findMany({ where: { bloodBankId }, select: { id: true } });
  await tx.user.updateMany({ where: { bloodBankId }, data: { tokenVersion: { increment: 1 } } });
  for (const s of staff) await revokeAllForUser(tx, s.id);
}
