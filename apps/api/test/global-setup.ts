/**
 * Vitest global setup for integration tests.
 *
 * Starts a throwaway PostgreSQL server (embedded-postgres: real Postgres, so row
 * locks and unique constraints behave exactly as in production), applies every
 * migration, and points the API at it. Set TEST_DATABASE_URL to use an existing
 * database instead (e.g. a Neon branch); the tests only touch rows they create.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const require = createRequire(import.meta.url);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function migrate(url: string) {
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: "pipe",
  });
}

export default async function setup() {
  const external = process.env.TEST_DATABASE_URL;
  let pg: EmbeddedPostgres | null = null;
  let dir: string | null = null;
  let url: string;

  if (external) {
    url = external;
  } else {
    dir = mkdtempSync(join(tmpdir(), "mediq-it-"));
    const port = await freePort();
    pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      // Deliberately NOT UTC: the app must work on a database in any time zone (many are in
      // Asia/Kolkata), so the tests run against the awkward case on every machine.
      postgresFlags: ["-c", "timezone=Asia/Kolkata"],
      // Always UTF-8 (Windows would default to WIN1252, which cannot store Hindi names).
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("mediq_test");
    url = `postgresql://postgres:postgres@localhost:${port}/mediq_test`;
  }

  migrate(url);
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  // Plenty of connections so concurrent requests really do run in parallel.
  process.env.DATABASE_POOL_MAX = "60";

  return async () => {
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
