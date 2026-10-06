import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupFileName,
  parseBackupTime,
  runBackup,
  selectBackupsToDelete,
  targetFromUrl,
} from "./backup-lib.js";

const at = (iso: string) => new Date(iso);
const name = (iso: string) => backupFileName(at(iso));

describe("backup names", () => {
  it("round-trip in UTC and sort by time", () => {
    const d = at("2026-10-06T21:30:05Z");
    expect(backupFileName(d)).toBe("mediq-20261006T213005Z.dump");
    expect(parseBackupTime(backupFileName(d))?.toISOString()).toBe(d.toISOString());
    expect(parseBackupTime("notes.txt")).toBeNull();
    expect(parseBackupTime("mediq-20261006T213005Z.dump.sha256")).toBeNull();
  });
});

describe("retention", () => {
  const now = at("2026-10-06T21:30:00Z"); // a Tuesday
  const r = { keepDays: 14, keepWeeks: 8 };
  const daily = (days: number) =>
    Array.from({ length: days }, (_, i) =>
      name(new Date(now.getTime() - i * 86_400_000).toISOString()),
    );

  it("keeps everything from the last 14 days", () => {
    expect(selectBackupsToDelete(daily(14), now, r)).toEqual([]);
  });

  it("thins older backups to one per week, for 8 weeks, then drops them", () => {
    const names = daily(120);
    const gone = new Set(selectBackupsToDelete(names, now, r));
    const kept = names.filter((n) => !gone.has(n));
    const old = kept.filter((n) => parseBackupTime(n)!.getTime() < now.getTime() - 14 * 86_400_000);
    // At most one per week among the older ones, and none older than the 8-week horizon.
    expect(old.length).toBeLessThanOrEqual(9);
    expect(old.length).toBeGreaterThanOrEqual(7);
    const horizon = now.getTime() - 10 * 7 * 86_400_000;
    expect(old.every((n) => parseBackupTime(n)!.getTime() > horizon)).toBe(true);
    expect(gone.size).toBeGreaterThan(40);
  });

  it("never deletes the newest backup, even when everything is old", () => {
    const names = [name("2025-01-01T00:00:00Z"), name("2025-01-02T00:00:00Z")];
    const gone = selectBackupsToDelete(names, now, r);
    expect(gone).toEqual([names[0]]);
  });

  it("ignores files that are not backups", () => {
    const names = [
      "README.txt",
      "mediq-20261006T000000Z.dump.sha256",
      name("2025-01-01T00:00:00Z"),
    ];
    expect(selectBackupsToDelete(names, now, r)).toEqual([]);
  });
});

describe("connection settings", () => {
  it("come from the URL as environment values, including awkward passwords", () => {
    expect(
      targetFromUrl("postgresql://app:p%40ss%2Fword@db.example.com:6543/mediq?sslmode=require"),
    ).toEqual({
      PGHOST: "db.example.com",
      PGPORT: "6543",
      PGUSER: "app",
      PGPASSWORD: "p@ss/word",
      PGDATABASE: "mediq",
      PGSSLMODE: "require",
    });
    expect(targetFromUrl("postgresql://u:p@h/db").PGPORT).toBe("5432");
  });
});

describe("running a backup", () => {
  let dir: string;
  const URL = "postgresql://app:s3cret-pw@db.example.com:5432/mediq";
  const retention = { keepDays: 14, keepWeeks: 8 };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mediq-backup-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stand-in for pg_dump / pg_restore: a node script driven by FAKE_* environment variables. */
  async function fake(body: string) {
    const file = join(dir, "fake-" + createHash("md5").update(body).digest("hex") + ".mjs");
    await writeFile(file, body);
    return { bin: process.execPath, prefix: [file] };
  }
  const DUMP = `
    import { writeFileSync } from "node:fs";
    if (process.env.FAKE_DUMP === "fail") { console.error("connection refused"); process.exit(2); }
    const i = process.argv.indexOf("--file");
    writeFileSync(process.argv[i + 1], process.env.FAKE_DUMP === "tiny" ? "x" : "PGDMP" + "d".repeat(4000));
    writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), pw: process.env.PGPASSWORD, db: process.env.PGDATABASE }));
  `;
  const RESTORE = `
    if (process.env.FAKE_RESTORE === "fail") { console.error("not a valid archive"); process.exit(1); }
  `;

  it("writes a checksummed dump, passes the password by environment only, and prunes", async () => {
    const log = join(dir, "log.json");
    process.env.FAKE_LOG = log;
    await writeFile(join(dir, name("2025-01-01T00:00:00Z")), "old");
    await writeFile(join(dir, name("2025-01-02T00:00:00Z")), "old");
    const now = at("2026-10-06T21:30:00Z");

    const result = await runBackup({
      databaseUrl: URL,
      dir,
      retention,
      now,
      dump: await fake(DUMP),
      restore: await fake(RESTORE),
    });

    expect(result.file).toBe(join(dir, "mediq-20261006T213000Z.dump"));
    expect(result.bytes).toBeGreaterThan(4000);
    const sidecar = await readFile(result.file + ".sha256", "utf8");
    expect(sidecar).toContain(result.sha256);
    expect(result.deleted.sort()).toEqual(
      [name("2025-01-01T00:00:00Z"), name("2025-01-02T00:00:00Z")].sort(),
    );

    const seen = JSON.parse(await readFile(log, "utf8"));
    expect(seen.pw).toBe("s3cret-pw");
    expect(seen.db).toBe("mediq");
    expect(seen.argv.join(" ")).not.toContain("s3cret-pw"); // never on the command line
    expect(seen.argv).toContain("--format=custom");
    expect(await readdir(dir)).not.toContain("mediq-20261006T213000Z.dump.partial");
  });

  it.each([
    ["the dump program fails", { FAKE_DUMP: "fail" }, /pg_dump failed.*connection refused/],
    ["the dump is empty or truncated", { FAKE_DUMP: "tiny" }, /empty or truncated/],
    ["verification fails", { FAKE_RESTORE: "fail" }, /failed verification.*not a valid archive/],
  ])("leaves no file and keeps older backups when %s", async (_label, vars, message) => {
    process.env.FAKE_LOG = join(dir, "log.json");
    Object.assign(process.env, { FAKE_DUMP: "", FAKE_RESTORE: "", ...vars });
    const previous = name("2026-10-05T21:30:00Z");
    await writeFile(join(dir, previous), "good");
    try {
      await expect(
        runBackup({
          databaseUrl: URL,
          dir,
          retention,
          now: at("2026-10-06T21:30:00Z"),
          dump: await fake(DUMP),
          restore: await fake(RESTORE),
        }),
      ).rejects.toThrow(message);
    } finally {
      process.env.FAKE_DUMP = "";
      process.env.FAKE_RESTORE = "";
    }
    const files = await readdir(dir);
    expect(files).toContain(previous);
    expect(files.filter((f) => f.startsWith("mediq-20261006"))).toEqual([]);
  });

  it("explains a missing pg_dump", async () => {
    await expect(
      runBackup({
        databaseUrl: URL,
        dir,
        retention,
        dump: { bin: "definitely-not-installed-pg-dump" },
      }),
    ).rejects.toThrow(/could not start pg_dump/);
  });
});
