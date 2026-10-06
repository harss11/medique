import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Aggregate queries for the dashboards. Written as SQL because they group, filter and join
 * far more cheaply in the database than in JavaScript. Every value is a bound parameter.
 * Counts are cast to int and sums to bigint then converted, since the driver returns bigint
 * for COUNT/SUM.
 */

/** Statuses that count as a real booking (not an unpaid hold or an expired one). */
export const REAL_STATUSES = [
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];
/** Payment statuses where money was actually received. */
export const PAID_STATUSES = ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"];

const real = Prisma.sql`a."status"::text IN (${Prisma.join(REAL_STATUSES)})`;
const paid = Prisma.sql`p."status"::text IN (${Prisma.join(PAID_STATUSES)})`;

export interface Scope {
  from: string;
  to: string;
  tz: string;
  hospitalId?: string;
  doctorId?: string;
}

const apptDates = (s: Scope) =>
  Prisma.sql`a."appointmentDate" BETWEEN ${s.from}::date AND ${s.to}::date`;
const apptWho = (s: Scope) =>
  Prisma.sql`${s.hospitalId ? Prisma.sql`AND a."hospitalId" = ${s.hospitalId}::uuid` : Prisma.empty}
             ${s.doctorId ? Prisma.sql`AND a."doctorId" = ${s.doctorId}::uuid` : Prisma.empty}`;
const paidOn = (s: Scope) =>
  Prisma.sql`p."paidAt" IS NOT NULL AND (p."paidAt" AT TIME ZONE ${s.tz})::date BETWEEN ${s.from}::date AND ${s.to}::date`;
const payHospital = (s: Scope) =>
  s.hospitalId ? Prisma.sql`AND p."hospitalId" = ${s.hospitalId}::uuid` : Prisma.empty;

const n = (v: unknown) => Number(v ?? 0);

export interface StatusCounts {
  status: string;
  source: string;
  count: number;
}

export async function statusCounts(s: Scope): Promise<StatusCounts[]> {
  const rows = await prisma.$queryRaw<
    Array<{ status: string; source: string; count: number }>
  >(Prisma.sql`
    SELECT a."status"::text AS status, a."source"::text AS source, COUNT(*)::int AS count
    FROM "Appointment" a
    WHERE ${real} AND ${apptDates(s)} ${apptWho(s)}
    GROUP BY 1, 2`);
  return rows.map((r) => ({ ...r, count: n(r.count) }));
}

export interface DailyRow {
  date: string;
  booked: number;
  cancelled: number;
  completed: number;
  noShow: number;
}

export async function dailyBookings(s: Scope): Promise<DailyRow[]> {
  const rows = await prisma.$queryRaw<DailyRow[]>(Prisma.sql`
    SELECT a."appointmentDate"::text AS date,
      COUNT(*) FILTER (WHERE a."status"::text <> 'CANCELLED')::int AS booked,
      COUNT(*) FILTER (WHERE a."status"::text = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE a."status"::text = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE a."status"::text = 'NO_SHOW')::int AS "noShow"
    FROM "Appointment" a
    WHERE ${real} AND ${apptDates(s)} ${apptWho(s)}
    GROUP BY 1 ORDER BY 1`);
  return rows.map((r) => ({
    date: r.date,
    booked: n(r.booked),
    cancelled: n(r.cancelled),
    completed: n(r.completed),
    noShow: n(r.noShow),
  }));
}

export interface PaidRow {
  currency: string;
  onlineGross: number;
  cashCollected: number;
  commission: number;
}

/** Money received in the period (by the day it was paid), per currency. */
export async function paymentsReceived(s: Scope): Promise<PaidRow[]> {
  const rows = await prisma.$queryRaw<PaidRow[]>(Prisma.sql`
    SELECT p."currency" AS currency,
      COALESCE(SUM(p."amount") FILTER (WHERE p."provider"::text <> 'CASH'), 0)::bigint AS "onlineGross",
      COALESCE(SUM(p."amount") FILTER (WHERE p."provider"::text = 'CASH'), 0)::bigint AS "cashCollected",
      COALESCE(SUM(ROUND(p."commissionAmount" * (p."amount" - p."refundedAmount")::numeric
               / NULLIF(p."amount", 0))) FILTER (WHERE p."provider"::text <> 'CASH'), 0)::bigint AS commission
    FROM "Payment" p
    WHERE ${paid} AND ${paidOn(s)} ${payHospital(s)}
    GROUP BY 1`);
  return rows.map((r) => ({
    currency: r.currency,
    onlineGross: n(r.onlineGross),
    cashCollected: n(r.cashCollected),
    commission: n(r.commission),
  }));
}

