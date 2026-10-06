import type { Prisma } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { hmacSha256, randomToken } from "../../utils/crypto.js";
import { AppError } from "../../utils/http.js";
import { maskPhone } from "../../utils/phone.js";
import type { RequestMeta } from "../../utils/request.js";
import { advisoryLock } from "../appointments/booking.service.js";
import { consumeOtp } from "../auth/otp.service.js";
import {
  enqueueGroupMessages,
  kickDispatcher,
  type GroupMessage,
} from "../notifications/notifications.service.js";
import type { z } from "zod";
import { donorRules } from "./blood-config.js";
import { bloodGroupLabel, boundingBox, requestExpiry } from "./blood-rules.js";
import { rankBanks, rankDonors, type RequestPlace } from "./matching.js";
import { toRequesterRequestDto } from "./request.dto.js";
import type { createRequestSchema } from "./request.schemas.js";

type CreateInput = z.output<typeof createRequestSchema>;

const DAY_MS = 24 * 3_600_000;
const MAX_BANKS_ALERTED = 10;
/** Candidates loaded for ranking: far more than will be alerted, but bounded. */
const CANDIDATE_LIMIT = 2000;

/** The secret kept by the requester's browser is only ever stored as a keyed hash. */
export const hashRequestKey = (key: string) =>
  hmacSha256(env.OTP_HMAC_SECRET, "blood-request-key:" + key);

/** The cheap database filter: coordinates inside a box, or no coordinates and the same city. */
function locationFilter(place: RequestPlace): Prisma.DonorProfileWhereInput {
  const sameCity = { city: { equals: place.city, mode: "insensitive" as const } };
  if (place.latitude == null || place.longitude == null) return sameCity;
  const box = boundingBox(place.latitude, place.longitude, place.radiusKm);
  return {
    OR: [
      {
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      },
      { latitude: null, ...sameCity },
    ],
  };
}

/**
 * Creates an emergency request and alerts the donors and blood banks near it. The phone is
 * proved with a code first. Everything (the request, who was alerted, the queued messages and
 * the audit entry) is one transaction: either all of it happens or none, and no alert is ever
 * sent for a request that was not saved. Returns the secret key the requester needs to come
 * back to the page; it is shown once and only its hash is stored.
 */
