/**
 * Writes a verified database backup to BACKUP_DIR and prunes old ones.
 *
 *   pnpm db:backup
 *
 * Needs PostgreSQL's client tools (pg_dump and pg_restore, version 16 or newer, at least as
 * new as the server) on the PATH. Use the DIRECT database connection (not a pooled one). Copy
 * the resulting file off the machine: see docs/BACKUP-RESTORE.md.
 */
import { resolve } from "node:path";
import { runBackup } from "./backup-lib.js";

const url = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set BACKUP_DATABASE_URL (or DATABASE_URL).");
  process.exit(1);
}

const int = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

try {
  const result = await runBackup({
    databaseUrl: url,
    dir: resolve(process.env.BACKUP_DIR ?? "backups"),
    retention: { keepDays: int("BACKUP_KEEP_DAYS", 14), keepWeeks: int("BACKUP_KEEP_WEEKS", 8) },
  });
  const mb = (result.bytes / 1024 / 1024).toFixed(2);
  console.warn(
    "Backup written: " +
      result.file +
      " (" +
      mb +
      " MB, sha256 " +
      result.sha256.slice(0, 12) +
      "...)",
  );
  if (result.deleted.length)
    console.warn("Removed " + result.deleted.length + " old backup(s) by the retention rule.");
} catch (err) {
  console.error("BACKUP FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
