import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { Prisma } from "../generated/prisma/client.js";
import { captureServerError } from "../lib/sentry.js";
import { AppError, fail } from "../utils/http.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  fail(res, 404, { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` });
};

/**
 * Last stop for every error. Known errors become clean envelopes; anything
 * unexpected is logged with the request id and returned as a generic 500 so we
 * never leak stack traces or SQL to clients.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    if (err.status === 429 && typeof err.details === "object" && err.details !== null) {
      const retry = (err.details as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (retry) res.setHeader("Retry-After", String(retry));
    }
    return fail(res, err.status, { code: err.code, message: err.message, details: err.details });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return fail(res, 409, {
        code: "CONFLICT",
        message: "A record with these details already exists",
      });
    }
    if (err.code === "P2025") {
      return fail(res, 404, { code: "NOT_FOUND", message: "Not found" });
    }
  }

  // multer (file upload) errors
  if (err instanceof multer.MulterError) {
    return err.code === "LIMIT_FILE_SIZE"
      ? fail(res, 413, { code: "FILE_TOO_LARGE", message: "Images must be 5 MB or smaller" })
      : fail(res, 400, {
          code: "INVALID_UPLOAD",
          message: "Upload one image in the expected field",
        });
  }

  // body-parser errors
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") {
    return fail(res, 400, { code: "INVALID_JSON", message: "Request body is not valid JSON" });
  }
  if (type === "entity.too.large") {
    return fail(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });
  }

  req.log.error({ err }, "unhandled error");
  captureServerError(err, {
    requestId: String(req.id),
    userId: req.auth?.userId,
    role: req.auth?.role,
    method: req.method,
    route: req.route?.path ? String(req.baseUrl + req.route.path) : undefined,
  });
  return fail(res, 500, { code: "INTERNAL_ERROR", message: "Something went wrong" });
};
