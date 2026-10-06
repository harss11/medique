import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { bookingLimiter } from "../../middleware/rateLimit.js";
import { idParams, localDate } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { joinWaitlist, leaveWaitlist, listMyWaitlist } from "./waitlist.service.js";

/** /waitlist: the signed-in patient waits for a seat on a fully booked day. */
export const waitlistRouter = Router();

waitlistRouter.use(authenticate(), requireRole("PATIENT"));

export const joinSchema = z.object({
  doctorId: z.uuid("Choose a doctor"),
  date: localDate,
  patientProfileId: z.uuid("Choose who the appointment is for"),
});

export const waitlistQuery = paginationQuery.extend({
  scope: z.enum(["active", "all"]).default("active"),
});

waitlistRouter.get("/", async (req, res) => {
  const q = parse(waitlistQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { items, total } = await listMyWaitlist(requireAuth(req), q.scope, skip, take);
  ok(res, paginate(items, total, q));
});

waitlistRouter.post("/", bookingLimiter, async (req, res) => {
  const body = parse(joinSchema, req.body);
  const id = await joinWaitlist(requireAuth(req), body, requestMeta(req));
  ok(res, { id }, 201);
});

waitlistRouter.delete("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  await leaveWaitlist(requireAuth(req), id, requestMeta(req));
  ok(res, null);
});
