import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
import { addDays, isValidTimeZone, todayInZone, zonedTimeToUtc } from "../../utils/time.js";
import { fillDaily, percentOf, resolveRange, roundMinutes } from "./analytics-rules.js";
import * as q from "./analytics.sql.js";

export const PLATFORM_TIMEZONE = "Asia/Kolkata";

export interface MoneySummary {
  currency: string;
  /** Online payments received in the period. */
  onlineGross: number;
  /** Online refunds completed in the period. */
  onlineRefunded: number;
  onlineNet: number;
  /** MediQ's commission on the online money that was kept (reduced by refunds). */
  commission: number;
  /** What the hospital(s) keep from online payments after commission. */
  hospitalShare: number;
  /** Cash taken at the desk (no commission) and cash handed back. */
  cashCollected: number;
  cashRefunded: number;
  cashNet: number;
}

export const emptyMoney = (currency: string): MoneySummary => ({
  currency,
  onlineGross: 0,
  onlineRefunded: 0,
  onlineNet: 0,
  commission: 0,
  hospitalShare: 0,
  cashCollected: 0,
  cashRefunded: 0,
  cashNet: 0,
});

/** Combines payments received and refunds completed into one summary per currency. */
export function mergeMoney(paidRows: q.PaidRow[], refundRows: q.RefundedRow[]): MoneySummary[] {
  const currencies = new Set([
    ...paidRows.map((r) => r.currency),
    ...refundRows.map((r) => r.currency),
  ]);
  return [...currencies].sort().map((currency) => {
    const p = paidRows.find((r) => r.currency === currency);
    const r = refundRows.find((x) => x.currency === currency);
    const onlineGross = p?.onlineGross ?? 0;
    const onlineRefunded = r?.onlineRefunded ?? 0;
    const commission = p?.commission ?? 0;
    const cashCollected = p?.cashCollected ?? 0;
    const cashRefunded = r?.cashRefunded ?? 0;
    return {
      currency,
      onlineGross,
      onlineRefunded,
      onlineNet: onlineGross - onlineRefunded,
      commission,
      hospitalShare: onlineGross - onlineRefunded - commission,
      cashCollected,
      cashRefunded,
      cashNet: cashCollected - cashRefunded,
    };
  });
}

export interface BookingSummary {
  total: number;
  active: number;
  completed: number;
  cancelled: number;
  noShow: number;
  online: number;
  walkIn: number;
  /** Cancelled share of all bookings made for the period. */
  cancellationRate: number | null;
  /** Of patients whose visit is decided (seen or no-show), the share who did not come. */
  noShowRate: number | null;
}

export function summariseBookings(rows: q.StatusCounts[]): BookingSummary {
  const sum = (f: (r: q.StatusCounts) => boolean) =>
    rows.filter(f).reduce((t, r) => t + r.count, 0);
  const total = sum(() => true);
  const completed = sum((r) => r.status === "COMPLETED");
  const cancelled = sum((r) => r.status === "CANCELLED");
  const noShow = sum((r) => r.status === "NO_SHOW");
  return {
    total,
    active: total - completed - cancelled - noShow,
    completed,
    cancelled,
    noShow,
    online: sum((r) => r.source === "ONLINE"),
    walkIn: sum((r) => r.source === "WALK_IN"),
    cancellationRate: percentOf(cancelled, total),
    noShowRate: percentOf(noShow, completed + noShow),
  };
}

const zeroDay = (date: string): q.DailyRow => ({
  date,
  booked: 0,
  cancelled: 0,
  completed: 0,
  noShow: 0,
});

export interface RangeInput {
  from?: string;
  to?: string;
  days?: number;
}

