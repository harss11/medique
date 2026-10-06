import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { enqueueGroupMessages, kickDispatcher } from "../notifications/notifications.service.js";
import type { BankScope } from "./bank-scope.js";
import { donorRules } from "./blood-config.js";
import { bloodGroupLabel, donationEligibility, firstName } from "./blood-rules.js";
import { isOpen, toResponderRequestDto } from "./request.dto.js";

/**
 * How donors and blood banks answer a request they were alerted to. Only an alerted donor or
 * bank can see or answer it, and never sees the requester's phone number: the requester sees
 * theirs, after they say "I can help".
 */

type Answer = "CAN_HELP" | "CANNOT";

const requestFields = {
  id: true,
  requesterName: true,
  requesterPhone: true,
  requesterKeyHash: true,
  bloodGroup: true,
  unitsNeeded: true,
  urgency: true,
  hospitalName: true,
  city: true,
  latitude: true,
  longitude: true,
  radiusKm: true,
  note: true,
  status: true,
  expiresAt: true,
  closedAt: true,
  createdIp: true,
  alertedDonors: true,
  alertedBanks: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Open requests this donor was alerted to, newest first. */
export async function listDonorRequests(userId: string) {
  const donor = await prisma.donorProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!donor) return [];
  const alerts = await prisma.bloodRequestAlert.findMany({
    where: { donorId: donor.id, request: { status: "OPEN", expiresAt: { gt: new Date() } } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { request: { select: requestFields } },
  });
  const answers = await prisma.bloodRequestResponse.findMany({
    where: { donorId: donor.id, requestId: { in: alerts.map((a) => a.requestId) } },
  });
  const mine = new Map(answers.map((a) => [a.requestId, a.response]));
  return alerts.map((a) =>
    toResponderRequestDto(a.request, {
      requesterFirstName: firstName(a.request.requesterName),
      distanceKm: a.distanceKm,
      myResponse: mine.get(a.requestId) ?? null,
    }),
  );
}

/** Tells the requester, once per request, that someone has answered (further answers just appear on their page). */
async function notifyRequesterOnce(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  request: {
    id: string;
    requesterPhone: string;
    bloodGroup: Parameters<typeof bloodGroupLabel>[0];
  },
) {
  await enqueueGroupMessages(tx, [
    {
      groupKey: `blood-request:${request.id}:answered`,
      to: request.requesterPhone,
      template: "blood_request_answered",
      vars: { group: bloodGroupLabel(request.bloodGroup) },
    },
  ]);
}

export async function respondAsDonor(
  userId: string,
  requestId: string,
  response: Answer,
  meta: RequestMeta,
) {
  const result = await prisma.$transaction(async (tx) => {
    const donor = await tx.donorProfile.findUnique({ where: { userId } });
    if (!donor) throw AppError.notFound("You are not registered as a donor", "NOT_A_DONOR");
    const alert = await tx.bloodRequestAlert.findUnique({
      where: { requestId_donorId: { requestId, donorId: donor.id } },
      include: { request: true },
    });
    // Not alerted means not allowed to know the request exists.
    if (!alert) throw AppError.notFound("Request not found", "REQUEST_NOT_FOUND");
    if (!isOpen(alert.request)) {
      throw AppError.conflict(
        "This request has closed. Thank you for being ready to help.",
        "REQUEST_CLOSED",
      );
    }
    if (response === "CAN_HELP") {
      const eligibility = donationEligibility(donor, new Date(), donorRules);
      if (!eligibility.eligible) {
        throw new AppError(409, "DONOR_NOT_ELIGIBLE", "You cannot donate right now.", {
          reasons: eligibility.reasons,
          nextEligibleAt: eligibility.nextEligibleAt,
        });
      }
    }
    const before = await tx.bloodRequestResponse.findUnique({
      where: { requestId_donorId: { requestId, donorId: donor.id } },
    });
    await tx.bloodRequestResponse.upsert({
      where: { requestId_donorId: { requestId, donorId: donor.id } },
      update: { response },
      create: { requestId, donorId: donor.id, response },
    });
    if (response === "CAN_HELP" && before?.response !== "CAN_HELP") {
      await notifyRequesterOnce(tx, alert.request);
    }
    await audit(tx, {
      actor: { userId, role: "PATIENT" },
      action: "blood_request.donor_responded",
      entityType: "BloodRequest",
      entityId: requestId,
      metadata: { response },
      meta,
    });
    return { requestId, response };
  });
  kickDispatcher();
  return result;
}

/** Open requests this blood bank was alerted to. */
export async function listBankRequests(bloodBankId: string) {
  const alerts = await prisma.bloodRequestAlert.findMany({
    where: { bloodBankId, request: { status: "OPEN", expiresAt: { gt: new Date() } } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { request: { select: requestFields } },
  });
  const answers = await prisma.bloodRequestResponse.findMany({
    where: { bloodBankId, requestId: { in: alerts.map((a) => a.requestId) } },
  });
  const mine = new Map(answers.map((a) => [a.requestId, a.response]));
  return alerts.map((a) =>
    toResponderRequestDto(a.request, {
      requesterFirstName: firstName(a.request.requesterName),
      distanceKm: a.distanceKm,
      myResponse: mine.get(a.requestId) ?? null,
    }),
  );
}

export async function respondAsBank(
  scope: BankScope,
  requestId: string,
  response: Answer,
  meta: RequestMeta,
) {
  const result = await prisma.$transaction(async (tx) => {
    const alert = await tx.bloodRequestAlert.findUnique({
      where: { requestId_bloodBankId: { requestId, bloodBankId: scope.bloodBankId } },
      include: { request: true },
    });
    if (!alert) throw AppError.notFound("Request not found", "REQUEST_NOT_FOUND");
    if (!isOpen(alert.request)) {
      throw AppError.conflict("This request has closed.", "REQUEST_CLOSED");
    }
    const before = await tx.bloodRequestResponse.findUnique({
      where: { requestId_bloodBankId: { requestId, bloodBankId: scope.bloodBankId } },
    });
    await tx.bloodRequestResponse.upsert({
      where: { requestId_bloodBankId: { requestId, bloodBankId: scope.bloodBankId } },
      update: { response },
      create: { requestId, bloodBankId: scope.bloodBankId, response },
    });
    if (response === "CAN_HELP" && before?.response !== "CAN_HELP") {
      await notifyRequesterOnce(tx, alert.request);
    }
    await audit(tx, {
      actor: scope.actor,
      action: "blood_request.bank_responded",
      entityType: "BloodRequest",
      entityId: requestId,
      metadata: { bloodBankId: scope.bloodBankId, response },
      meta,
    });
    return { requestId, response };
  });
  kickDispatcher();
  return result;
}
