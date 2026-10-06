/**
 * Creates a platform admin login (the first admin in production, where the seed refuses to
 * run, or an additional one).
 *
 *   pnpm admin:create -- --login your.name --name "Your Name"
 *
 * Prints a random temporary password once. The admin must change it at first login.
 */
import { prisma } from "../lib/prisma.js";
import { createPlatformAdmin } from "./create-admin-lib.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const loginId = arg("login");
const name = arg("name");
if (!loginId || !name) {
  console.error('Usage: pnpm admin:create -- --login your.name --name "Your Name"');
  process.exit(1);
}

try {
  const admin = await createPlatformAdmin({ loginId, name });
  console.warn(`
Platform admin created.

  Login page : /admin/login
  Login ID   : ${admin.loginId}
  Password   : ${admin.temporaryPassword}   (temporary: shown once, must be changed at first login)
`);
} catch (err) {
  console.error("Could not create the admin:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
