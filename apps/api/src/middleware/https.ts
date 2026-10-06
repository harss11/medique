import type { RequestHandler } from "express";
import { isProduction } from "../config/env.js";
import { fail } from "../utils/http.js";

/**
 * Production must be HTTPS only. Behind a proxy (Render, ALB) `req.secure`
 * relies on X-Forwarded-Proto, so TRUST_PROXY must be set correctly.
 * /health is exempt because platform health checks hit the container directly.
 */
export const enforceHttps: RequestHandler = (req, res, next) => {
  if (!isProduction || req.secure || req.path === "/health") return next();
  return fail(res, 403, { code: "HTTPS_REQUIRED", message: "HTTPS is required" });
};
