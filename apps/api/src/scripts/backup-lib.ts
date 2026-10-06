import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Database backups with pg_dump (custom format: compressed, and restorable table by table).
 * Pure helpers are exported so retention and naming are unit-tested; the runner takes the
 * dump program as a parameter so the flow can be tested without PostgreSQL's tools.
 */

const NAME = /^mediq-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

export function backupFileName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = p(now.getUTCFullYear(), 4) + p(now.getUTCMonth() + 1) + p(now.getUTCDate());
  const time = p(now.getUTCHours()) + p(now.getUTCMinutes()) + p(now.getUTCSeconds());
  return "mediq-" + date + "T" + time + "Z.dump";
}

export function parseBackupTime(name: string): Date | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d, h, mi, s));
}

export interface Retention {
  /** Keep every backup from the last N days. */
  keepDays: number;
  /** Beyond that, keep the first backup of each of the last N weeks (Monday to Sunday, UTC). */
  keepWeeks: number;
}

const DAY = 86_400_000;

/** Monday 00:00 UTC of the week containing `d`. */
function weekStart(d: Date): number {
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}

/**
 * Which backup files to delete. Rules: everything recent is kept; older ones thin out to one
 * per week; the newest backup is never deleted, and files that are not backups are ignored.
 */
export function selectBackupsToDelete(names: string[], now: Date, r: Retention): string[] {
  const backups = names
    .map((name) => ({ name, at: parseBackupTime(name) }))
    .filter((b): b is { name: string; at: Date } => b.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (backups.length === 0) return [];

  const newest = backups[backups.length - 1]!.name;
  const recentFrom = now.getTime() - r.keepDays * DAY;
  const oldestWeek = weekStart(now) - r.keepWeeks * 7 * DAY;
  const weekly = new Set<number>();
  const remove: string[] = [];
  for (const b of backups) {
    if (b.name === newest || b.at.getTime() >= recentFrom) continue;
    const week = weekStart(b.at);
    if (week >= oldestWeek && !weekly.has(week)) {
      weekly.add(week); // the first backup of that week stays
      continue;
    }
    remove.push(b.name);
  }
  return remove;
}

export interface DbTarget {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
  PGSSLMODE?: string;
}

/** Connection settings as environment variables, so the password never appears in a process list. */
export function targetFromUrl(url: string): DbTarget {
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode") ?? undefined;
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
  };
}

interface Finished {
  code: number;
  stderr: string;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface Program {
  bin: string;
  /** Leading arguments (used by tests to run a stand-in script). */
  prefix?: string[];
}

export interface BackupOptions {
  databaseUrl: string;
  dir: string;
  retention: Retention;
  now?: Date;
  dump?: Program;
  restore?: Program;
  /** A dump smaller than this is treated as a failure. */
  minBytes?: number;
}

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
  deleted: string[];
}

/**
 * Dumps, verifies, checksums and prunes. A failed or empty dump is removed and throws, so a
 * bad file can never be mistaken for a backup (and never pushes out a good one).
 */
export async function runBackup(o: BackupOptions): Promise<BackupResult> {
  const now = o.now ?? new Date();
  await mkdir(o.dir, { recursive: true });
  const name = backupFileName(now);
  const final = join(o.dir, name);
  const partial = final + ".partial";
  const env = { ...process.env, ...targetFromUrl(o.databaseUrl) };
  const dump = o.dump ?? { bin: "pg_dump" };
  const restore = o.restore ?? { bin: "pg_restore" };

  const fail = async (message: string): Promise<never> => {
    await rm(partial, { force: true });
    throw new Error(message);
  };

  const dumpArgs = [
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-privileges",
    "--file",
    partial,
  ];
  const made = await run(dump.bin, [...(dump.prefix ?? []), ...dumpArgs], env).catch((err: Error) =>
    fail("could not start pg_dump: " + err.message),
  );
  if (made.code !== 0) await fail("pg_dump failed (exit " + made.code + "): " + made.stderr.trim());

  const size = (await stat(partial).catch(() => null))?.size ?? 0;
  if (size < (o.minBytes ?? 1024))
    await fail("the dump is empty or truncated (" + size + " bytes)");

  // pg_restore --list reads the archive's table of contents: proves the file is a valid dump.
  const listArgs = [...(restore.prefix ?? []), "--list", partial];
  const listed = await run(restore.bin, listArgs, env).catch((err: Error) =>
    fail("could not start pg_restore: " + err.message),
  );
  if (listed.code !== 0) await fail("the dump failed verification: " + listed.stderr.trim());

  await rename(partial, final);
  const digest = await sha256(final);
  await writeFile(final + ".sha256", digest + "  " + name + "\n");

  const deleted = selectBackupsToDelete(await readdir(o.dir), now, o.retention);
  for (const old of deleted) {
    await rm(join(o.dir, old), { force: true });
    await rm(join(o.dir, old + ".sha256"), { force: true });
  }
  return { file: final, bytes: size, sha256: digest, deleted };
}
