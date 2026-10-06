import { prisma } from "../lib/prisma.js";
import { audit } from "../utils/audit.js";
import { generateTempPassword, loginIdSchema } from "../utils/credentials.js";
import { hashPassword } from "../utils/password.js";
import { AppError } from "../utils/http.js";

/**
 * Creates a platform admin login. This is how the first admin exists in production, where
 * the seed refuses to run. The password is random, shown once, and must be changed at first
 * login.
 */
export async function createPlatformAdmin(input: { loginId: string; name: string }) {
  const parsed = loginIdSchema.safeParse(input.loginId);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid login ID");
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Give the admin's full name");
  const loginId = parsed.data;

  if (await prisma.user.findUnique({ where: { loginId }, select: { id: true } })) {
    throw new AppError(409, "LOGIN_ID_TAKEN", `The login ID "${loginId}" is already in use`);
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { role: "ADMIN", name, loginId, passwordHash, mustChangePassword: true },
      select: { id: true },
    });
    await audit(tx, {
      action: "admin.created_by_command_line",
      entityType: "User",
      entityId: created.id,
      metadata: { loginId },
    });
    return created;
  });
  return { id: user.id, loginId, temporaryPassword };
}
