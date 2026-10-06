import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { parse } from "../../utils/validate.js";
import { patientHistory } from "./history.service.js";

/** /patient/history: my past visits across hospitals and family profiles. */
export const historyRouter = Router();

historyRouter.use(authenticate(), requireRole("PATIENT"));

export const historyQuery = paginationQuery.extend({
  scope: z.enum(["visits", "all"]).default("visits"),
  profileId: z.uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

historyRouter.get("/", async (req, res) => {
  const { page, limit, ...filter } = parse(historyQuery, req.query);
  const { skip, take } = toSkipTake({ page, limit });
  const { items, total, summary } = await patientHistory(
    requireAuth(req).userId,
    filter,
    skip,
    take,
  );
  ok(res, { summary, ...paginate(items, total, { page, limit }) });
});