export interface RefundedRow {
  currency: string;
  onlineRefunded: number;
  cashRefunded: number;
}

/** Refunds completed in the period (by the day they were processed), per currency. */
export async function refundsProcessed(s: Scope): Promise<RefundedRow[]> {
  const rows = await prisma.$queryRaw<RefundedRow[]>(Prisma.sql`
    SELECT p."currency" AS currency,
      COALESCE(SUM(r."amount") FILTER (WHERE p."provider"::text <> 'CASH'), 0)::bigint AS "onlineRefunded",
      COALESCE(SUM(r."amount") FILTER (WHERE p."provider"::text = 'CASH'), 0)::bigint AS "cashRefunded"
    FROM "Refund" r JOIN "Payment" p ON p."id" = r."paymentId"
    WHERE r."status"::text = 'PROCESSED' AND r."processedAt" IS NOT NULL
      AND (r."processedAt" AT TIME ZONE ${s.tz})::date BETWEEN ${s.from}::date AND ${s.to}::date
      ${payHospital(s)}
    GROUP BY 1`);
  return rows.map((r) => ({
    currency: r.currency,
    onlineRefunded: n(r.onlineRefunded),
    cashRefunded: n(r.cashRefunded),
  }));
}

export interface PendingRefundRow {
  currency: string;
  status: string;
  count: number;
  amount: number;
}

/** Refunds still owed to patients right now (not limited to the period): these need attention. */
export async function refundsOutstanding(hospitalId?: string): Promise<PendingRefundRow[]> {
  const rows = await prisma.$queryRaw<PendingRefundRow[]>(Prisma.sql`
    SELECT p."currency" AS currency, r."status"::text AS status, COUNT(*)::int AS count,
           COALESCE(SUM(r."amount"), 0)::bigint AS amount
    FROM "Refund" r JOIN "Payment" p ON p."id" = r."paymentId"
    WHERE r."status"::text IN ('PENDING', 'FAILED')
      ${hospitalId ? Prisma.sql`AND p."hospitalId" = ${hospitalId}::uuid` : Prisma.empty}
    GROUP BY 1, 2`);
  return rows.map((r) => ({ ...r, count: n(r.count), amount: n(r.amount) }));
}

/** Online money per day in one currency (for the revenue chart). */
export async function dailyOnlineGross(
  s: Scope,
  currency: string,
): Promise<Array<{ date: string; amount: number }>> {
  const rows = await prisma.$queryRaw<Array<{ date: string; amount: bigint }>>(Prisma.sql`
    SELECT (p."paidAt" AT TIME ZONE ${s.tz})::date::text AS date, SUM(p."amount")::bigint AS amount
    FROM "Payment" p
    WHERE ${paid} AND ${paidOn(s)} AND p."currency" = ${currency} AND p."provider"::text <> 'CASH' ${payHospital(s)}
    GROUP BY 1 ORDER BY 1`);
  return rows.map((r) => ({ date: r.date, amount: n(r.amount) }));
}

export interface HospitalRow {
  id: string;
  name: string;
  bookings: number;
}

/** Busiest hospitals by bookings that were not cancelled. */
export async function topHospitals(s: Scope, limit = 10): Promise<HospitalRow[]> {
  const rows = await prisma.$queryRaw<HospitalRow[]>(Prisma.sql`
    SELECT h."id"::text AS id, h."name" AS name, COUNT(*)::int AS bookings
    FROM "Appointment" a JOIN "Hospital" h ON h."id" = a."hospitalId"
    WHERE ${real} AND a."status"::text <> 'CANCELLED' AND ${apptDates(s)}
    GROUP BY h."id", h."name" ORDER BY bookings DESC, h."name" LIMIT ${limit}`);
  return rows.map((r) => ({ ...r, bookings: n(r.bookings) }));
}

/** Online money received per hospital in one currency, for the same period. */
export async function onlineGrossByHospital(
  s: Scope,
  currency: string,
): Promise<Map<string, { gross: number; commission: number }>> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; gross: bigint; commission: bigint }>
  >(Prisma.sql`
    SELECT p."hospitalId"::text AS id, SUM(p."amount")::bigint AS gross,
      COALESCE(SUM(ROUND(p."commissionAmount" * (p."amount" - p."refundedAmount")::numeric
               / NULLIF(p."amount", 0))), 0)::bigint AS commission
    FROM "Payment" p
    WHERE ${paid} AND ${paidOn(s)} AND p."currency" = ${currency} AND p."provider"::text <> 'CASH'
    GROUP BY 1`);
  return new Map(rows.map((r) => [r.id, { gross: n(r.gross), commission: n(r.commission) }]));
}

