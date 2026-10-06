import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests need a real database: `pnpm test:integration`.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    // Unit tests must not need real secrets or a database.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      JWT_ACCESS_SECRET: "test-access-secret-that-is-at-least-32-chars",
      OTP_HMAC_SECRET: "test-otp-secret-that-is-at-least-32-characters",
    },
  },
});
