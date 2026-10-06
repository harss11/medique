import { env } from "../../config/env.js";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import {
  distribution,
  reviewEditable,
  reviewWindowOpen,
  reviewerLabel,
  summarise,
} from "./review-rules.js";

/**
 * Reviews. Only the patient who booked a completed visit online can review it, once. The public
 * sees published reviews (first name and initial only); hospitals can report one and the platform
 * admin decides whether to hide it. A hospital can never change or remove a review itself.
 */

export interface ReviewInput {
  rating: number;
  comment: string | null;
}

export async function createReview(
  auth: AuthContext,
  appointmentId: string,
  input: ReviewInput,
  meta: RequestMeta,
) {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, bookedById: auth.userId, source: "ONLINE" },
    select: {
      id: true,
      status: true,
      completedAt: true,
      slotEnd: true,
      hospitalId: true,
      doctorId: true,
      review: { select: { id: true } },
    },
  });
  if (!appt) throw AppError.notFound("Appointment not found");
  if (appt.status !== "COMPLETED") {
    throw AppError.conflict("You can review a visit after you have been seen.", "NOT_COMPLETED");
  }
  if (!reviewWindowOpen(appt.completedAt ?? appt.slotEnd, new Date(), env.REVIEW_WINDOW_DAYS)) {
    throw AppError.conflict(
      `Reviews can be written for ${env.REVIEW_WINDOW_DAYS} days after the visit.`,
      "REVIEW_WINDOW_CLOSED",
    );
  }
  if (appt.review)
    throw AppError.conflict("You have already reviewed this visit.", "ALREADY_REVIEWED");

  try {
    return await prisma.$transaction(async (tx) => {
      const review = await tx.review.create({
        data: {
          appointmentId: appt.id,
          hospitalId: appt.hospitalId,
          doctorId: appt.doctorId,
          userId: auth.userId,
          rating: input.rating,
          comment: input.comment,
        },
      });
      await audit(tx, {
        actor: { userId: auth.userId, role: "PATIENT" },
        action: "review.created",
        entityType: "Review",
        entityId: review.id,
        hospitalId: appt.hospitalId,
        metadata: { rating: input.rating },
        meta,
      });
      return review;
    });
  } catch (err) {
    // Two taps at once: the database's unique key on the appointment decides.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("You have already reviewed this visit.", "ALREADY_REVIEWED");
    }
    throw err;
  }
}

async function ownReview(auth: AuthContext, appointmentId: string) {
  const review = await prisma.review.findFirst({ where: { appointmentId, userId: auth.userId } });
  if (!review) throw AppError.notFound("Review not found");
  return review;
}

export async function updateReview(
  auth: AuthContext,
  appointmentId: string,
  input: ReviewInput,
  meta: RequestMeta,
) {
  const review = await ownReview(auth, appointmentId);
  if (review.hiddenAt) {
    throw AppError.conflict(
      "This review was hidden by MediQ and can no longer be changed.",
      "REVIEW_HIDDEN",
    );
  }
  if (!reviewEditable(review.createdAt, new Date(), env.REVIEW_EDIT_DAYS)) {
    throw AppError.conflict(
      `A review can be changed for ${env.REVIEW_EDIT_DAYS} days after writing it.`,
      "REVIEW_LOCKED",
    );
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.review.update({
      where: { id: review.id },
      data: { rating: input.rating, comment: input.comment },
    });
    await audit(tx, {
      actor: { userId: auth.userId, role: "PATIENT" },
      action: "review.updated",
      entityType: "Review",
      entityId: review.id,
      hospitalId: review.hospitalId,
      before: { rating: review.rating },
      after: { rating: updated.rating },
      meta,
    });
    return updated;
  });
}

