import type { BloodRequest } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { randomToken, safeEqualHex } from "../../utils/crypto.js";
import { AppError } from "../../utils/http.js";
import { maskPhone } from "../../utils/phone.js";
import type { RequestMeta } from "../../utils/request.js";
import { consumeOtp } from "../auth/otp.service.js";
import { firstName } from "./blood-rules.js";
import { isOpen, toRequesterRequestDto } from "./request.dto.js";
import { hashRequestKey } from "./request.service.js";

/**
 * What the requester can do with their secret key: see who can help, close the request, or get a
 * new key (after proving their phone again). The key is the only thing that opens a request: a
 * wrong key and a wrong id look exactly the same.
 */

export async function findRequestByKey(id: string, key: string | undefined): Promise<BloodRequest> {
  const request = key ? await prisma.bloodRequest.findUnique({ where: { id } }) : null;
  if (!request || !key || !safeEqualHex(hashRequestKey(key), request.requesterKeyHash)) {
    throw AppError.notFound("This request was not found", "REQUEST_NOT_FOUND");
  }
  return request;
}

/**
 * The requester's page. A donor's phone number is shown only while that donor's "I can help" stands
 * AND the request is still open: once it is closed or has run out, the numbers disappear again.
 */
export async function requesterView(request: BloodRequest) {
  const now = new Date();
  const open = isOpen(request, now);
  const answers = await prisma.bloodRequestResponse.findMany({
    where: { requestId: request.id, response: "CAN_HELP" },
    orderBy: { createdAt: "asc" },
    include: {
      donor: { include: { user: { select: { name: true, phone: true, status: true } } } },
      bloodBank: { select: { name: true, phone: true, city: true, status: true } },
    },
  });
  const alerts = await prisma.bloodRequestAlert.findMany({
    where: {
      requestId: request.id,
      donorId: { in: answers.flatMap((a) => (a.donorId ? [a.donorId] : [])) },
    },
    select: { donorId: true, distanceKm: true },
  });
  const distance = new Map(alerts.map((a) => [a.donorId, a.distanceKm]));

  const donors = answers
    .filter((a) => a.donor && a.donor.user.status === "ACTIVE")
    .map((a) => ({
      firstName: firstName(a.donor!.user.name),
      bloodGroup: a.donor!.bloodGroup,
      distanceKm: distance.get(a.donorId) ?? null,
      respondedAt: a.updatedAt,
      phone: open ? a.donor!.user.phone : null,
    }));
  const banks = answers
    .filter((a) => a.bloodBank && a.bloodBank.status === "ACTIVE")
    .map((a) => ({
      name: a.bloodBank!.name,
      city: a.bloodBank!.city,
      phone: open ? a.bloodBank!.phone : null,
      respondedAt: a.updatedAt,
    }));
  return { request: toRequesterRequestDto(request, now), donors, banks };
}

export async function closeRequest(
  request: BloodRequest,
  outcome: "FULFILLED" | "CANCELLED",
  meta: RequestMeta,
) {
  if (request.status !== "OPEN") return toRequesterRequestDto(request);
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.bloodRequest.updateMany({
      where: { id: request.id, status: "OPEN" },
      data: { status: outcome, closedAt: new Date() },
    });
    if (count === 1) {
      await audit(tx, {
        action: "blood_request.closed",
        entityType: "BloodRequest",
        entityId: request.id,
        metadata: { outcome },
        meta,
      });
    }
    return tx.bloodRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
  return toRequesterRequestDto(updated);
}

/**
 * Gets the requester back in: after a code sent to the same phone, each open request of that
 * number gets a NEW key (the old one stops working) so a lost or shared link can be replaced.
 */
export async function recoverRequests(phone: string, code: string, meta: RequestMeta) {
  await consumeOtp(phone, code, "BLOOD_REQUEST_RECOVERY");
  const open = await prisma.bloodRequest.findMany({
    where: { requesterPhone: phone, status: "OPEN", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const items = [];
  for (const request of open) {
    const key = randomToken(32);
    await prisma.$transaction(async (tx) => {
      await tx.bloodRequest.update({
        where: { id: request.id },
        data: { requesterKeyHash: hashRequestKey(key) },
      });
      await audit(tx, {
        action: "blood_request.recovered",
        entityType: "BloodRequest",
        entityId: request.id,
        metadata: { requester: maskPhone(phone) },
        meta,
      });
    });
    items.push({ ...toRequesterRequestDto(request), key });
  }
  return items;
}
