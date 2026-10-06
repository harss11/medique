import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
import { dateOnly, toLocalDate } from "../../utils/time.js";
import { reviewWindowOpen } from "../reviews/review-rules.js";
import { mine } from "./account.export.js";

/**
 * A patient's history: the visits that already happened, across hospitals and across the family
 * profiles they manage, with a short summary. Read-only; nothing here is shared with anyone else.
 */

/** "visits": seen by the doctor. "all": also visits that were cancelled or missed. */
export type HistoryScope = "visits" | "all";

export interface HistoryFilter {
  scope: HistoryScope;
  profileId?: string;
  year?: number;
}

const PAYMENT_KEPT = ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

export async function patientHistory(userId: string, f: HistoryFilter, skip: number, take: number) {
  if (f.profileId) {
    const own = await prisma.patientProfile.findFirst({
      where: { id: f.profileId, userId },
      select: { id: true },
    });
    if (!own) throw AppError.notFound("Profile not found");
  }

  const where: Prisma.AppointmentWhereInput = {
    ...mine(userId),
    status: { in: f.scope === "visits" ? ["COMPLETED"] : ["COMPLETED", "NO_SHOW", "CANCELLED"] },
    ...(f.profileId ? { patientProfileId: f.profileId } : {}),
    ...(f.year
      ? { appointmentDate: { gte: dateOnly(`${f.year}-01-01`), lte: dateOnly(`${f.year}-12-31`) } }
      : {}),
  };

  const [rows, total, doctors, hospitals, payments] = await Promise.all([
    prisma.appointment.findMany({
      where,
      orderBy: [{ appointmentDate: "desc" }, { slotStart: "desc" }],
      skip,
      take,
      select: {
        id: true,
        status: true,
        source: true,
        appointmentDate: true,
        slotStart: true,
        slotEnd: true,
        completedAt: true,
        reasonForVisit: true,
        feeAmount: true,
        currency: true,
        doctor: { select: { id: true, name: true, specialization: true, photoUrl: true } },
        hospital: { select: { name: true, slug: true, timezone: true } },
        department: { select: { name: true } },
        patientProfile: { select: { id: true, fullName: true } },
        review: { select: { rating: true, hiddenAt: true } },
        payments: { select: { status: true, amount: true, refundedAmount: true } },
      },
    }),
    prisma.appointment.count({ where }),
    prisma.appointment.groupBy({ by: ["doctorId"], where }),
    prisma.appointment.groupBy({ by: ["hospitalId"], where }),
    prisma.payment.groupBy({
      by: ["currency"],
      where: { appointment: where, status: { in: [...PAYMENT_KEPT] } },
      _sum: { amount: true, refundedAmount: true },
    }),
  ]);

  const now = new Date();
  return {
    total,
    summary: {
      visits: total,
      doctors: doctors.length,
      hospitals: hospitals.length,
      // What was paid and kept, after refunds, in each currency.
      spent: payments.map((p) => ({
        currency: p.currency,
        amount: (p._sum.amount ?? 0) - (p._sum.refundedAmount ?? 0),
      })),
    },
    items: rows.map((a) => {
      const paid = a.payments
        .filter((p) => (PAYMENT_KEPT as readonly string[]).includes(p.status))
        .reduce((n, p) => n + p.amount - p.refundedAmount, 0);
      return {
        id: a.id,
        status: a.status,
        source: a.source,
        date: toLocalDate(a.appointmentDate),
        slotStart: a.slotStart,
        reasonForVisit: a.reasonForVisit,
        feeAmount: a.feeAmount,
        paidAmount: paid,
        currency: a.currency,
        doctor: a.doctor,
        hospital: a.hospital,
        department: a.department.name,
        patient: a.patientProfile,
        review: a.review ? { rating: a.review.rating, hidden: a.review.hiddenAt !== null } : null,
        canReview:
          a.status === "COMPLETED" &&
          a.source === "ONLINE" &&
          !a.review &&
          reviewWindowOpen(a.completedAt ?? a.slotEnd, now, env.REVIEW_WINDOW_DAYS),
      };
    }),
  };
}
