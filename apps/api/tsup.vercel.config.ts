import { defineConfig } from "tsup";

// Bundles the API into api/index.js, the serverless function Vercel runs.
// Same bundling as tsup.config.ts, so Vercel never runs its own type check.
export default defineConfig({
  entry: { index: "src/vercel.ts" },
  outDir: "api",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: false,
});
