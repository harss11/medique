import type { DonorProfile } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { dateOnly, toLocalDate } from "../../utils/time.js";
import { ageInYears } from "../queue/queue-rules.js";
import type { z } from "zod";
import { donorRules } from "./blood-config.js";
import { canBeAlerted, donationEligibility, roundCoord } from "./blood-rules.js";
import type { donorProfileSchema } from "./donor.schemas.js";

type ProfileInput = z.output<typeof donorProfileSchema>;

/** The donor's own view of their profile, with what they can and cannot do right now. */
export function toDonorDto(p: DonorProfile, now = new Date()) {
  const eligibility = donationEligibility(p, now, donorRules);
  return {
    bloodGroup: p.bloodGroup,
    gender: p.gender,
    dateOfBirth: toLocalDate(p.dateOfBirth),
    city: p.city,
    hasLocation: p.latitude != null && p.longitude != null,
    isAvailable: p.isAvailable,
    lastDonationAt: p.lastDonationAt,
    eligible: eligibility.eligible,
    ineligibleReasons: eligibility.reasons,
    nextEligibleAt: eligibility.nextEligibleAt,
    /** True when MediQ would alert this donor about a request right now. */
    canBeAlerted: canBeAlerted(p, now, donorRules),
    alertsConsentAt: p.alertsConsentAt,
  };
}

export async function getDonorProfile(userId: string) {
  const profile = await prisma.donorProfile.findUnique({ where: { userId } });
  return profile ? toDonorDto(profile) : null;
}

/**
 * Registers the signed-in patient as a donor, or updates their details. Their phone is already
 * verified (they signed in with a code). The first time they must agree to be alerted and to
 * share their number after saying "I can help"; that agreement is recorded with its version.
 */
export async function saveDonorProfile(userId: string, input: ProfileInput, meta: RequestMeta) {
  const age = ageInYears(dateOnly(input.dateOfBirth)) ?? 0;
  if (age < donorRules.minAge || age > donorRules.maxAge) {
    throw AppError.badRequest(
      `Donors must be between ${donorRules.minAge} and ${donorRules.maxAge} years old.`,
      "DONOR_AGE",
    );
  }
  const data = {
    bloodGroup: input.bloodGroup,
    gender: input.gender,
    dateOfBirth: dateOnly(input.dateOfBirth),
    city: input.city,
    latitude: input.latitude != null ? roundCoord(input.latitude) : null,
    longitude: input.longitude != null ? roundCoord(input.longitude) : null,
  };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.donorProfile.findUnique({ where: { userId } });
    if (!existing) {
      if (input.acceptAlerts !== true) {
        throw AppError.badRequest(
          "Please agree to be alerted about nearby requests to register as a donor.",
          "CONSENT_REQUIRED",
        );
      }
      const now = new Date();
      const created = await tx.donorProfile.create({
        data: {
          userId,
          ...data,
          alertsConsentAt: now,
          alertsConsentVersion: env.PRIVACY_POLICY_VERSION,
        },
      });
      await tx.consentRecord.create({
        data: {
          userId,
          type: "DONOR_ALERTS",
          version: env.PRIVACY_POLICY_VERSION,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });
      await audit(tx, {
        actor: { userId, role: "PATIENT" },
        action: "donor.registered",
        entityType: "DonorProfile",
        entityId: created.id,
        after: { bloodGroup: created.bloodGroup, city: created.city },
        meta,
      });
      return toDonorDto(created);
    }

    // Once a blood bank has confirmed the group at a donation, the donor cannot change it.
    if (data.bloodGroup !== existing.bloodGroup) {
      const confirmed = await tx.donation.count({
        where: { donorId: existing.id, voidedAt: null },
      });
      if (confirmed > 0) {
        throw AppError.conflict(
          "Your blood group was confirmed by a blood bank. If it is wrong, ask the blood bank to correct it.",
          "GROUP_CONFIRMED",
        );
      }
    }
    const updated = await tx.donorProfile.update({ where: { id: existing.id }, data });
    await audit(tx, {
      actor: { userId, role: "PATIENT" },
      action: "donor.updated",
      entityType: "DonorProfile",
      entityId: existing.id,
      before: { bloodGroup: existing.bloodGroup, city: existing.city },
      after: { bloodGroup: updated.bloodGroup, city: updated.city },
      meta,
    });
    return toDonorDto(updated);
  });
}

export async function setAvailability(userId: string, isAvailable: boolean) {
  const existing = await prisma.donorProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!existing) throw AppError.notFound("You are not registered as a donor yet", "NOT_A_DONOR");
  return toDonorDto(
    await prisma.donorProfile.update({ where: { id: existing.id }, data: { isAvailable } }),
  );
}

/**
 * Stops being a donor: the profile (and its alerts and answers) goes. Donation records stay
 * with the blood bank that made them, no longer linked to a person.
 */
export async function removeDonorProfile(userId: string, meta: RequestMeta) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.donorProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!existing) throw AppError.notFound("You are not registered as a donor", "NOT_A_DONOR");
    await tx.donorProfile.delete({ where: { id: existing.id } });
    await audit(tx, {
      actor: { userId, role: "PATIENT" },
      action: "donor.removed",
      entityType: "DonorProfile",
      entityId: existing.id,
      meta,
    });
  });
}

export async function listMyDonations(userId: string) {
  const rows = await prisma.donation.findMany({
    where: { donor: { userId }, voidedAt: null },
    orderBy: { donatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      donatedAt: true,
      bloodGroup: true,
      volumeMl: true,
      bloodBank: { select: { name: true, city: true } },
    },
  });
  return rows.map((d) => ({
    id: d.id,
    donatedAt: d.donatedAt,
    bloodGroup: d.bloodGroup,
    volumeMl: d.volumeMl,
    bloodBank: d.bloodBank.name,
    city: d.bloodBank.city,
  }));
}
