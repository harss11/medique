import express, { Router } from "express";
import { ok } from "../../utils/http.js";
import { processRazorpayWebhook } from "./webhook.service.js";

/**
 * /webhooks — called by payment providers, not by browsers.
 * Mounted BEFORE the JSON body parser in app.ts: the signature is computed over the
 * exact bytes Razorpay sent, so the body must arrive untouched as a Buffer.
 */
export const webhooksRouter = Router();

webhooksRouter.post(
  "/razorpay",
  express.raw({ type: () => true, limit: "1mb" }),
  async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await processRazorpayWebhook(body, {
      signature: req.get("x-razorpay-signature"),
      eventId: req.get("x-razorpay-event-id"),
    });
    ok(res, { result });
  },
);
