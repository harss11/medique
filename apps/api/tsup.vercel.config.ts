import { defineConfig } from "tsup";

// Bundles the API into dist/vercel.js, which api/index.js re-exports as the serverless function.
// Same bundling as tsup.config.ts, so Vercel never runs its own type check.
export default defineConfig({
  entry: { vercel: "src/vercel.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: false,
});
