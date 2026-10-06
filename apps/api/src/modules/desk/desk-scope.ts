import type { Request } from "express";
import type { Role } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, type AuthContext } from "../../middleware/authenticate.js";
import type { AuditActor } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";

export type DeskRole = Extract<Role, "RECEPTIONIST" | "HOSPITAL_ADMIN" | "DOCTOR">;
export const DESK_ROLES: readonly DeskRole[] = ["RECEPTIONIST", "HOSPITAL_ADMIN", "DOCTOR"];

/**
 * Who is working at the desk, and what they may touch.
 *
 * - Receptionists and hospital admins act on any doctor of their own hospital.
 * - A doctor acts only on their own patients (`doctorId` is set and enforced everywhere).
 * - The hospital always comes from the signed-in user, never from the request.
 */
export interface DeskScope {
  auth: AuthContext;
  role: DeskRole;
  hospitalId: string;
  userId: string;
  actor: AuditActor;
  /** Set only for a doctor: the one doctor they may act for. */
  doctorId: string | null;
}

export async function deskScope(req: Request): Promise<DeskScope> {
  const auth = requireAuth(req);
  if (!auth.hospitalId || !DESK_ROLES.includes(auth.role as DeskRole)) throw AppError.forbidden();
  let doctorId: string | null = null;
  if (auth.role === "DOCTOR") {
    const doctor = await prisma.doctor.findFirst({
      where: { userId: auth.userId, hospitalId: auth.hospitalId },
      select: { id: true },
    });
    if (!doctor)
      throw AppError.forbidden("This login is not linked to a doctor", "NO_DOCTOR_PROFILE");
    doctorId = doctor.id;
  }
  return {
    auth,
    role: auth.role as DeskRole,
    hospitalId: auth.hospitalId,
    userId: auth.userId,
    actor: { userId: auth.userId, role: auth.role },
    doctorId,
  };
}

/** Booking, cash, check-in and cancelling are front-desk work, not the doctor's. */
export function requireFrontDesk(scope: DeskScope): void {
  if (scope.role === "DOCTOR") throw AppError.forbidden();
}

/** A doctor may only act for themselves; reception and admins for any doctor of the hospital. */
export function assertDoctorAllowed(scope: DeskScope, doctorId: string): void {
  if (scope.doctorId && scope.doctorId !== doctorId) throw AppError.notFound();
}
