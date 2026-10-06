import { prisma } from "../../lib/prisma.js";

/** Marks open requests whose time has run out as EXPIRED. Reads already treat them as closed. */
export async function expireBloodRequests(now = new Date()): Promise<number> {
  const { count } = await prisma.bloodRequest.updateMany({
    where: { status: "OPEN", expiresAt: { lte: now } },
    data: { status: "EXPIRED", closedAt: now },
  });
  return count;
}

const PURGED = "[removed]";

/**
 * Removes the requester name, number and note from requests that closed long ago, and the
 * alerts and answers attached to them. They are kept for a while only so an abusive number can
 * be spotted. Returns how many requests were cleaned.
 */
export async function purgeOldBloodRequests(now = new Date(), retentionDays = 90): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const old = await prisma.bloodRequest.findMany({
    where: {
      status: { not: "OPEN" },
      closedAt: { lt: cutoff },
      requesterPhone: { notIn: [PURGED, "[erased]"] },
    },
    select: { id: true },
    take: 500,
  });
  if (old.length === 0) return 0;
  const ids = old.map((r) => r.id);
  await prisma.$transaction([
    prisma.bloodRequestAlert.deleteMany({ where: { requestId: { in: ids } } }),
    prisma.bloodRequestResponse.deleteMany({ where: { requestId: { in: ids } } }),
    prisma.bloodRequest.updateMany({
      where: { id: { in: ids } },
      data: { requesterPhone: PURGED, requesterName: PURGED, note: null, createdIp: null },
    }),
  ]);
  return ids.length;
}