/** Platform-wide numbers for the super admin. */
export async function adminStats(input: RangeInput & { hospitalId?: string; timezone?: string }) {
  const tz = input.timezone ?? PLATFORM_TIMEZONE;
  if (!isValidTimeZone(tz)) throw AppError.badRequest("Unknown timezone", "INVALID_TIMEZONE");
  const range = resolveRange(input, todayInZone(tz));
  if (input.hospitalId) {
    const hospital = await prisma.hospital.findUnique({
      where: { id: input.hospitalId },
      select: { id: true },
    });
    if (!hospital) throw AppError.notFound("Hospital not found");
  }
  const scope: q.Scope = { from: range.from, to: range.to, tz, hospitalId: input.hospitalId };
  const inHospital = input.hospitalId ? { hospitalId: input.hospitalId } : {};
  const periodStart = zonedTimeToUtc(range.from, 0, tz);
  const periodEnd = zonedTimeToUtc(addDays(range.to, 1), 0, tz);

  const [
    hospitalGroups,
    doctors,
    patients,
    newPatients,
    counts,
    daily,
    paidRows,
    refundRows,
    outstanding,
    top,
  ] = await Promise.all([
    prisma.hospital.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.doctor.count({ where: { isActive: true, ...inHospital } }),
    prisma.user.count({ where: { role: "PATIENT" } }),
    prisma.user.count({
      where: { role: "PATIENT", createdAt: { gte: periodStart, lt: periodEnd } },
    }),
    q.statusCounts(scope),
    q.dailyBookings(scope),
    q.paymentsReceived(scope),
    q.refundsProcessed(scope),
    q.refundsOutstanding(input.hospitalId),
    input.hospitalId ? Promise.resolve([]) : q.topHospitals(scope),
  ]);

  const money = mergeMoney(paidRows, refundRows);
  const primary = [...money].sort((a, b) => b.onlineGross - a.onlineGross)[0]?.currency ?? "INR";
  const [revenueDaily, perHospital] = await Promise.all([
    q.dailyOnlineGross(scope, primary),
    input.hospitalId ? Promise.resolve(new Map()) : q.onlineGrossByHospital(scope, primary),
  ]);
  const revenueByDate = new Map(revenueDaily.map((r) => [r.date, r.amount]));
  const hospitalCount = (status: string) =>
    hospitalGroups.find((g) => g.status === status)?._count._all ?? 0;

  return {
    range: { ...range, timezone: tz },
    hospitalId: input.hospitalId ?? null,
    totals: {
      hospitals: {
        active: hospitalCount("ACTIVE"),
        pending: hospitalCount("PENDING_APPROVAL"),
        blocked: hospitalCount("BLOCKED"),
      },
      activeDoctors: doctors,
      patients,
      newPatients,
    },
    bookings: summariseBookings(counts),
    money,
    /** Refunds owed to patients right now (not limited to the period). */
    refundsOutstanding: outstanding,
    revenueCurrency: primary,
    daily: fillDaily(daily, range, zeroDay).map((d) => ({
      ...d,
      onlineGross: revenueByDate.get(d.date) ?? 0,
    })),
    topHospitals: top.map((h) => ({
      ...h,
      onlineGross: perHospital.get(h.id)?.gross ?? 0,
      commission: perHospital.get(h.id)?.commission ?? 0,
    })),
  };
}

/** One hospital's own numbers, in its own timezone and currency. */
export async function hospitalAnalytics(
  hospitalId: string,
  input: RangeInput & { doctorId?: string },
) {
  const hospital = await prisma.hospital.findUniqueOrThrow({
    where: { id: hospitalId },
    select: { timezone: true, currency: true },
  });
  const tz = hospital.timezone;
  const range = resolveRange(input, todayInZone(tz));
  if (input.doctorId) {
    const own = await prisma.doctor.findFirst({
      where: { id: input.doctorId, hospitalId },
      select: { id: true },
    });
    if (!own) throw AppError.notFound("Doctor not found");
  }
  const scope: q.Scope = {
    from: range.from,
    to: range.to,
    tz,
    hospitalId,
    doctorId: input.doctorId,
  };

  const [
    counts,
    daily,
    paidRows,
    refundRows,
    outstanding,
    doctors,
    kept,
    departments,
    hours,
    times,
  ] = await Promise.all([
    q.statusCounts(scope),
    q.dailyBookings(scope),
    q.paymentsReceived(scope),
    q.refundsProcessed(scope),
    q.refundsOutstanding(hospitalId),
    q.byDoctor(scope),
    q.keptByDoctor(scope, hospital.currency),
    q.byDepartment(scope),
    q.byHour(scope),
    q.serviceTimes(scope),
  ]);

  const bookings = summariseBookings(counts);
  const hourCounts = new Map(hours.map((h) => [h.hour, h.count]));
  return {
    range: { ...range, timezone: tz },
    currency: hospital.currency,
    bookings: { ...bookings, onlineShare: percentOf(bookings.online, bookings.total) },
    /** `commission` is MediQ's fee on online payments; `hospitalShare` is what the hospital keeps. */
    money:
      mergeMoney(paidRows, refundRows).find((m) => m.currency === hospital.currency) ??
      emptyMoney(hospital.currency),
    refundsOutstanding: outstanding,
    service: {
      avgWaitMinutes: roundMinutes(times.wait),
      avgConsultMinutes: roundMinutes(times.consult),
    },
    daily: fillDaily(daily, range, zeroDay),
    byDoctor: doctors.map((d) => ({
      ...d,
      noShowRate: percentOf(d.noShow, d.completed + d.noShow),
      revenueKept: kept.get(d.id) ?? 0,
    })),
    byDepartment: departments,
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hourCounts.get(hour) ?? 0 })),
  };
}
