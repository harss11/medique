import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import { maskPhone, normalizeMobile } from "../../utils/phone.js";
import type { RequestMeta } from "../../utils/request.js";
import { formatDateShort } from "../../utils/time.js";
import { advisoryLock } from "../appointments/booking.service.js";
import { enqueueGroupMessages, kickDispatcher } from "../notifications/notifications.service.js";
import { ageInYears } from "../queue/queue-rules.js";
import type { z } from "zod";
import type { BankScope } from "./bank-scope.js";
import { BLOOD_TIMEZONE, VOID_WINDOW_HOURS, donorRules } from "./blood-config.js";
import { donationEligibility, nextEligibleAt } from "./blood-rules.js";
import type { recordDonationSchema } from "./donor.schemas.js";

type RecordInput = z.output<typeof recordDonationSchema>;

const NOT_FOUND =
  "No registered donor has this number. Ask the donor to register in the MediQ app first.";

/**
 * Finds a registered donor by phone so staff can record a donation. The same answer is given
 * whether the number has no account or just is not a donor, and every lookup is audited.
 */
export async function lookupDonor(scope: BankScope, rawPhone: string, meta: RequestMeta) {
  const phone = normalizeMobile(rawPhone);
  if (!phone) throw AppError.badRequest("Enter a valid mobile number", "INVALID_PHONE");
  const donor = await prisma.donorProfile.findFirst({
    where: { user: { phone, status: "ACTIVE" } },
    include: { user: { select: { name: true } } },
  });
  await audit(prisma, {
    actor: scope.actor,
    action: "donor.looked_up",
    entityType: "BloodBank",
    entityId: scope.bloodBankId,
    metadata: { phone: maskPhone(phone), found: !!donor },
    meta,
  });
  if (!donor) throw AppError.notFound(NOT_FOUND, "DONOR_NOT_FOUND");

  const now = new Date();
  const eligibility = donationEligibility(donor, now, donorRules);
  return {
    donorId: donor.id,
    name: donor.user.name,
    bloodGroup: donor.bloodGroup,
    gender: donor.gender,
    ageYears: ageInYears(donor.dateOfBirth, now),
    lastDonationAt: donor.lastDonationAt,
    eligible: eligibility.eligible,
    ineligibleReasons: eligibility.reasons,
    nextEligibleAt: eligibility.nextEligibleAt,
  };
}

/**
 * Records a donation. Only blood bank staff can: a donor cannot add one for themselves. It is
 * refused inside the transaction if the donor is not eligible (age, or still in the waiting
 * period), so two staff members cannot record the same donor twice. The donor gets an SMS, so a
 * wrongly recorded donation does not go unnoticed. Nothing is issued: it is a record.
 */
export async function recordDonation(scope: BankScope, input: RecordInput, meta: RequestMeta) {
  const result = await prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `donor:${input.donorId}`);
    const donor = await tx.donorProfile.findFirst({
      where: { id: input.donorId, user: { status: "ACTIVE" } },
      include: { user: { select: { id: true, phone: true } } },
    });
    if (!donor) throw AppError.notFound(NOT_FOUND, "DONOR_NOT_FOUND");

    const now = new Date();
    const eligibility = donationEligibility(donor, now, donorRules);
    if (!eligibility.eligible) {
      throw new AppError(409, "DONOR_NOT_ELIGIBLE", "This donor cannot donate now.", {
        reasons: eligibility.reasons,
        nextEligibleAt: eligibility.nextEligibleAt,
      });
    }

    const donation = await tx.donation.create({
      data: {
        donorId: donor.id,
        bloodBankId: scope.bloodBankId,
        recordedById: scope.actor.userId,
        donatedAt: now,
        bloodGroup: input.bloodGroup,
        volumeMl: input.volumeMl,
      },
    });
    // The bank's test settles the blood group.
    await tx.donorProfile.update({
      where: { id: donor.id },
      data: { lastDonationAt: now, bloodGroup: input.bloodGroup },
    });
    await audit(tx, {
      actor: scope.actor,
      action: "donation.recorded",
      entityType: "Donation",
      entityId: donation.id,
      metadata: {
        bloodBankId: scope.bloodBankId,
        bloodGroup: input.bloodGroup,
        volumeMl: input.volumeMl,
      },
      meta,
    });

    const next = nextEligibleAt(now, donor.gender, donorRules)!;
    if (donor.user.phone) {
      await enqueueGroupMessages(tx, [
        {
          groupKey: `donation:${donation.id}`,
          to: donor.user.phone,
          userId: donor.user.id,
          template: "donation_recorded",
          vars: { bank: scope.bank.name, date: formatDateShort(next, BLOOD_TIMEZONE) },
        },
      ]);
    }
    return { donation, next };
  });
  kickDispatcher();
  return {
    id: result.donation.id,
    donatedAt: result.donation.donatedAt,
    bloodGroup: result.donation.bloodGroup,
    volumeMl: result.donation.volumeMl,
    nextEligibleAt: result.next,
  };
}

