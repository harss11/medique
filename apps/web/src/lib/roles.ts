import type { Role, User } from "./types";

export const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  HOSPITAL_ADMIN: "/hospital",
  RECEPTIONIST: "/reception",
  DOCTOR: "/doctor",
  PATIENT: "/patient",
  BLOOD_BANK_STAFF: "/blood-bank",
};

export const ROLE_LOGIN: Record<Role, string> = {
  ADMIN: "/admin/login",
  HOSPITAL_ADMIN: "/hospital/login",
  RECEPTIONIST: "/reception/login",
  DOCTOR: "/doctor/login",
  PATIENT: "/login",
  BLOOD_BANK_STAFF: "/blood-bank/login",
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Super Admin",
  HOSPITAL_ADMIN: "Hospital",
  RECEPTIONIST: "Reception",
  DOCTOR: "Doctor",
  PATIENT: "Patient",
  BLOOD_BANK_STAFF: "Blood bank",
};

/** Where a signed-in user should land. A pending password reset always wins. */
export function homeFor(user: User): string {
  return user.mustChangePassword ? "/change-password" : ROLE_HOME[user.role];
}
