import { prisma } from "../../lib/prisma.js";
import { dateOnly } from "../../utils/time.js";
import {
  estimateWait,
  queueState,
  type QueueCounts,
  type QueueState,
  type WaitEstimate,
  type YourTokenStatus,
} from "./queue-rules.js";

/**
 * The live state of one doctor's day, computed from the appointments themselves, so it
 * can never disagree with what the doctor and the desk see.
 */
export interface QueueSnapshot {
  date: string;
  state: QueueState;
  /** Token with the doctor right now. */
  nowServing: number | null;
  /** Token most recently finished. */
  lastServed: number | null;
  /** Highest token issued today. */
  lastIssued: number;
  counts: QueueCounts;
  avgConsultMinutes: number;
  generatedAt: string;
}

export async function queueSnapshot(
  doctorId: string,
  date: string,
  avgConsultMinutes: number,
): Promise<QueueSnapshot> {
  const rows = await prisma.appointment.findMany({
    where: {
      doctorId,
      appointmentDate: dateOnly(date),
      status: { in: ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW"] },
      tokenNumber: { not: null },
    },
    select: { status: true, tokenNumber: true, completedAt: true },
  });

  const counts: QueueCounts = { booked: 0, waiting: 0, inProgress: 0, completed: 0, noShow: 0 };
  let nowServing: number | null = null;
  let lastServed: { token: number; at: number } | null = null;
  let lastIssued = 0;
  for (const r of rows) {
    const token = r.tokenNumber!;
    lastIssued = Math.max(lastIssued, token);
    switch (r.status) {
      case "CONFIRMED":
        counts.booked++;
        break;
      case "CHECKED_IN":
        counts.waiting++;
        break;
      case "IN_PROGRESS":
        counts.inProgress++;
        nowServing = token;
        break;
      case "COMPLETED": {
        counts.completed++;
        const at = r.completedAt?.getTime() ?? 0;
        if (!lastServed || at >= lastServed.at) lastServed = { token, at };
        break;
      }
      case "NO_SHOW":
        counts.noShow++;
        break;
    }
  }

  return {
    date,
    state: queueState(counts),
    nowServing,
    lastServed: lastServed?.token ?? null,
    lastIssued,
    counts,
    avgConsultMinutes,
    generatedAt: new Date().toISOString(),
  };
}

export interface YourToken extends WaitEstimate {
  token: number;
  status: YourTokenStatus;
}

/** Where a given token stands: how many are ahead and roughly how long. Reveals no names. */
export async function yourTokenStatus(
  doctorId: string,
  date: string,
  token: number,
  avgConsultMinutes: number,
): Promise<YourToken> {
  const mine = await prisma.appointment.findFirst({
    where: { doctorId, appointmentDate: dateOnly(date), tokenNumber: token },
    select: { status: true },
  });
  const none = (status: YourTokenStatus): YourToken => ({
    token,
    status,
    ...estimateWait(0, avgConsultMinutes),
  });
  if (!mine) return none("NOT_FOUND");
  switch (mine.status) {
    case "IN_PROGRESS":
      return none("NOW");
    case "COMPLETED":
      return none("DONE");
    case "NO_SHOW":
    case "CANCELLED":
    case "EXPIRED":
      return none("MISSED");
    default: {
      const ahead = await prisma.appointment.count({
        where: {
          doctorId,
          appointmentDate: dateOnly(date),
          status: { in: ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"] },
          tokenNumber: { lt: token },
        },
      });
      return { token, status: "WAITING", ...estimateWait(ahead, avgConsultMinutes) };
    }
  }
}

// ---------------------------------------------------------------------------
// A tiny cache for the public queue page: many phones refresh every few seconds, but the
// answer only needs to be a couple of seconds fresh.
// ---------------------------------------------------------------------------

const CACHE_MS = 2_000;
const cache = new Map<string, { at: number; value: unknown }>();

export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2_000) {
    const cutoff = Date.now() - CACHE_MS;
    for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
  }
  return value;
}

export function clearQueueCache(): void {
  cache.clear();
}
