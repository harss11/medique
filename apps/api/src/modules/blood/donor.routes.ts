import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { ok } from "../../utils/http.js";
import { idParams } from "../../utils/fields.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { availabilitySchema, donorProfileSchema } from "./donor.schemas.js";
import { listDonorRequests, respondAsDonor } from "./request-answers.service.js";
import { respondSchema } from "./request.schemas.js";
import {
  getDonorProfile,
  listMyDonations,
  removeDonorProfile,
  saveDonorProfile,
  setAvailability,
} from "./donor.service.js";

/** /donor: a patient who has chosen to be a blood donor. Always the signed-in patient's own profile. */
export const donorRouter = Router();

donorRouter.use(authenticate(), requireRole("PATIENT"));

donorRouter.get("/profile", async (req, res) => {
  ok(res, { profile: await getDonorProfile(requireAuth(req).userId) });
});

donorRouter.put("/profile", async (req, res) => {
  const input = parse(donorProfileSchema, req.body);
  ok(res, { profile: await saveDonorProfile(requireAuth(req).userId, input, requestMeta(req)) });
});

donorRouter.patch("/availability", async (req, res) => {
  const { isAvailable } = parse(availabilitySchema, req.body);
  ok(res, { profile: await setAvailability(requireAuth(req).userId, isAvailable) });
});

donorRouter.delete("/profile", async (req, res) => {
  await removeDonorProfile(requireAuth(req).userId, requestMeta(req));
  ok(res, null);
});

donorRouter.get("/donations", async (req, res) => {
  ok(res, { items: await listMyDonations(requireAuth(req).userId) });
});

/** Open requests this donor was alerted to. Never shows the requester phone number. */
donorRouter.get("/requests", async (req, res) => {
  ok(res, { items: await listDonorRequests(requireAuth(req).userId) });
});

donorRouter.post("/requests/:id/respond", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { response } = parse(respondSchema, req.body);
  ok(res, await respondAsDonor(requireAuth(req).userId, id, response, requestMeta(req)));
});
