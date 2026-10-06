import { Router } from "express";
import { z } from "zod";
import { localDate } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { parse } from "../../utils/validate.js";
import { SORTS } from "./search-rules.js";
import { searchDoctors } from "./search.service.js";

/** /public/search: find a doctor by words, place, speciality, language, rating, fee and availability. */
export const publicSearchRouter = Router();

const text = (max: number) => z.string().trim().max(max).optional();

export const doctorSearchQuery = paginationQuery.extend({
  q: text(100),
  city: text(100),
  specialization: text(100),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  language: text(40),
  minRating: z.coerce.number().min(1).max(5).optional(),
  /** In minor units of the hospital currency (paise). */
  maxFee: z.coerce.number().int().min(0).max(100_000_000).optional(),
  availableOn: localDate.optional(),
  sort: z.enum(SORTS).default("recommended"),
});

publicSearchRouter.get("/doctors", async (req, res) => {
  const { page, limit, ...search } = parse(doctorSearchQuery, req.query);
  const { skip, take } = toSkipTake({ page, limit });
  const { items, total, capped, facets } = await searchDoctors(search, skip, take);
  ok(res, { ...paginate(items, total, { page, limit }), facets, capped });
});
