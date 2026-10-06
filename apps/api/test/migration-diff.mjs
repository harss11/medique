/**
 * Prints the SQL that separates the migrations in /prisma/migrations from
 * /prisma/schema.prisma, using a throwaway PostgreSQL. No database setup needed.
 *
 *   pnpm db:diff                  print the SQL (empty output = migrations are in sync)
 *   pnpm db:diff --write <name>   write it as a new migration folder
 *   pnpm db:diff --check          exit with code 2 if a migration is missing (for CI)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const require = createRequire(import.meta.url);
const apiDir = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const writeIdx = args.indexOf("--write");
const migrationName = writeIdx >= 0 ? args[writeIdx + 1] : null;
const check = args.includes("--check");

const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const dir = mkdtempSync(join(tmpdir(), "mediq-diff-"));
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: false,
  postgresFlags: ["-c", "timezone=UTC"],
  // Always UTF-8 (Windows would default to WIN1252, which cannot store Hindi names).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
  onError: () => {},
});

let sql;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("diff");
  const url = `postgresql://postgres:postgres@localhost:${port}/diff`;
  const prisma = require.resolve("prisma/build/index.js");
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  const run = (cmd) =>
    execFileSync(process.execPath, [prisma, ...cmd], {
      cwd: apiDir,
      env,
      stdio: "pipe",
    }).toString();

  run(["migrate", "deploy"]);
  sql = run([
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "../../prisma/schema.prisma",
    "--script",
  ]);
} finally {
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
}

const empty = /^\s*(-- This is an empty migration\.)?\s*$/.test(sql);
if (migrationName) {
  if (empty) {
    console.error("Nothing to write: migrations already match the schema.");
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const folder = join(apiDir, "..", "..", "prisma", "migrations", `${stamp}_${migrationName}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "migration.sql"), sql.replace(/\r\n/g, "\n"));
  console.log(`Wrote ${folder}`);
} else if (check) {
  if (!empty) {
    console.error("Schema changes have no migration:\n" + sql);
    process.exit(2);
  }
  console.log("Migrations match the schema.");
} else {
  process.stdout.write(empty ? "-- in sync\n" : sql);
}
