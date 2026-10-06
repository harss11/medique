import { defineConfig } from "vitest/config";

/** Integration tests: real PostgreSQL (see test/global-setup.ts). Run with `pnpm test:integration`. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // One file at a time: tests share one database.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: "test",
      JWT_ACCESS_SECRET: "test-access-secret-that-is-at-least-32-chars",
      OTP_HMAC_SECRET: "test-otp-secret-that-is-at-least-32-characters",
      JOBS_ENABLED: "false",
      PAYMENT_MODE: "mock",
      LOG_LEVEL: "fatal",
      // The malformed-input test sends thousands of requests from one address.
      RATE_LIMIT_MULTIPLIER: "1000",
    },
  },
});
