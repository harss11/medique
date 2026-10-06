import pino from "pino";
import { env, isProduction } from "../config/env.js";

/** Structured JSON logs in production, pretty logs locally. Secrets are redacted. */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.currentPassword",
      "*.newPassword",
      "*.passwordHash",
      "*.code",
      "*.refreshToken",
      "*.accessToken",
    ],
    censor: "[redacted]",
  },
  ...(isProduction || env.NODE_ENV === "test"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});
