import { describe, expect, it } from "vitest";
import { AppError } from "../utils/http.js";
import type { AuthContext } from "./authenticate.js";
import { assertHospitalAccess, assertSelf } from "./authorize.js";

const HOSPITAL_A = "00000000-0000-7000-8000-00000000000a";
const HOSPITAL_B = "00000000-0000-7000-8000-00000000000b";

const ctx = (role: AuthContext["role"], hospitalId: string | null = null): AuthContext => ({
  userId: "u1",
  role,
  name: "Test",
  hospitalId,
});

describe("assertHospitalAccess", () => {
  it("lets the admin access any hospital", () => {
    expect(() => assertHospitalAccess(ctx("ADMIN"), HOSPITAL_A)).not.toThrow();
  });

  it("lets staff access only their own hospital", () => {
    for (const role of ["HOSPITAL_ADMIN", "RECEPTIONIST", "DOCTOR"] as const) {
      expect(() => assertHospitalAccess(ctx(role, HOSPITAL_A), HOSPITAL_A)).not.toThrow();
      expect(() => assertHospitalAccess(ctx(role, HOSPITAL_A), HOSPITAL_B)).toThrow(AppError);
    }
  });

  it("never lets patients access hospital data", () => {
    expect(() => assertHospitalAccess(ctx("PATIENT"), HOSPITAL_A)).toThrow(AppError);
  });
});

describe("assertSelf", () => {
  it("allows the owner and the admin only", () => {
    expect(() => assertSelf(ctx("PATIENT"), "u1")).not.toThrow();
    expect(() => assertSelf(ctx("PATIENT"), "someone-else")).toThrow(AppError);
    expect(() => assertSelf(ctx("PATIENT"), null)).toThrow(AppError);
    expect(() => assertSelf(ctx("ADMIN"), "someone-else")).not.toThrow();
  });
});
