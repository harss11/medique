import type { Request } from "express";
import { requireAuth, type AuthContext } from "../../middleware/authenticate.js";
import type { AuditActor } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";

export interface HospitalScope {
  auth: AuthContext;
  hospitalId: string;
  actor: AuditActor;
}

/**
 * Ownership for the hospital panel: the hospital id always comes from the
 * signed-in user, never from the URL or body. Every query below adds
 * `hospitalId` to its `where`, so records of other hospitals are simply not found.
 */
export function hospitalScope(req: Request): HospitalScope {
  const auth = requireAuth(req);
  if (!auth.hospitalId) throw AppError.forbidden();
  return { auth, hospitalId: auth.hospitalId, actor: { userId: auth.userId, role: auth.role } };
}
