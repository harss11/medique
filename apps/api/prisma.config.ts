import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// The schema lives at the repo root (/prisma) so it stays the single source of truth.
// The Prisma CLI (migrate, studio) uses DIRECT_URL: on Neon that is the non-pooled
// connection string. The running API uses the pooled DATABASE_URL (see src/lib/prisma.ts).
export default defineConfig({
  schema: "../../prisma/schema.prisma",
  migrations: {
    path: "../../prisma/migrations",
    seed: "tsx src/scripts/seed.ts",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
