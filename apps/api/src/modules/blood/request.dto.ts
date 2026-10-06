import type { BloodRequest } from "../../generated/prisma/client.js";

/** A request is open only while its status says so AND its time has not run out. */
export function effectiveStatus(r: Pick<BloodRequest, "status" | "expiresAt">, now = new Date()) {
  return r.status === "OPEN" && r.expiresAt <= now ? ("EXPIRED" as const) : r.status;
}

export const isOpen = (r: Pick<BloodRequest, "status" | "expiresAt">, now = new Date()) =>
  effectiveStatus(r, now) === "OPEN";

/** The request as the requester sees it. Never includes the secret key or its hash. */
export function toRequesterRequestDto(r: BloodRequest, now = new Date()) {
  return {
    id: r.id,
    bloodGroup: r.bloodGroup,
    unitsNeeded: r.unitsNeeded,
    urgency: r.urgency,
    hospitalName: r.hospitalName,
    city: r.city,
    radiusKm: r.radiusKm,
    note: r.note,
    status: effectiveStatus(r, now),
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    alertedDonors: r.alertedDonors,
    alertedBanks: r.alertedBanks,
  };
}

/**
 * What a donor or a blood bank sees of a request they were alerted to: where and what, but
 * never the requester's phone number and only the first name.
 */
export function toResponderRequestDto(
  r: BloodRequest,
  extra: {
    requesterFirstName: string;
    distanceKm: number | null;
    myResponse: "CAN_HELP" | "CANNOT" | null;
  },
  now = new Date(),
) {
  return {
    id: r.id,
    bloodGroup: r.bloodGroup,
    unitsNeeded: r.unitsNeeded,
    urgency: r.urgency,
    hospitalName: r.hospitalName,
    city: r.city,
    note: r.note,
    status: effectiveStatus(r, now),
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    ...extra,
  };
}
