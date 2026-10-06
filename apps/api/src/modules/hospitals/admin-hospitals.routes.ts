import { Router } from "express";
import { requireAuth } from "../../middleware/authenticate.js";
import { idParams } from "../../utils/fields.js";
import { ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import {
  approveHospital,
  blockHospital,
  createHospital,
  getHospitalDetail,
  listHospitals,
  resetHospitalCredentials,
  unblockHospital,
  updateHospital,
} from "./admin-hospitals.service.js";
import {
  adminUpdateHospitalSchema,
  blockHospitalSchema,
  createHospitalSchema,
  listHospitalsQuery,
  resetCredentialsSchema,
} from "./hospitals.schemas.js";

/** Mounted at /admin/hospitals behind authenticate() + requireRole("ADMIN"). */
export const adminHospitalsRouter = Router();

adminHospitalsRouter.get("/", async (req, res) => {
  ok(res, await listHospitals(parse(listHospitalsQuery, req.query)));
});

/** Response includes `credentials` (login ID + temporary password) exactly once. */
adminHospitalsRouter.post("/", async (req, res) => {
  const body = parse(createHospitalSchema, req.body);
  ok(res, await createHospital(requireAuth(req), body, requestMeta(req)), 201);
});

adminHospitalsRouter.get("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await getHospitalDetail(id));
});

adminHospitalsRouter.patch("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(adminUpdateHospitalSchema, req.body);
  ok(res, await updateHospital(requireAuth(req), id, body, requestMeta(req)));
});

adminHospitalsRouter.post("/:id/approve", async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await approveHospital(requireAuth(req), id, requestMeta(req)));
});

adminHospitalsRouter.post("/:id/block", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason } = parse(blockHospitalSchema, req.body);
  ok(res, await blockHospital(requireAuth(req), id, reason, requestMeta(req)));
});

adminHospitalsRouter.post("/:id/unblock", async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await unblockHospital(requireAuth(req), id, requestMeta(req)));
});

adminHospitalsRouter.post("/:id/reset-credentials", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { userId } = parse(resetCredentialsSchema, req.body ?? {});
  ok(res, await resetHospitalCredentials(requireAuth(req), id, userId, requestMeta(req)));
});
