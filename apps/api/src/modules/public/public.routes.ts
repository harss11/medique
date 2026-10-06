import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { slugSchema } from "../../utils/credentials.js";
import { idParams, localDate } from "../../utils/fields.js";
import { distanceKm } from "../../utils/geo.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { addDays, dateOnly, todayInZone, toLocalDate, zonedTimeToUtc } from "../../utils/time.js";
import { parse } from "../../utils/validate.js";
import { mount } from "../../utils/mount.js";
import { isBookable } from "../appointments/booking-rules.js";
import { publicBloodBanksRouter } from "../blood/public-banks.routes.js";
import {
  doctorRatings,
  hospitalRatings,
  noRating,
  publicReviews,
} from "../reviews/review.service.js";
import { cached, queueSnapshot, yourTokenStatus } from "../queue/queue.service.js";
import { publicSearchRouter } from "../search/search.routes.js";
import { acceptingBookingsFor } from "../subscriptions/subscription.service.js";

/**
 * /public — what a visitor can see without logging in. Only ACTIVE hospitals and
 * active doctors are ever returned, and no internal data (login IDs, commission,
 * QR tokens, registration numbers, emails) leaves through these endpoints.
 */
export const publicRouter = Router();

mount(publicRouter, "/blood-banks", publicBloodBanksRouter);
mount(publicRouter, "/search", publicSearchRouter);

const hospitalSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  logoUrl: true,
  phone: true,
  emergencyPhone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  latitude: true,
  longitude: true,
  timezone: true,
  currency: true,
  refundFullHours: true,
  refundPartialPercent: true,
} satisfies Prisma.HospitalSelect;

const doctorSelect = {
  id: true,
  name: true,
  photoUrl: true,
  qualification: true,
  specialization: true,
  experienceYears: true,
  gender: true,
  languages: true,
  bio: true,
  consultationFee: true,
  avgConsultMinutes: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.DoctorSelect;

const ACTIVE_HOSPITAL = { status: "ACTIVE" } as const;

async function getActiveHospital(slug: string) {
  const hospital = await prisma.hospital.findFirst({
    where: { slug, ...ACTIVE_HOSPITAL },
    select: hospitalSelect,
  });
  if (!hospital) throw AppError.notFound("Hospital not found");
  return hospital;
}

async function getBookableDoctor(id: string) {
  const doctor = await prisma.doctor.findFirst({
    where: { id, isActive: true, department: { isActive: true }, hospital: ACTIVE_HOSPITAL },
    select: { ...doctorSelect, hospital: { select: hospitalSelect } },
  });
  if (!doctor) throw AppError.notFound("Doctor not found");
  return doctor;
}

// ----- hospitals -----

export const hospitalsQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  /** Only hospitals with an active doctor of this speciality. */
  specialization: z.string().trim().max(100).optional(),
  /** "true": only hospitals that publish an emergency number. */
  emergency: z.enum(["true", "false"]).optional(),
});

