import { defineConfig } from "tsup";

// Bundles our own source (including the generated Prisma client) into dist/.
// node_modules dependencies stay external and are installed on the server.
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
});
