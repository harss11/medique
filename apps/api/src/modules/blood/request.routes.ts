import { Router, type Request } from "express";
import { bloodRequestLimiter } from "../../middleware/rateLimit.js";
import { idParams } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import {
  closeRequest,
  findRequestByKey,
  recoverRequests,
  requesterView,
} from "./request-access.service.js";
import {
  closeRequestSchema,
  createRequestSchema,
  recoverRequestsSchema,
} from "./request.schemas.js";
import { createBloodRequest } from "./request.service.js";

/**
 * /blood/requests: emergency blood requests. Anyone can make one once their phone is proved with
 * a code. The secret key returned at creation (header X-Blood-Request-Key afterwards, never in
 * a URL, which would end up in logs) is the only way back to the request.
 */
export const bloodRequestsRouter = Router();

const keyOf = (req: Request) => req.get("x-blood-request-key") ?? undefined;

bloodRequestsRouter.post("/", bloodRequestLimiter, async (req, res) => {
  const input = parse(createRequestSchema, req.body);
  ok(res, await createBloodRequest(input, requestMeta(req)), 201);
});

// Before "/:id" so that "recover" is not read as an id.
bloodRequestsRouter.post("/recover", bloodRequestLimiter, async (req, res) => {
  const { phone, code } = parse(recoverRequestsSchema, req.body);
  ok(res, { items: await recoverRequests(phone, code, requestMeta(req)) });
});

bloodRequestsRouter.get("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await requesterView(await findRequestByKey(id, keyOf(req))));
});

bloodRequestsRouter.post("/:id/close", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { outcome } = parse(closeRequestSchema, req.body);
  const request = await findRequestByKey(id, keyOf(req));
  ok(res, { request: await closeRequest(request, outcome, requestMeta(req)) });
});
