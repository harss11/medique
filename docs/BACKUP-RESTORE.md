# Backups and restore

Patient records are the one thing MediQ cannot recreate. Two independent layers protect them.

| Layer                             | What it is                                                                     | Recovers from                                                                                       | Typical loss (RPO)                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Provider point-in-time restore | Neon (or your host) keeps the database's write history and can rewind it       | A bad deploy, a bad migration, deleted rows, "undo the last hour"                                   | Seconds to minutes. **How far back depends on your Neon plan: check it and write the number here: ____ days** |
| 2. Daily encrypted dump, off-site | `pnpm db:backup` through the `db-backup` workflow, stored in a separate bucket | The provider account being lost, locked or compromised; a mistake noticed after layer 1 has expired | Up to 24 hours                                                                                                |

Targets for the pilot: lose at most **24 hours** of data in the worst case (RPO) and be serving again within **4 hours** (RTO). Both are only true if the restore drill below has been done.

## How the daily backup works

- `.github/workflows/db-backup.yml` runs at 03:00 IST (quiet hours) and can be started by hand (Actions > Daily database backup > Run workflow).
- It runs `pg_dump` (custom format, compressed) against the **direct** connection, checks the file with `pg_restore --list`, refuses empty or truncated dumps, encrypts it with AES-256 (`openssl`, passphrase from the `BACKUP_PASSPHRASE` secret), uploads it to your bucket and checks the uploaded size.
- A failed run makes GitHub email the repository admins. **Make sure those emails reach someone who reads them.** A backup that fails silently is the usual way people discover they have no backup.
- On your own machine or a server cron: `pnpm db:backup` writes `backups/mediq-YYYYMMDDTHHMMSSZ.dump` (plus `.sha256`) and keeps 14 days of daily files and 8 weekly ones (`BACKUP_KEEP_DAYS`, `BACKUP_KEEP_WEEKS`). It needs `pg_dump` and `pg_restore` version 16+ on the PATH.

### One-time bucket setup

1. Create a **private** bucket (AWS S3 in `ap-south-1`, or Cloudflare R2). Turn on versioning and block all public access.
2. Add a lifecycle rule that deletes objects under `mediq/` after **60 days**. The bucket, not the workflow, does the retention for off-site copies.
3. Create an access key that can only `PutObject`/`GetObject`/`ListBucket` on that bucket. Keep a separate, restore-only key offline.
4. Add the secrets listed at the top of the workflow file. Store the **passphrase** in a password manager as well: without it the backups cannot be opened.
5. Run the workflow once by hand and confirm the file appears in the bucket. Then do the restore drill.

## Restore drill (do this before the pilot, then monthly)

A backup you have never restored is a hope, not a backup. The drill takes about 20 minutes and never touches production.

1. Download the newest `mediq-….dump.enc` and `.sha256` from the bucket.
2. Check it and decrypt it:

   ```bash
   sha256sum -c mediq-20261006T213000Z.dump.enc.sha256
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE \
     -in mediq-20261006T213000Z.dump.enc -out mediq-20261006T213000Z.dump
   ```

3. Create an **empty scratch database** (a Neon branch or a local PostgreSQL), never the live one.
4. Restore into it:

   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname "postgresql://USER:PASSWORD@HOST/scratch" mediq-20261006T213000Z.dump
   ```

5. Check it is the real thing: connect and run

   ```sql
   SELECT count(*) FROM "Hospital";
   SELECT count(*) FROM "Appointment";
   SELECT max("createdAt") FROM "Appointment";   -- should be close to the backup time
   SELECT count(*) FROM _prisma_migrations;
   ```

   and, from the repo with `DATABASE_URL` pointing at the scratch database, `pnpm --filter api exec prisma migrate status` should say the database schema is up to date.

6. Write down the date, how long it took and who did it in the pilot checklist. Delete the scratch database and the decrypted dump.

## Restoring for real

1. **Stop the damage first.** Put the API in maintenance (stop the Render service) so nothing writes while you work. Payments that arrive meanwhile are not lost: Razorpay retries webhooks for about a day, and the webhook handler is idempotent.
2. **Small mistake (rows deleted, bad migration):** use layer 1. In Neon, restore to a point just before the mistake as a **new branch**, check it, then point `DATABASE_URL` at the branch (or promote it). Prefer a branch over rewinding in place: you keep the broken state for analysis.
3. **Provider lost or corrupted:** create a new PostgreSQL database, restore the latest daily dump into it (drill steps 1 to 5), run `pnpm db:deploy`, point `DATABASE_URL` at it and start the API.
4. **After any restore:**
   - Appointments booked after the backup are missing. Their payments exist at Razorpay: in the Razorpay dashboard, list payments since the backup time and reconcile each one (refund, or re-create the booking with the hospital).
   - Run the booking engine's consistency check: every confirmed appointment has exactly one seat and a unique token (the integration tests assert this; a spot check is `SELECT "doctorId","appointmentDate","tokenNumber",count(*) FROM "Appointment" WHERE "tokenNumber" IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1;` which must return no rows).
   - Everyone is signed out if you restored an older `tokenVersion` state; that is expected.
   - Tell the affected hospitals what time range may be missing.

## Privacy

- Backups contain patient names, phone numbers and visit reasons. They are encrypted, in a private bucket, and only the people who run the platform should hold the restore key.
- A patient who asks for their account to be erased is anonymised in the live database straight away, but their data stays in backups until those age out (at most 60 days off-site). This is stated in the privacy policy, and a restore must re-apply any erasures made since the backup (keep the audit log of erasure requests).
- Never copy a production dump to a laptop or into a chat. For development, use the seed data.