export interface DoctorRow {
  id: string;
  name: string;
  booked: number;
  completed: number;
  noShow: number;
  cancelled: number;
}

export async function byDoctor(s: Scope): Promise<DoctorRow[]> {
  const rows = await prisma.$queryRaw<DoctorRow[]>(Prisma.sql`
    SELECT d."id"::text AS id, d."name" AS name,
      COUNT(*) FILTER (WHERE a."status"::text <> 'CANCELLED')::int AS booked,
      COUNT(*) FILTER (WHERE a."status"::text = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE a."status"::text = 'NO_SHOW')::int AS "noShow",
      COUNT(*) FILTER (WHERE a."status"::text = 'CANCELLED')::int AS cancelled
    FROM "Appointment" a JOIN "Doctor" d ON d."id" = a."doctorId"
    WHERE ${real} AND ${apptDates(s)} ${apptWho(s)}
    GROUP BY d."id", d."name" ORDER BY booked DESC, d."name" LIMIT 50`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    booked: n(r.booked),
    completed: n(r.completed),
    noShow: n(r.noShow),
    cancelled: n(r.cancelled),
  }));
}

/** Money kept per doctor (paid minus refunded, online and cash), by visit date, in one currency. */
export async function keptByDoctor(s: Scope, currency: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; kept: bigint }>>(Prisma.sql`
    SELECT a."doctorId"::text AS id, SUM(p."amount" - p."refundedAmount")::bigint AS kept
    FROM "Payment" p JOIN "Appointment" a ON a."id" = p."appointmentId"
    WHERE ${paid} AND p."currency" = ${currency} AND ${apptDates(s)} ${apptWho(s)}
    GROUP BY 1`);
  return new Map(rows.map((r) => [r.id, n(r.kept)]));
}

export async function byDepartment(
  s: Scope,
): Promise<Array<{ id: string; name: string; booked: number }>> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; name: string; booked: number }>
  >(Prisma.sql`
    SELECT dp."id"::text AS id, dp."name" AS name,
      COUNT(*) FILTER (WHERE a."status"::text <> 'CANCELLED')::int AS booked
    FROM "Appointment" a JOIN "Department" dp ON dp."id" = a."departmentId"
    WHERE ${real} AND ${apptDates(s)} ${apptWho(s)}
    GROUP BY dp."id", dp."name" ORDER BY booked DESC, dp."name" LIMIT 50`);
  return rows.map((r) => ({ ...r, booked: n(r.booked) }));
}

/** Bookings by hour of the day (in the hospital's timezone): when the clinic is busiest. */
export async function byHour(s: Scope): Promise<Array<{ hour: number; count: number }>> {
  const rows = await prisma.$queryRaw<Array<{ hour: number; count: number }>>(Prisma.sql`
    SELECT EXTRACT(HOUR FROM a."slotStart" AT TIME ZONE ${s.tz})::int AS hour, COUNT(*)::int AS count
    FROM "Appointment" a
    WHERE ${real} AND a."status"::text <> 'CANCELLED' AND ${apptDates(s)} ${apptWho(s)}
    GROUP BY 1 ORDER BY 1`);
  return rows.map((r) => ({ hour: n(r.hour), count: n(r.count) }));
}

/** Average minutes from check-in to the doctor, and with the doctor, for patients seen. */
export async function serviceTimes(
  s: Scope,
): Promise<{ wait: number | null; consult: number | null }> {
  const [row] = await prisma.$queryRaw<
    Array<{ wait: number | null; consult: number | null }>
  >(Prisma.sql`
    SELECT AVG(EXTRACT(EPOCH FROM (a."startedAt" - a."checkedInAt")) / 60)::float8 AS wait,
           AVG(EXTRACT(EPOCH FROM (a."completedAt" - a."startedAt")) / 60)::float8 AS consult
    FROM "Appointment" a
    WHERE a."status"::text = 'COMPLETED' AND a."checkedInAt" IS NOT NULL
      AND a."startedAt" IS NOT NULL AND a."completedAt" IS NOT NULL
      AND a."startedAt" >= a."checkedInAt" AND a."completedAt" >= a."startedAt"
      AND ${apptDates(s)} ${apptWho(s)}`);
  return { wait: row?.wait ?? null, consult: row?.consult ?? null };
}
