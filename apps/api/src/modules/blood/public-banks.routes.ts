import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { queryBool } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginate, paginationQuery } from "../../utils/pagination.js";
import { distanceKm } from "../../utils/geo.js";
import { parse } from "../../utils/validate.js";
import { toPublicBankDto } from "./bank.dto.js";
import { bloodGroupSchema } from "./blood-schemas.js";
import { latitudeSchema, longitudeSchema } from "./bank.schemas.js";

/** /public/blood-banks: verified blood banks only, no login. */
export const publicBloodBanksRouter = Router();

export const bloodBanksQuery = paginationQuery
  .extend({
    city: z.string().trim().max(80).optional(),
    bloodGroup: bloodGroupSchema.optional(),
    /** With bloodGroup: only banks that report at least one unit of it. */
    inStock: queryBool.optional(),
    lat: z.coerce.number().pipe(latitudeSchema).optional(),
    lng: z.coerce.number().pipe(longitudeSchema).optional(),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: "Give both lat and lng",
    path: ["lng"],
  });

const MAX_LISTED = 500;

publicBloodBanksRouter.get("/", async (req, res) => {
  const q = parse(bloodBanksQuery, req.query);
  const where: Prisma.BloodBankWhereInput = {
    status: "ACTIVE",
    ...(q.city ? { city: { equals: q.city, mode: "insensitive" } } : {}),
  };
  const banks = await prisma.bloodBank.findMany({
    where,
    take: MAX_LISTED,
    include: { stock: { select: { bloodGroup: true, units: true, updatedAt: true } } },
  });
  const here = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;
  const now = new Date();
  let items = banks.map((b) => {
    const km =
      here && b.latitude != null && b.longitude != null
        ? Math.round(distanceKm(here, { lat: b.latitude, lng: b.longitude }) * 10) / 10
        : null;
    return toPublicBankDto(b, b.stock, km, now);
  });
  if (q.bloodGroup && q.inStock) {
    items = items.filter(
      (b) => (b.stock.find((s) => s.bloodGroup === q.bloodGroup)?.units ?? 0) > 0,
    );
  }
  items.sort((a, b) =>
    here
      ? (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name),
  );
  const start = (q.page - 1) * q.limit;
  ok(res, { located: !!here, ...paginate(items.slice(start, start + q.limit), items.length, q) });
});

publicBloodBanksRouter.get("/:id", async (req, res) => {
  const { id } = parse(z.object({ id: z.uuid("Invalid id") }), req.params);
  const bank = await prisma.bloodBank.findFirst({
    where: { id, status: "ACTIVE" },
    include: { stock: { select: { bloodGroup: true, units: true, updatedAt: true } } },
  });
  if (!bank) throw AppError.notFound("Blood bank not found");
  ok(res, toPublicBankDto(bank, bank.stock, null));
});
