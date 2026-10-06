import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type RequestHandler } from "express";
import helmetImport from "helmet";
import type { HelmetOptions } from "helmet";
import { pinoHttp } from "pino-http";
import { docsEnabled, env } from "./config/env.js";
import { docsRouter } from "./docs/docs-router.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { enforceHttps } from "./middleware/https.js";
import { globalLimiter, webhookLimiter } from "./middleware/rateLimit.js";
import { webhooksRouter } from "./modules/payments/webhook.routes.js";
import { apiRouter } from "./routes.js";
import { AppError, fail, ok } from "./utils/http.js";

// Some TypeScript module settings (e.g. Vercel's build) see helmet as a CJS namespace; this works in both.
type HelmetFn = (options?: HelmetOptions) => RequestHandler;
const helmet: HelmetFn =
  (helmetImport as unknown as { default?: HelmetFn }).default ??
  (helmetImport as unknown as HelmetFn);

const REQUEST_ID_PATTERN = /^[\w-]{8,64}$/;

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // Needed for correct req.ip / req.secure behind Render or a load balancer.
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id =
          typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
    }),
  );

  app.use(enforceHttps);
  // The reference page has its own security headers, so it is mounted before the global ones.
  if (docsEnabled) app.use("/api/docs", docsRouter());
  app.use(
    helmet({
      // One year, sub-domains included: browsers will refuse plain http for this host.
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );
  app.use((_req, res, next) => {
    // The API never needs the camera, microphone or location.
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  });
  app.use(
    cors({
      // Requests without an Origin (curl, server-to-server, native mobile apps) are
      // allowed: CORS only protects browsers. Browser origins must be allow-listed.
      origin: (origin, callback) => {
        if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        callback(new AppError(403, "CORS_NOT_ALLOWED", "Origin not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Client-Type",
        "X-Request-Id",
        "X-Blood-Request-Key",
      ],
      exposedHeaders: ["X-Request-Id", "Retry-After"],
      maxAge: 600,
    }),
  );
  // Provider webhooks need the raw, untouched body to check their signature, so they are
  // mounted before the JSON parser below. A generous limit: Razorpay retries from several IPs.
  app.use("/api/v1/webhooks", webhookLimiter, webhooksRouter);

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  /** Liveness + database check for the hosting platform. */
  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      ok(res, { status: "ok", time: new Date().toISOString() });
    } catch {
      fail(res, 503, { code: "DB_UNAVAILABLE", message: "Database unreachable" });
    }
  });

  app.use(
    "/api/v1",
    // API responses carry personal data and one-time credentials: never cache them.
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    globalLimiter,
    apiRouter,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