publicRouter.get("/hospitals", async (req, res) => {
  const q = parse(hospitalsQuery, req.query);
  const where: Prisma.HospitalWhereInput = {
    ...ACTIVE_HOSPITAL,
    city: q.city ? { equals: q.city, mode: "insensitive" } : undefined,
    ...(q.emergency === "true" ? { emergencyPhone: { not: null } } : {}),
    ...(q.specialization
      ? {
          doctors: {
            some: {
              isActive: true,
              department: { isActive: true },
              specialization: { equals: q.specialization, mode: "insensitive" },
            },
          },
        }
      : {}),
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { city: { contains: q.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.hospital.findMany({
      where,
      orderBy: { name: "asc" },
      ...toSkipTake(q),
      select: {
        ...hospitalSelect,
        _count: { select: { doctors: { where: { isActive: true } } } },
      },
    }),
    prisma.hospital.count({ where }),
  ]);
  const ratings = await hospitalRatings(rows.map((h) => h.id));
  const accepting = await acceptingBookingsFor(
    prisma,
    rows.map((h) => h.id),
  );
  const items = rows.map(({ _count, ...h }) => ({
    ...h,
    doctorCount: _count.doctors,
    rating: ratings.get(h.id) ?? noRating,
    acceptingBookings: accepting.get(h.id) ?? true,
  }));
  ok(res, paginate(items, total, q));
});

export const slugParams = z.object({ slug: slugSchema });

/** Hospital page: details plus departments that have at least one active doctor. */
publicRouter.get("/hospitals/:slug", async (req, res) => {
  const { slug } = parse(slugParams, req.params);
  const hospital = await getActiveHospital(slug);
  const departments = await prisma.department.findMany({
    where: { hospitalId: hospital.id, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      _count: { select: { doctors: { where: { isActive: true } } } },
    },
  });
  ok(res, {
    hospital,
    rating: (await hospitalRatings([hospital.id])).get(hospital.id) ?? noRating,
    acceptingBookings: (await acceptingBookingsFor(prisma, [hospital.id])).get(hospital.id) ?? true,
    departments: departments
      .filter((d) => d._count.doctors > 0)
      .map(({ _count, ...d }) => ({ ...d, doctorCount: _count.doctors })),
  });
});

export const doctorsQuery = paginationQuery.extend({
  departmentId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
});

publicRouter.get("/hospitals/:slug/doctors", async (req, res) => {
  const { slug } = parse(slugParams, req.params);
  const q = parse(doctorsQuery, req.query);
  const hospital = await getActiveHospital(slug);
  const where: Prisma.DoctorWhereInput = {
    hospitalId: hospital.id,
    isActive: true,
    department: { isActive: true },
    departmentId: q.departmentId,
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { specialization: { contains: q.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.doctor.findMany({
      where,
      orderBy: { name: "asc" },
      ...toSkipTake(q),
      select: doctorSelect,
    }),
    prisma.doctor.count({ where }),
  ]);
  const ratings = await doctorRatings(items.map((d) => d.id));
  ok(
    res,
    paginate(
      items.map((d) => ({ ...d, rating: ratings.get(d.id) ?? noRating })),
      total,
      q,
    ),
  );
});

// ----- doctors -----

publicRouter.get("/doctors/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const doctor = await getBookableDoctor(id);
  ok(res, {
    ...doctor,
    rating: (await doctorRatings([id])).get(id) ?? noRating,
    acceptingBookings:
      (await acceptingBookingsFor(prisma, [doctor.hospital.id])).get(doctor.hospital.id) ?? true,
  });
});

/** Published reviews of a doctor: first name and initial only, newest first. */
publicRouter.get("/doctors/:id/reviews", async (req, res) => {
  const { id } = parse(idParams, req.params);
  await getBookableDoctor(id);
  const q = parse(paginationQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { summary, total, items } = await publicReviews({ doctorId: id }, skip, take);
  ok(res, { summary, ...paginate(items, total, q) });
});

/** Published reviews across a hospital. */
publicRouter.get("/hospitals/:slug/reviews", async (req, res) => {
  const { slug } = parse(slugParams, req.params);
  const hospital = await getActiveHospital(slug);
  const q = parse(paginationQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { summary, total, items } = await publicReviews({ hospitalId: hospital.id }, skip, take);
  ok(res, { summary, ...paginate(items, total, q) });
});

/**
 * Which days in the booking window still have a free slot, for the date picker, and which days
 * are fully booked (the waitlist can be joined for those). A slot counts as free while
 * bookedCount < capacity (held seats count as taken).
 */
publicRouter.get("/doctors/:id/availability", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const doctor = await getBookableDoctor(id);
  const tz = doctor.hospital.timezone;
  const now = new Date();
  const today = todayInZone(tz, now);
  const windowEnd = addDays(today, env.SLOT_WINDOW_DAYS);
  // A hospital that is not taking online bookings shows no days to pick.
  const acceptingBookings =
    (await acceptingBookingsFor(prisma, [doctor.hospital.id])).get(doctor.hospital.id) ?? true;
  if (!acceptingBookings) {
    ok(res, { timezone: tz, today, dates: [], fullDates: [], acceptingBookings });
    return;
  }

  const slots = await prisma.slot.findMany({
    where: {
      doctorId: id,
      status: "OPEN",
      startAt: { gt: now, lt: zonedTimeToUtc(windowEnd, 0, tz) },
    },
    select: { date: true, startAt: true, capacity: true, bookedCount: true },
  });
  const perDay = new Map<string, number>();
  const fullDays = new Set<string>();
  for (const s of slots) {
    if (!isBookable(s.startAt, now)) continue;
    const d = toLocalDate(s.date);
    if (s.bookedCount < s.capacity) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    else fullDays.add(d);
  }
  const dates = [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, openSlots]) => ({ date, openSlots }));
  // Days with slots where every seat is taken: a patient can join the waitlist for these.
  const fullDates = [...fullDays].filter((d) => !perDay.has(d)).sort();
  ok(res, { timezone: tz, today, dates, fullDates, acceptingBookings });
});

export const slotsQuery = z.object({ date: localDate });

/** Slots on one day. Full slots are listed (greyed out); blocked and closed ones are not. */
publicRouter.get("/doctors/:id/slots", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { date } = parse(slotsQuery, req.query);
  const doctor = await getBookableDoctor(id);
  const now = new Date();

  const rows = await prisma.slot.findMany({
    where: { doctorId: id, date: dateOnly(date), status: "OPEN", startAt: { gt: now } },
    orderBy: { startAt: "asc" },
    select: { id: true, startAt: true, endAt: true, capacity: true, bookedCount: true },
  });
  const items = rows
    .filter((s) => isBookable(s.startAt, now))
    .map((s) => {
      const remaining = Math.max(0, s.capacity - s.bookedCount);
      return { id: s.id, startAt: s.startAt, endAt: s.endAt, remaining, available: remaining > 0 };
    });
  ok(res, { timezone: doctor.hospital.timezone, date, items });
});

