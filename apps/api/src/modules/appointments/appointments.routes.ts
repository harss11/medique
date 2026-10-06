import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { bookingLimiter } from "../../middleware/rateLimit.js";
import { idParams, nullableText } from "../../utils/fields.js";
import { AppError, ok } from "../../utils/http.js";
import { paginationQuery } from "../../utils/pagination.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import {
  cancelAppointment,
  confirmAppointment,
  getOwnedAppointment,
  listAppointments,
  lockSlot,
  rescheduleAppointment,
} from "./booking.service.js";
import { createPaymentOrder } from "../payments/payments.service.js";
import { generateReceipt } from "../receipts/receipt.service.js";
import { createReview, deleteReview, updateReview } from "../reviews/review.service.js";

/** /appointments — the signed-in patient's own bookings. */
export const appointmentsRouter = Router();

appointmentsRouter.use(authenticate(), requireRole("PATIENT"));

export const lockSchema = z.object({
  slotId: z.uuid("Choose a slot"),
  patientProfileId: z.uuid("Choose who the appointment is for"),
  reasonForVisit: nullableText(300),
});

export const listQuery = paginationQuery.extend({
  scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
});

export const cancelSchema = z.object({ reason: nullableText(300) });
export const rescheduleSchema = z.object({ slotId: z.uuid("Choose a slot") });
export const reviewSchema = z.object({
  rating: z.number().int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"),
  comment: nullableText(500),
});

/** POST /appointments/lock — hold a seat for 5 minutes while the patient pays. */
appointmentsRouter.post("/lock", bookingLimiter, async (req, res) => {
  const body = parse(lockSchema, req.body);
  const appointment = await lockSlot(
    requireAuth(req),
    { ...body, reasonForVisit: body.reasonForVisit ?? null },
    requestMeta(req),
  );
  ok(res, appointment, 201);
});

appointmentsRouter.get("/", async (req, res) => {
  const { scope, ...page } = parse(listQuery, req.query);
  ok(res, await listAppointments(requireAuth(req), scope, page));
});

appointmentsRouter.get("/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await getOwnedAppointment(requireAuth(req), id));
});

/** Cancels a confirmed appointment, or abandons an unpaid hold (frees the seat at once). */
appointmentsRouter.post("/:id/cancel", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason } = parse(cancelSchema, req.body ?? {});
  ok(res, await cancelAppointment(requireAuth(req), id, reason ?? null, requestMeta(req)));
});

appointmentsRouter.post("/:id/reschedule", bookingLimiter, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { slotId } = parse(rescheduleSchema, req.body);
  ok(res, await rescheduleAppointment(requireAuth(req), id, slotId, requestMeta(req)));
});

/**
 * Starts a payment: returns what the browser needs to open Razorpay checkout (or tells it to
 * use the test payment). Safe to call again; it returns the same order. This only STARTS the
 * payment: the booking is confirmed by the verified webhook, never by the browser.
 */
appointmentsRouter.post("/:id/payment-order", bookingLimiter, async (req, res) => {
  const { id } = parse(idParams, req.params);
  ok(res, await createPaymentOrder(requireAuth(req), id));
});

/** PDF receipt of a paid appointment (the patient's own only). */
appointmentsRouter.get("/:id/receipt", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { filename, bytes } = await generateReceipt(requireAuth(req), id);
  res
    .status(200)
    .setHeader("Content-Type", "application/pdf")
    .setHeader("Content-Disposition", `inline; filename="${filename}"`)
    .setHeader("Cache-Control", "no-store")
    .send(Buffer.from(bytes));
});

/**
 * Development only (PAYMENT_MODE=mock): pretends the payment succeeded and runs
 * the same confirmation code the Razorpay webhook will use in Phase 4. Returns
 * 404 in every other mode, so it can't exist in production.
 */
appointmentsRouter.post("/:id/mock-pay", async (req, res) => {
  if (env.PAYMENT_MODE !== "mock") throw AppError.notFound();
  const auth = requireAuth(req);
  const { id } = parse(idParams, req.params);
  await getOwnedAppointment(auth, id); // ownership check
  const { outcome } = await confirmAppointment(
    id,
    { provider: "MOCK", method: "ONLINE" },
    { userId: auth.userId, role: auth.role },
    requestMeta(req),
  );
  if (outcome === "SLOT_LOST") {
    throw AppError.conflict(
      "Your hold expired and the slot was taken. Please pick another.",
      "SLOT_LOST",
    );
  }
  if (outcome === "CANCELLED") {
    throw AppError.conflict("This booking was cancelled.", "INVALID_STATUS");
  }
  if (outcome === "DUPLICATE_PAYMENT") {
    throw AppError.conflict("This booking is already paid.", "ALREADY_PAID");
  }
  ok(res, await getOwnedAppointment(auth, id));
});

/** POST /appointments/:id/review: rate a completed visit (once). Not for walk-ins: they have no account. */
appointmentsRouter.post("/:id/review", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(reviewSchema, req.body);
  await createReview(
    requireAuth(req),
    id,
    { rating: body.rating, comment: body.comment ?? null },
    requestMeta(req),
  );
  ok(res, await getOwnedAppointment(requireAuth(req), id), 201);
});

appointmentsRouter.patch("/:id/review", async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(reviewSchema, req.body);
  await updateReview(
    requireAuth(req),
    id,
    { rating: body.rating, comment: body.comment ?? null },
    requestMeta(req),
  );
  ok(res, await getOwnedAppointment(requireAuth(req), id));
});

appointmentsRouter.delete("/:id/review", async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deleteReview(requireAuth(req), id, requestMeta(req));
  ok(res, await getOwnedAppointment(requireAuth(req), id));
});
