import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/authenticate.js";
import { idParams } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { hospitalScope } from "../hospitals/scope.js";
import {
  adminReviewList,
  hospitalReviewList,
  moderateReview,
  reportReview,
} from "./review.service.js";

/** /hospital/reviews: a hospital sees what patients said about it, and can report one to MediQ. */
export const hospitalReviewsRouter = Router();

export const hospitalReviewsQuery = paginationQuery.extend({
  status: z.enum(["all", "reported"]).default("all"),
});
export const reportReviewSchema = z.object({
  reason: z.string().trim().min(5, "Say what is wrong with it").max(300),
});

hospitalReviewsRouter.get("/", async (req, res) => {
  const { hospitalId } = hospitalScope(req);
  const q = parse(hospitalReviewsQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { items, total } = await hospitalReviewList(
    hospitalId,
    q.status === "reported",
    skip,
    take,
  );
  ok(res, paginate(items, total, q));
});

/** The hospital cannot hide or change a review: it can only ask the platform admin to look at it. */
hospitalReviewsRouter.post("/:id/report", async (req, res) => {
  const { hospitalId, actor } = hospitalScope(req);
  const { id } = parse(idParams, req.params);
  const { reason } = parse(reportReviewSchema, req.body);
  await reportReview(hospitalId, actor, id, reason, requestMeta(req));
  ok(res, null);
});

/** /admin/reviews: the platform admin decides about reported reviews. */
export const adminReviewsRouter = Router();

export const adminReviewsQuery = paginationQuery.extend({
  status: z.enum(["reported", "hidden", "all"]).default("reported"),
});
export const hideReviewSchema = z.object({
  reason: z.string().trim().min(5, "Give a reason").max(300),
});

adminReviewsRouter.get("/", async (req, res) => {
  const q = parse(adminReviewsQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { items, total } = await adminReviewList(q.status, skip, take);
  ok(res, paginate(items, total, q));
});

adminReviewsRouter.post("/:id/hide", async (req, res) => {
  const auth = requireAuth(req);
  const { id } = parse(idParams, req.params);
  const { reason } = parse(hideReviewSchema, req.body);
  await moderateReview(
    { userId: auth.userId, role: auth.role },
    id,
    "hide",
    reason,
    requestMeta(req),
  );
  ok(res, null);
});

for (const action of ["unhide", "dismiss"] as const) {
  adminReviewsRouter.post(`/:id/${action}`, async (req, res) => {
    const auth = requireAuth(req);
    const { id } = parse(idParams, req.params);
    await moderateReview(
      { userId: auth.userId, role: auth.role },
      id,
      action,
      null,
      requestMeta(req),
    );
    ok(res, null);
  });
}
