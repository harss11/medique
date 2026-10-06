import { Router } from "express";
import { idParams } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import { bankScope } from "./bank-scope.js";
import { listBankRequests, respondAsBank } from "./request-answers.service.js";
import { respondSchema } from "./request.schemas.js";

/** /blood-bank/requests: open requests this blood bank was alerted to, and its answers. */
export const bankRequestsRouter = Router();

bankRequestsRouter.get("/", async (req, res) => {
  const { bloodBankId } = await bankScope(req);
  ok(res, { items: await listBankRequests(bloodBankId) });
});

bankRequestsRouter.post("/:id/respond", async (req, res) => {
  const scope = await bankScope(req, { active: true });
  const { id } = parse(idParams, req.params);
  const { response } = parse(respondSchema, req.body);
  ok(res, await respondAsBank(scope, id, response, requestMeta(req)));
});
