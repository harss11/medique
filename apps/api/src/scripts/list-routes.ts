/**
 * Prints every endpoint with its login, role and rate-limit requirements, read from the
 * running router (the same inventory the security tests and the API docs use).
 *
 *   pnpm routes
 */
import { routeInventory } from "../docs/route-inventory.js";

for (const r of routeInventory()) {
  const access = !r.auth ? "public" : r.roles ? r.roles.join("|") : "any signed-in user";
  const limits = r.limiters.length ? "  [limits: " + r.limiters.join(", ") + "]" : "";
  console.warn(
    r.method.padEnd(6) + " " + r.path.replace("/api/v1", "") + "  <- " + access + limits,
  );
}