export async function createBloodRequest(input: CreateInput, meta: RequestMeta) {
  await consumeOtp(input.phone, input.code, "BLOOD_REQUEST");
  const key = randomToken(32);
  const place: RequestPlace = {
    city: input.city,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    radiusKm: input.radiusKm,
  };

  const result = await prisma.$transaction(
    async (tx) => {
      await advisoryLock(tx, `bloodreq:${input.phone}`);
      const now = new Date();
      const since = new Date(now.getTime() - DAY_MS);

      const made = await tx.bloodRequest.count({
        where: { requesterPhone: input.phone, createdAt: { gte: since } },
      });
      if (made >= env.BLOOD_REQUESTS_PER_PHONE_PER_DAY) {
        throw AppError.tooMany(
          "This number has made the most blood requests allowed in a day. Please call a blood bank directly.",
          "BLOOD_REQUEST_LIMIT",
        );
      }
      const duplicate = await tx.bloodRequest.findFirst({
        where: {
          requesterPhone: input.phone,
          bloodGroup: input.bloodGroup,
          hospitalName: { equals: input.hospitalName, mode: "insensitive" },
          status: "OPEN",
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw AppError.conflict(
          "You already have an open request for this. Use Find my request to open it.",
          "DUPLICATE_REQUEST",
        );
      }

      const request = await tx.bloodRequest.create({
        data: {
          requesterPhone: input.phone,
          requesterName: input.requesterName,
          requesterKeyHash: hashRequestKey(key),
          bloodGroup: input.bloodGroup,
          unitsNeeded: input.unitsNeeded,
          urgency: input.urgency,
          hospitalName: input.hospitalName,
          city: input.city,
          latitude: place.latitude,
          longitude: place.longitude,
          radiusKm: input.radiusKm,
          note: input.note ?? null,
          expiresAt: requestExpiry(now, env.BLOOD_REQUEST_TTL_HOURS),
          createdIp: meta.ip ?? null,
        },
      });

      // Who to tell: donors of this exact group near the hospital, and blood banks near it.
      const donorRows = await tx.donorProfile.findMany({
        where: {
          bloodGroup: input.bloodGroup,
          isAvailable: true,
          user: { status: "ACTIVE", phone: { not: null } },
          ...locationFilter(place),
        },
        take: CANDIDATE_LIMIT,
        include: { user: { select: { id: true, phone: true } } },
      });
      const recent = await tx.bloodRequestAlert.groupBy({
        by: ["donorId"],
        where: { donorId: { in: donorRows.map((d) => d.id) }, createdAt: { gte: since } },
        _count: { _all: true },
      });
      const alertsToday = new Map(recent.map((r) => [r.donorId, r._count._all]));
      const donors = rankDonors(
        donorRows.map((d) => ({
          id: d.id,
          userId: d.user.id,
          phone: d.user.phone!,
          bloodGroup: d.bloodGroup,
          gender: d.gender,
          dateOfBirth: d.dateOfBirth,
          lastDonationAt: d.lastDonationAt,
          isAvailable: d.isAvailable,
          city: d.city,
          latitude: d.latitude,
          longitude: d.longitude,
          alertsToday: alertsToday.get(d.id) ?? 0,
        })),
        { ...place, bloodGroup: input.bloodGroup, requesterPhone: input.phone },
        now,
        donorRules,
        {
          maxDonors: env.BLOOD_MAX_DONORS_ALERTED,
          maxAlertsPerDay: env.BLOOD_MAX_ALERTS_PER_DONOR_PER_DAY,
        },
      );
      const bankRows = await tx.bloodBank.findMany({
        where: { status: "ACTIVE" },
        take: 500,
        select: { id: true, phone: true, city: true, latitude: true, longitude: true },
      });
      const banks = rankBanks(bankRows, place, MAX_BANKS_ALERTED);

      await tx.bloodRequestAlert.createMany({
        data: [
          ...donors.map((d) => ({
            requestId: request.id,
            donorId: d.candidate.id,
            distanceKm: d.distanceKm,
          })),
          ...banks.map((b) => ({
            requestId: request.id,
            bloodBankId: b.candidate.id,
            distanceKm: b.distanceKm,
          })),
        ],
      });

      const vars = {
        units: String(input.unitsNeeded),
        group: bloodGroupLabel(input.bloodGroup),
        place: input.hospitalName,
        city: input.city,
      };
      const groupKey = `blood-request:${request.id}`;
      const messages: GroupMessage[] = [
        ...donors.map((d) => ({
          groupKey,
          to: d.candidate.phone,
          userId: d.candidate.userId,
          template: "blood_request_alert" as const,
          vars,
        })),
        ...banks.map((b) => ({
          groupKey,
          to: b.candidate.phone,
          template: "blood_request_bank_alert" as const,
          vars,
        })),
      ];
      await enqueueGroupMessages(tx, messages);

      const updated = await tx.bloodRequest.update({
        where: { id: request.id },
        data: { alertedDonors: donors.length, alertedBanks: banks.length },
      });
      await audit(tx, {
        action: "blood_request.created",
        entityType: "BloodRequest",
        entityId: request.id,
        metadata: {
          requester: maskPhone(input.phone),
          bloodGroup: input.bloodGroup,
          units: input.unitsNeeded,
          city: input.city,
          alertedDonors: donors.length,
          alertedBanks: banks.length,
        },
        meta,
      });
      return updated;
    },
    { timeout: 30_000 },
  );

  kickDispatcher();
  return { request: toRequesterRequestDto(result), key };
}