export async function listBankDonations(bloodBankId: string, skip: number, take: number) {
  const where = { bloodBankId };
  const [rows, total] = await prisma.$transaction([
    prisma.donation.findMany({
      where,
      orderBy: { donatedAt: "desc" },
      skip,
      take,
      include: {
        donor: { select: { user: { select: { name: true, phone: true } } } },
        recordedBy: { select: { name: true } },
      },
    }),
    prisma.donation.count({ where }),
  ]);
  const cutoff = Date.now() - VOID_WINDOW_HOURS * 3_600_000;
  return {
    total,
    items: rows.map((d) => ({
      id: d.id,
      donatedAt: d.donatedAt,
      bloodGroup: d.bloodGroup,
      volumeMl: d.volumeMl,
      donorName: d.donor?.user.name ?? "Erased donor",
      donorPhone: d.donor?.user.phone ? maskPhone(d.donor.user.phone) : null,
      recordedBy: d.recordedBy.name,
      voided: d.voidedAt !== null,
      voidReason: d.voidReason,
      canVoid: d.voidedAt === null && d.donatedAt.getTime() >= cutoff,
    })),
  };
}

/** Voids a donation recorded by mistake (within 48 hours) so the donor is not locked out. Audited with the reason. */
export async function voidDonation(
  scope: BankScope,
  id: string,
  reason: string,
  meta: RequestMeta,
) {
  await prisma.$transaction(async (tx) => {
    const donation = await tx.donation.findFirst({ where: { id, bloodBankId: scope.bloodBankId } });
    if (!donation) throw AppError.notFound("Donation not found");
    if (donation.voidedAt)
      throw AppError.conflict("This donation was already voided", "ALREADY_VOIDED");
    if (Date.now() - donation.donatedAt.getTime() > VOID_WINDOW_HOURS * 3_600_000) {
      throw AppError.conflict(
        `A donation can only be voided within ${VOID_WINDOW_HOURS} hours`,
        "VOID_WINDOW_PASSED",
      );
    }
    if (donation.donorId) await advisoryLock(tx, `donor:${donation.donorId}`);
    await tx.donation.update({
      where: { id },
      data: { voidedAt: new Date(), voidedById: scope.actor.userId, voidReason: reason },
    });
    if (donation.donorId) {
      const latest = await tx.donation.findFirst({
        where: { donorId: donation.donorId, voidedAt: null },
        orderBy: { donatedAt: "desc" },
        select: { donatedAt: true },
      });
      await tx.donorProfile.update({
        where: { id: donation.donorId },
        data: { lastDonationAt: latest?.donatedAt ?? null },
      });
    }
    await audit(tx, {
      actor: scope.actor,
      action: "donation.voided",
      entityType: "Donation",
      entityId: id,
      metadata: { bloodBankId: scope.bloodBankId, reason },
      meta,
    });
  });
}