/** One slot with its doctor and hospital: what the booking page shows before the patient commits. */
publicRouter.get("/slots/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const slot = await prisma.slot.findFirst({
    where: {
      id,
      status: "OPEN",
      doctor: { isActive: true, department: { isActive: true } },
      hospital: ACTIVE_HOSPITAL,
    },
    select: {
      id: true,
      date: true,
      startAt: true,
      endAt: true,
      capacity: true,
      bookedCount: true,
      doctor: { select: { ...doctorSelect, hospital: { select: hospitalSelect } } },
    },
  });
  const now = new Date();
  if (!slot || !isBookable(slot.startAt, now)) {
    throw AppError.notFound("This slot is no longer available", "SLOT_UNAVAILABLE");
  }
  const { doctor, date, capacity, bookedCount, ...rest } = slot;
  const remaining = Math.max(0, capacity - bookedCount);
  ok(res, {
    slot: { ...rest, date: toLocalDate(date), remaining, available: remaining > 0 },
    doctor,
  });
});

// ---------------------------------------------------------------------------
// Live queue (the page a doctor's QR code opens): numbers only, never names
// ---------------------------------------------------------------------------

export const queueParams = z.object({
  token: z
    .string()
    .min(10)
    .max(64)
    .regex(/^[\w-]+$/),
});
export const queueQuery = z.object({
  token: z.coerce.number().int().min(1).max(100_000).optional(),
});

publicRouter.get("/queue/:token", async (req, res) => {
  const { token: qrToken } = parse(queueParams, req.params);
  const { token: yourToken } = parse(queueQuery, req.query);
  const doctor = await prisma.doctor.findFirst({
    where: { qrToken, isActive: true, hospital: ACTIVE_HOSPITAL },
    select: {
      id: true,
      name: true,
      avgConsultMinutes: true,
      department: { select: { name: true } },
      hospital: { select: { name: true, slug: true, timezone: true } },
    },
  });
  if (!doctor) throw AppError.notFound("This queue link isn't valid", "QUEUE_NOT_FOUND");

  const date = todayInZone(doctor.hospital.timezone);
  const snapshot = await cached(`snapshot:${doctor.id}:${date}`, () =>
    queueSnapshot(doctor.id, date, doctor.avgConsultMinutes),
  );
  const your = yourToken
    ? await cached(`token:${doctor.id}:${date}:${yourToken}`, () =>
        yourTokenStatus(doctor.id, date, yourToken, doctor.avgConsultMinutes),
      )
    : null;
  ok(res, {
    doctor: { name: doctor.name, department: doctor.department.name },
    hospital: { name: doctor.hospital.name, slug: doctor.hospital.slug },
    ...snapshot,
    yourToken: your,
  });
});

// ---------------------------------------------------------------------------
// Emergency finder: no login, nothing to pay
// ---------------------------------------------------------------------------

export const emergencyQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    city: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(30).default(15),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "Give both lat and lng",
    path: ["lng"],
  });

const BEDS_STALE_MS = 24 * 3_600_000;

/**
 * Open hospitals with their emergency number and bed availability, nearest first when the
 * caller's location is known. Always returns something useful: with no location the list is
 * alphabetical, and a hospital with no coordinates is listed last rather than dropped.
 */
publicRouter.get("/emergency", async (req, res) => {
  const q = parse(emergencyQuery, req.query);
  const rows = await prisma.hospital.findMany({
    where: {
      ...ACTIVE_HOSPITAL,
      ...(q.city ? { city: { equals: q.city, mode: "insensitive" } } : {}),
    },
    take: 500,
    select: {
      id: true,
      name: true,
      slug: true,
      city: true,
      state: true,
      addressLine1: true,
      phone: true,
      emergencyPhone: true,
      totalBeds: true,
      availableBeds: true,
      bedsUpdatedAt: true,
      latitude: true,
      longitude: true,
    },
  });

  const here = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;
  const now = Date.now();
  const items = rows
    .map((h) => {
      const km =
        here && h.latitude != null && h.longitude != null
          ? distanceKm(here, { lat: h.latitude, lng: h.longitude })
          : null;
      return {
        id: h.id,
        name: h.name,
        slug: h.slug,
        city: h.city,
        state: h.state,
        addressLine1: h.addressLine1,
        latitude: h.latitude,
        longitude: h.longitude,
        distanceKm: km === null ? null : Math.round(km * 10) / 10,
        // The emergency line if there is one, otherwise the main number.
        callNumber: h.emergencyPhone ?? h.phone,
        hasEmergencyLine: !!h.emergencyPhone,
        totalBeds: h.totalBeds,
        availableBeds: h.availableBeds,
        bedsUpdatedAt: h.bedsUpdatedAt,
        /** Bed counts older than a day should be treated as a guess. */
        bedsStale: !h.bedsUpdatedAt || now - h.bedsUpdatedAt.getTime() > BEDS_STALE_MS,
      };
    })
    .sort((a, b) =>
      here
        ? (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
    )
    .slice(0, q.limit);
  ok(res, { located: !!here, items });
});