/** A patient can always take their own review back. */
export async function deleteReview(auth: AuthContext, appointmentId: string, meta: RequestMeta) {
  const review = await ownReview(auth, appointmentId);
  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { id: review.id } });
    await audit(tx, {
      actor: { userId: auth.userId, role: "PATIENT" },
      action: "review.deleted",
      entityType: "Review",
      entityId: review.id,
      hospitalId: review.hospitalId,
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Ratings shown on public pages
// ---------------------------------------------------------------------------

export type RatingMap = Map<string, { average: number | null; count: number }>;

/** Average and count of published reviews for a set of doctors. */
export async function doctorRatings(doctorIds: string[]): Promise<RatingMap> {
  if (doctorIds.length === 0) return new Map();
  const rows = await prisma.review.groupBy({
    by: ["doctorId"],
    where: { doctorId: { in: doctorIds }, isPublished: true },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return new Map(
    rows.map((r) => [
      r.doctorId,
      {
        average: r._avg.rating === null ? null : Math.round(r._avg.rating * 10) / 10,
        count: r._count._all,
      },
    ]),
  );
}

export async function hospitalRatings(hospitalIds: string[]): Promise<RatingMap> {
  if (hospitalIds.length === 0) return new Map();
  const rows = await prisma.review.groupBy({
    by: ["hospitalId"],
    where: { hospitalId: { in: hospitalIds }, isPublished: true },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return new Map(
    rows.map((r) => [
      r.hospitalId,
      {
        average: r._avg.rating === null ? null : Math.round(r._avg.rating * 10) / 10,
        count: r._count._all,
      },
    ]),
  );
}

export const noRating = { average: null, count: 0 } as const;

/** A page of published reviews for a doctor or a hospital, with the summary and star counts. */
export async function publicReviews(
  where: { doctorId: string } | { hospitalId: string },
  skip: number,
  take: number,
) {
  const base = { ...where, isPublished: true };
  const [rows, all] = await Promise.all([
    prisma.review.findMany({
      where: base,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        rating: true,
        comment: true,
        createdAt: true,
        user: { select: { name: true } },
        doctor: { select: { name: true } },
      },
    }),
    prisma.review.findMany({ where: base, select: { rating: true } }),
  ]);
  const ratings = all.map((r) => r.rating);
  return {
    summary: { ...summarise(ratings), distribution: distribution(ratings) },
    total: ratings.length,
    items: rows.map((r) => ({
      rating: r.rating,
      comment: r.comment,
      reviewer: reviewerLabel(r.user.name),
      doctor: r.doctor.name,
      createdAt: r.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Hospital: see own reviews, report one
// ---------------------------------------------------------------------------

export async function hospitalReviewList(
  hospitalId: string,
  reportedOnly: boolean,
  skip: number,
  take: number,
) {
  const where: Prisma.ReviewWhereInput = {
    hospitalId,
    ...(reportedOnly ? { reportedAt: { not: null } } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        isPublished: true,
        reportedAt: true,
        reportReason: true,
        hiddenReason: true,
        user: { select: { name: true } },
        doctor: { select: { name: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return {
    total,
    items: rows.map(({ user, doctor, ...r }) => ({
      ...r,
      reviewer: reviewerLabel(user.name),
      doctor: doctor.name,
    })),
  };
}

export async function reportReview(
  hospitalId: string,
  actor: { userId: string; role: AuthContext["role"] },
  reviewId: string,
  reason: string,
  meta: RequestMeta,
) {
  await prisma.$transaction(async (tx) => {
    const review = await tx.review.findFirst({ where: { id: reviewId, hospitalId } });
    if (!review) throw AppError.notFound("Review not found");
    if (review.reportedAt)
      throw AppError.conflict("This review was already reported.", "ALREADY_REPORTED");
    await tx.review.update({
      where: { id: reviewId },
      data: { reportedAt: new Date(), reportedById: actor.userId, reportReason: reason },
    });
    await audit(tx, {
      actor,
      action: "review.reported",
      entityType: "Review",
      entityId: reviewId,
      hospitalId,
      metadata: { reason },
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Platform admin: moderation
// ---------------------------------------------------------------------------

export async function adminReviewList(
  status: "reported" | "hidden" | "all",
  skip: number,
  take: number,
) {
  const where: Prisma.ReviewWhereInput =
    status === "reported"
      ? { reportedAt: { not: null }, hiddenAt: null }
      : status === "hidden"
        ? { hiddenAt: { not: null } }
        : {};
  const [rows, total] = await prisma.$transaction([
    prisma.review.findMany({
      where,
      orderBy: [{ reportedAt: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        isPublished: true,
        reportedAt: true,
        reportReason: true,
        hiddenAt: true,
        hiddenReason: true,
        user: { select: { name: true } },
        doctor: { select: { name: true } },
        hospital: { select: { name: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return {
    total,
    items: rows.map(({ user, doctor, hospital, ...r }) => ({
      ...r,
      reviewer: reviewerLabel(user.name),
      doctor: doctor.name,
      hospital: hospital.name,
    })),
  };
}

type Moderation = "hide" | "unhide" | "dismiss";

export async function moderateReview(
  actor: { userId: string; role: AuthContext["role"] },
  reviewId: string,
  action: Moderation,
  reason: string | null,
  meta: RequestMeta,
) {
  await prisma.$transaction(async (tx) => {
    const review = await tx.review.findUnique({ where: { id: reviewId } });
    if (!review) throw AppError.notFound("Review not found");
    if (action === "hide" && review.hiddenAt)
      throw AppError.conflict("Already hidden", "INVALID_STATUS");
    if (action === "unhide" && !review.hiddenAt)
      throw AppError.conflict("Not hidden", "INVALID_STATUS");
    if (action === "dismiss" && !review.reportedAt)
      throw AppError.conflict("Not reported", "INVALID_STATUS");

    const data: Prisma.ReviewUncheckedUpdateInput =
      action === "hide"
        ? {
            isPublished: false,
            hiddenAt: new Date(),
            hiddenReason: reason,
            moderatedById: actor.userId,
          }
        : action === "unhide"
          ? {
              isPublished: true,
              hiddenAt: null,
              hiddenReason: null,
              moderatedById: actor.userId,
              reportedAt: null,
              reportedById: null,
              reportReason: null,
            }
          : {
              reportedAt: null,
              reportedById: null,
              reportReason: null,
              moderatedById: actor.userId,
            };
    await tx.review.update({ where: { id: reviewId }, data });
    await audit(tx, {
      actor,
      action: `review.${action === "hide" ? "hidden" : action === "unhide" ? "unhidden" : "report_dismissed"}`,
      entityType: "Review",
      entityId: reviewId,
      hospitalId: review.hospitalId,
      metadata: reason ? { reason } : undefined,
      meta,
    });
  });
}
