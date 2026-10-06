import { Router } from "express";
import { bloodLookupLimiter } from "../../middleware/rateLimit.js";
import { idParams } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { paginate, paginationQuery, toSkipTake } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { bankScope } from "./bank-scope.js";
import { lookupQuery, recordDonationSchema, voidDonationSchema } from "./donor.schemas.js";
import {
  listBankDonations,
  lookupDonor,
  recordDonation,
  voidDonation,
} from "./donation.service.js";

/**
 * /blood-bank/donations and /blood-bank/donors: donations exist only because a member of a
 * blood bank's staff recorded them. Nothing is issued to the donor, so there is nothing to
 * redeem: a donation is a dated record that sets the donor's waiting period.
 */
export const donationsRouter = Router();
export const donorLookupRouter = Router();

donorLookupRouter.get("/lookup", bloodLookupLimiter, async (req, res) => {
  const scope = await bankScope(req, { active: true });
  const { phone } = parse(lookupQuery, req.query);
  ok(res, await lookupDonor(scope, phone, requestMeta(req)));
});

donationsRouter.post("/", async (req, res) => {
  const scope = await bankScope(req, { active: true });
  const input = parse(recordDonationSchema, req.body);
  ok(res, await recordDonation(scope, input, requestMeta(req)), 201);
});

donationsRouter.get("/", async (req, res) => {
  const { bloodBankId } = await bankScope(req);
  const q = parse(paginationQuery, req.query);
  const { skip, take } = toSkipTake(q);
  const { items, total } = await listBankDonations(bloodBankId, skip, take);
  ok(res, paginate(items, total, q));
});

donationsRouter.post("/:id/void", async (req, res) => {
  const scope = await bankScope(req, { active: true });
  const { id } = parse(idParams, req.params);
  const { reason } = parse(voidDonationSchema, req.body);
  await voidDonation(scope, id, reason, requestMeta(req));
  ok(res, null);
});
