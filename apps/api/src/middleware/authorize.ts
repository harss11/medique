import type { RequestHandler } from "express";
import type { Role } from "../generated/prisma/client.js";
import { AppError } from "../utils/http.js";
import { tagGuard } from "../utils/guards.js";
import type { AuthContext } from "./authenticate.js";

/** Staff roles that belong to a single hospital. */
export const HOSPITAL_STAFF_ROLES: readonly Role[] = ["HOSPITAL_ADMIN", "RECEPTIONIST", "DOCTOR"];

/**
 * Role gate. Mount after `authenticate()`:
 *   router.get("/x", authenticate(), requireRole("ADMIN"), handler)
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return tagGuard(
    (req, _res, next) => {
      if (!req.auth) throw AppError.unauthorized();
      if (!roles.includes(req.auth.role)) throw AppError.forbidden();
      next();
    },
    { kind: "roles", roles },
  );
}

/**
 * Ownership check for hospital data. The platform admin may touch any hospital;
 * hospital staff only their own. Call this in every handler that reads or
 * writes a hospital-owned record, using the record's real hospitalId (loaded
 * from the database, never taken from the request body).
 */
export function assertHospitalAccess(auth: AuthContext, hospitalId: string): void {
  if (auth.role === "ADMIN") return;
  if (HOSPITAL_STAFF_ROLES.includes(auth.role) && auth.hospitalId === hospitalId) return;
  // 404 rather than 403 so we don't confirm that another hospital's record exists.
  throw AppError.notFound();
}

/** Ownership check for patient data: a patient may only touch their own records. */
export function assertSelf(auth: AuthContext, ownerUserId: string | null): void {
  if (auth.role === "ADMIN") return;
  if (ownerUserId !== null && auth.userId === ownerUserId) return;
  throw AppError.notFound();
}
