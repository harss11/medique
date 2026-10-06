import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { dateOnly } from "../../utils/time.js";
import { doctorRatings, noRating } from "../reviews/review.service.js";
import { acceptingBookingsFor } from "../subscriptions/subscription.service.js";
import { comparator, facetCounts, searchTokens, type SearchSort } from "./search-rules.js";

/**
 * Doctor search for patients. The database narrows the doctors by text, place, speciality, gender,
 * language and fee; rating, availability and the sort order are then applied in memory on that
 * bounded set (CANDIDATE_LIMIT), because they depend on reviews and live seats. Beyond the limit
 * the response says `capped`, and the patient is asked to narrow the search.
 */

export const CANDIDATE_LIMIT = 1000;

export interface DoctorSearch {
  q?: string;
  city?: string;
  specialization?: string;
  gender?: "MALE" | "FEMALE" | "OTHER";
  language?: string;
  minRating?: number;
  /** Minor units. */
  maxFee?: number;
  /** Only doctors with a free seat on this local day. */
  availableOn?: string;
  sort: SearchSort;
}

const ACTIVE_DOCTOR = {
  isActive: true,
  department: { isActive: true },
  hospital: { status: "ACTIVE" },
} satisfies Prisma.DoctorWhereInput;

function textWhere(q: string | undefined): Prisma.DoctorWhereInput[] {
  // Every word must appear in the name, speciality, qualification, department, hospital or city.
  return searchTokens(q).map((t) => ({
    OR: [
      { name: { contains: t, mode: "insensitive" } },
      { specialization: { contains: t, mode: "insensitive" } },
      { qualification: { contains: t, mode: "insensitive" } },
      { department: { name: { contains: t, mode: "insensitive" } } },
      { hospital: { name: { contains: t, mode: "insensitive" } } },
      { hospital: { city: { contains: t, mode: "insensitive" } } },
    ],
  }));
}

/** The local calendar day (YYYY-MM-DD) of an instant in a time zone. */
function localDay(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** The earliest bookable seat of each doctor, and (when asked) which doctors have one on a given day. */
async function seatTimes(doctorIds: string[], now: Date, day: string | undefined) {
  if (doctorIds.length === 0) return { next: new Map<string, Date>(), onDay: new Set<string>() };
  const cutoff = new Date(now.getTime() + env.BOOKING_CLOSES_MINUTES_BEFORE * 60_000);
  const nextRows = await prisma.$queryRaw<Array<{ doctorId: string; next: Date }>>`
    SELECT "doctorId"::text AS "doctorId", min("startAt") AS "next"
    FROM "Slot"
    WHERE "doctorId" = ANY(${doctorIds}::uuid[])
      AND status = 'OPEN'
      AND "bookedCount" < capacity
      AND "startAt" > ${cutoff}
    GROUP BY "doctorId"`;
  let onDay = new Set<string>();
  if (day) {
    const dayRows = await prisma.$queryRaw<Array<{ doctorId: string }>>`
      SELECT DISTINCT "doctorId"::text AS "doctorId"
      FROM "Slot"
      WHERE "doctorId" = ANY(${doctorIds}::uuid[])
        AND status = 'OPEN'
        AND "bookedCount" < capacity
        AND "startAt" > ${cutoff}
        AND "date" = ${dateOnly(day)}`;
    onDay = new Set(dayRows.map((r) => r.doctorId));
  }
  return { next: new Map(nextRows.map((r) => [r.doctorId, r.next])), onDay };
}

export async function searchDoctors(s: DoctorSearch, skip: number, take: number) {
  const now = new Date();
  const text = textWhere(s.q);
  const where: Prisma.DoctorWhereInput = {
    ...ACTIVE_DOCTOR,
    AND: text,
    ...(s.city
      ? { hospital: { status: "ACTIVE", city: { equals: s.city, mode: "insensitive" } } }
      : {}),
    ...(s.specialization
      ? { specialization: { equals: s.specialization, mode: "insensitive" } }
      : {}),
    ...(s.gender ? { gender: s.gender } : {}),
    ...(s.language ? { languages: { has: s.language } } : {}),
    ...(s.maxFee !== undefined ? { consultationFee: { lte: s.maxFee } } : {}),
  };

  const [rows, facetRows] = await Promise.all([
    prisma.doctor.findMany({
      where,
      take: CANDIDATE_LIMIT + 1,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        photoUrl: true,
        qualification: true,
        specialization: true,
        experienceYears: true,
        gender: true,
        languages: true,
        consultationFee: true,
        avgConsultMinutes: true,
        department: { select: { id: true, name: true } },
        hospital: {
          select: {
            id: true,
            name: true,
            slug: true,
            city: true,
            state: true,
            currency: true,
            timezone: true,
          },
        },
      },
    }),
    // Filter options come from everything the words match, so a chosen filter never hides the others.
    prisma.doctor.findMany({
      where: { ...ACTIVE_DOCTOR, AND: text },
      take: CANDIDATE_LIMIT,
      select: { specialization: true, languages: true, hospital: { select: { city: true } } },
    }),
  ]);
  const capped = rows.length > CANDIDATE_LIMIT;
  const candidates = capped ? rows.slice(0, CANDIDATE_LIMIT) : rows;

  const ids = candidates.map((d) => d.id);
  const [ratings, seats, accepting] = await Promise.all([
    doctorRatings(ids),
    seatTimes(ids, now, s.availableOn),
    acceptingBookingsFor(prisma, [...new Set(candidates.map((d) => d.hospital.id))], now),
  ]);

  const ranked = candidates
    .map((d) => ({
      d,
      rating: ratings.get(d.id) ?? noRating,
      // A hospital that is not taking online bookings has no seat to offer.
      acceptingBookings: accepting.get(d.hospital.id) ?? true,
      next: accepting.get(d.hospital.id) === false ? null : (seats.next.get(d.id) ?? null),
    }))
    .filter((r) => (s.minRating === undefined ? true : (r.rating.average ?? 0) >= s.minRating))
    .filter((r) => (s.availableOn ? r.acceptingBookings && seats.onDay.has(r.d.id) : true));

  const order = comparator(s.sort);
  const rankable = (r: (typeof ranked)[number]) => ({
    name: r.d.name,
    fee: r.d.consultationFee,
    experienceYears: r.d.experienceYears,
    rating: r.rating,
    next: r.next,
  });
  ranked.sort((a, b) => order(rankable(a), rankable(b)));

  return {
    total: ranked.length,
    capped,
    items: ranked.slice(skip, skip + take).map(({ d, rating, next, acceptingBookings }) => {
      const { hospital, ...doctor } = d;
      return {
        ...doctor,
        rating,
        hospital: {
          id: hospital.id,
          name: hospital.name,
          slug: hospital.slug,
          city: hospital.city,
          state: hospital.state,
          currency: hospital.currency,
          acceptingBookings,
        },
        nextAvailable: next ? { startAt: next, date: localDay(next, hospital.timezone) } : null,
      };
    }),
    facets: {
      specializations: facetCounts(facetRows.map((r) => r.specialization)),
      cities: facetCounts(facetRows.map((r) => r.hospital.city)),
      languages: facetCounts(facetRows.flatMap((r) => r.languages)),
    },
  };
}
