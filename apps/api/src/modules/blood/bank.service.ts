import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import { hashPassword } from "../../utils/password.js";
import type { RequestMeta } from "../../utils/request.js";
import { dateOnly } from "../../utils/time.js";
import { consumeOtp } from "../auth/otp.service.js";
import type { z } from "zod";
import type { BankScope } from "./bank-scope.js";
import type { registerBankSchema, updateBankSchema } from "./bank.schemas.js";
import { normalizeLicense } from "./blood-rules.js";

type RegisterInput = z.output<typeof registerBankSchema>;
type UpdateInput = z.output<typeof updateBankSchema>;

const LICENSE_TAKEN =
  "A blood bank with this licence number is already registered. If it is yours, contact MediQ support.";

/**
 * A blood bank registers itself. Its contact phone is proved with a code first, and the first
 * staff login is created with the password the registrant chose. Nothing is listed or usable
 * until the platform admin has checked the licence (status PENDING_VERIFICATION).
 */
export async function registerBloodBank(input: RegisterInput, meta: RequestMeta) {
  const licenseNumber = normalizeLicense(input.licenseNumber);
  if (await prisma.bloodBank.findUnique({ where: { licenseNumber }, select: { id: true } })) {
    throw AppError.conflict(LICENSE_TAKEN, "LICENSE_EXISTS");
  }
  const loginTaken = await prisma.user.findUnique({
    where: { loginId: input.staff.loginId },
    select: { id: true },
  });
  if (loginTaken) throw AppError.conflict("That login ID is already taken", "LOGIN_ID_TAKEN");
  // Spend the code only once everything else checks out, so a typo does not cost another SMS.
  await consumeOtp(input.phone, input.code, "BLOOD_BANK_REGISTRATION");

  const passwordHash = await hashPassword(input.staff.password);
  const consent = (type: "PRIVACY_POLICY" | "TERMS_OF_SERVICE", version: string) => ({
    type,
    version,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return prisma.$transaction(async (tx) => {
    const created = await tx.bloodBank.create({
      data: {
        name: input.name,
        licenseNumber,
        licenseAuthority: input.licenseAuthority ?? null,
        licenseValidUntil: input.licenseValidUntil ? dateOnly(input.licenseValidUntil) : null,
        phone: input.phone,
        email: input.email ?? null,
        addressLine1: input.addressLine1,
        city: input.city,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        is24x7: input.is24x7 ?? false,
        operatingHours: input.operatingHours ?? null,
      },
    });
    const user = await tx.user.create({
      data: {
        role: "BLOOD_BANK_STAFF",
        name: input.staff.name,
        loginId: input.staff.loginId,
        passwordHash,
        contactPhone: input.phone,
        email: input.email ?? null,
        bloodBankId: created.id,
        consents: {
          create: [
            consent("PRIVACY_POLICY", env.PRIVACY_POLICY_VERSION),
            consent("TERMS_OF_SERVICE", env.TERMS_VERSION),
          ],
        },
      },
      select: { id: true },
    });
    await audit(tx, {
      actor: { userId: user.id, role: "BLOOD_BANK_STAFF" },
      action: "blood_bank.registered",
      entityType: "BloodBank",
      entityId: created.id,
      after: { name: created.name, licenseNumber, city: created.city },
      meta,
    });
    return created;
  });
}

const LOCKED_WHILE_LISTED = ["name", "licenseNumber", "licenseAuthority"] as const;

/**
 * Staff edit their bank's details. The name and licence can only change while the bank was
 * REJECTED, and doing so sends it back for verification; once verified they are locked so a
 * listed bank cannot quietly become another one.
 */
export async function updateBloodBank(scope: BankScope, patch: UpdateInput, meta: RequestMeta) {
  const { bank } = scope;
  const touchesIdentity = LOCKED_WHILE_LISTED.some((k) => patch[k] !== undefined);
  if (touchesIdentity && bank.status !== "REJECTED") {
    throw AppError.badRequest(
      "The name and licence cannot be changed once the blood bank is verified. Contact MediQ support.",
      "FIELD_LOCKED",
    );
  }
  const resubmit = bank.status === "REJECTED";
  const licenseNumber = patch.licenseNumber ? normalizeLicense(patch.licenseNumber) : undefined;
  if (licenseNumber && licenseNumber !== bank.licenseNumber) {
    const taken = await prisma.bloodBank.findUnique({
      where: { licenseNumber },
      select: { id: true },
    });
    if (taken) throw AppError.conflict(LICENSE_TAKEN, "LICENSE_EXISTS");
  }
  const { licenseValidUntil, ...rest } = patch;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.bloodBank.update({
      where: { id: bank.id },
      data: {
        ...rest,
        ...(licenseNumber ? { licenseNumber } : {}),
        ...(licenseValidUntil !== undefined
          ? { licenseValidUntil: licenseValidUntil ? dateOnly(licenseValidUntil) : null }
          : {}),
        ...(resubmit ? { status: "PENDING_VERIFICATION" as const, rejectedReason: null } : {}),
      },
    });
    await audit(tx, {
      actor: scope.actor,
      action: resubmit ? "blood_bank.resubmitted" : "blood_bank.updated",
      entityType: "BloodBank",
      entityId: bank.id,
      before: { name: bank.name, city: bank.city, status: bank.status },
      after: { name: updated.name, city: updated.city, status: updated.status },
      meta,
    });
    return updated;
  });
}
