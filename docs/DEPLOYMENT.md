# Deployment guide

How to put MediQ on the internet for the pilot: the web app on Vercel, the API on Render, PostgreSQL on Neon.
Everything here also works on AWS (ECS or Elastic Beanstalk for the API, RDS for the database); only the
dashboards differ.

> **What has and has not been tested.** The API build (`pnpm build` then `node dist/server.js`), the
> migrations, the booking, payment (against a recorded gateway), refund, queue, slip and statistics logic, the
> security headers and the backup script are tested here. **Not tested here:** the hosting dashboards below,
> live Razorpay, MSG91 and Twilio, Cloudinary uploads, Google Maps, Sentry delivery and the backup workflow
> against a real database. Each has a "prove it" step in this guide and in `docs/PILOT-CHECKLIST.md`. Do those
> in a staging copy before real patients.

## 1. The shape of it

```
Patients, reception, doctors, admins (browsers, phones)
        |  https://app.example.in                      https://api.example.in
        v                                               v
   Vercel: Next.js web app  ------------------->  Render: Express API  ---->  Neon PostgreSQL
                                                     |   |   |
                          Razorpay (payments) <------+   |   +--> Sentry (errors, no personal data)
                          MSG91 / Twilio (SMS, WhatsApp) <+
                          Cloudinary (photos, slip scans)
   GitHub Actions: nightly encrypted dump --> private S3/R2 bucket
```

**Use your own domain, with the web app and the API as sub-domains of it** (for example `app.example.in` and
`api.example.in`). This is required, not cosmetic: the sign-in session lives in a cookie set by the API. On the
free `*.vercel.app` and `*.onrender.com` addresses the two sites are "cross-site", browsers (Safari especially)
refuse that cookie, and patients get signed out on every refresh. On sub-domains of one domain it just works.

## 2. Accounts you need

| Service             | Used for                    | Notes                                                                                                 |
| ------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Domain registrar    | `app.` and `api.` addresses | Any; point DNS as the hosts tell you                                                                  |
| Neon                | PostgreSQL                  | Pick the region nearest your users. Paid plan recommended for the pilot: longer point-in-time restore |
| Render              | the API                     | One web service. Choose the region nearest your users (Singapore is closest to India)                 |
| Vercel              | the web app                 | Hobby plans forbid commercial use: use a Pro team for the pilot                                       |
| Razorpay            | payments                    | Complete business KYC early: it takes days. Test keys first, live keys at launch                      |
| MSG91               | SMS in India                | DLT registration (entity, sender ID, templates) takes days to weeks: start now                        |
| Cloudinary          | doctor photos, slip scans   | Free tier is enough for the pilot                                                                     |
| Sentry              | error tracking              | Two projects: one for the API, one for the web app                                                    |
| S3 or Cloudflare R2 | off-site backups            | Private bucket, see `docs/BACKUP-RESTORE.md`                                                          |
| GitHub              | the nightly backup workflow | Private repository                                                                                    |

## 3. Database (Neon)

1. Create a project and a database named `mediq`.
2. Copy the **direct** connection string (the host **without** `-pooler`). Reason: the API sets every
   connection to UTC with a session setting, and a transaction-mode pooler does not keep session settings.
   The API has its own small connection pool, so it does not need Neon's.
3. Write the SSL mode out in full: `...?sslmode=verify-full`. (The `pg` library currently treats `require` as
   `verify-full` and will stop doing so in its next major version, which would silently weaken the check.)
4. Set `DATABASE_POOL_MAX` below the connection limit of your Neon plan divided by the number of API instances
   (5 is a safe start).
5. Turn on the longest history window your plan allows (point-in-time restore).

Migrations run with `pnpm db:deploy` (never `migrate dev`, never the seed: the seed refuses to run in
production). They are forward-only: write every new migration so the **previous** version of the API still works
with it (add columns and tables first, remove old ones only in a later release). Then a rollback of the API is
always safe.

## 4. The API (Render)

Create a **Web Service** from your repository:

| Setting           | Value                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Root directory    | repository root                                                                                                            |
| Runtime           | Node 22 or newer                                                                                                           |
| Build command     | `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter api db:deploy && pnpm --filter api build` |
| Start command     | `pnpm --filter api start`                                                                                                  |
| Health check path | `/health`                                                                                                                  |
| Instances         | **1** (see "Scaling" below)                                                                                                |

`--prod=false` keeps the build independent of `NODE_ENV`: hosts often set `NODE_ENV=production` during the build,
which would otherwise skip the build tools (`tsup`, `prisma`). Running `db:deploy` in the build applies migrations before the new version
starts; the build fails, and the old version keeps running, if a migration fails.

### API environment variables

The API **refuses to start in production** if a required value is missing or unsafe, and prints which one. The
full list with explanations is in `apps/api/.env.example`.

| Variable                                                            | Production value                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                          | `production`                                                                                                                                                                                                                                                            |
| `DATABASE_URL`                                                      | the direct Neon string with `sslmode=verify-full`                                                                                                                                                                                                                       |
| `DATABASE_POOL_MAX`                                                 | `5`                                                                                                                                                                                                                                                                     |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`                              | two different random strings of 48+ characters (`openssl rand -base64 48`)                                                                                                                                                                                              |
| `CORS_ORIGINS`                                                      | `https://app.example.in` (https only)                                                                                                                                                                                                                                   |
| `COOKIE_SECURE`                                                     | `true`                                                                                                                                                                                                                                                                  |
| `COOKIE_DOMAIN`                                                     | `.example.in`                                                                                                                                                                                                                                                           |
| `TRUST_PROXY`                                                       | `1` (Render puts one proxy in front)                                                                                                                                                                                                                                    |
| `PAYMENT_MODE`                                                      | `razorpay` (mock is refused)                                                                                                                                                                                                                                            |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | from Razorpay (live keys at launch)                                                                                                                                                                                                                                     |
| `SMS_PROVIDER`                                                      | `msg91` (or `twilio`); mock is refused                                                                                                                                                                                                                                  |
| `MSG91_AUTH_KEY` and the eleven `MSG91_TEMPLATE_*` ids              | from MSG91 (appointments, login code, and the blood module: verification code, donor alert, blood bank alert, answered, donation thank-you); the exact texts to register are in the README. `MSG91_TEMPLATE_OTP_VERIFY` may stay empty to reuse the login code template |
| `BLOOD_*`, `DONOR_*`                                                | the defaults are sensible (90 and 120 day waiting periods, 3 requests a day per number, at most 100 donors alerted, details removed 90 days after a request closes). Change them only on purpose; see `apps/api/.env.example`                                           |
| `CLOUDINARY_CLOUD_NAME`, `_API_KEY`, `_API_SECRET`                  | required in production                                                                                                                                                                                                                                                  |
| `STORAGE_FOLDER`                                                    | `mediq-prod`                                                                                                                                                                                                                                                            |
| `PRIVACY_POLICY_VERSION`, `TERMS_VERSION`                           | match the dates shown on `/privacy` and `/terms`                                                                                                                                                                                                                        |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`                                  | the API project's DSN, `production`                                                                                                                                                                                                                                     |
| `MSG91_TEMPLATE_WAITLIST_SLOT_OPEN`                                 | DLT id of the waitlist message (the eleventh template; text in the README)                                                                                                                                                                                              |
| `MSG91_HINDI_TEMPLATE_IDS`                                          | optional JSON of DLT ids for the Hindi texts, e.g. `{"booking_confirmed":"..."}`; a message without one is sent in English                                                                                                                                              |
| `WAITLIST_*, REVIEW_*`                                              | defaults are sensible (5 waitlist days per patient, 3 patients told per free seat, a told patient keeps their place 60 minutes; reviews 30 days, editable 7). See `apps/api/.env.example`                                                                               |
| `SUBSCRIPTION_GRACE_DAYS, DEFAULT_PLAN_CODE`                        | `7` and `pilot`: days after a plan ends before online bookings stop, and the plan new hospitals start on (it must exist; the migration creates `pilot`)                                                                                                                 |
| `JOBS_ENABLED`                                                      | `true` on the single instance                                                                                                                                                                                                                                           |
| `LOG_LEVEL`                                                         | `info`                                                                                                                                                                                                                                                                  |
| `DOCS_ENABLED`                                                      | leave unset (the API reference is off in production). Set `true` only if you want it public                                                                                                                                                                             |

Never set `RATE_LIMIT_MULTIPLIER` (the API refuses to start if it is not 1).

### Prove it (staging first)

```
curl https://api.example.in/health          # {"success":true,"data":{"status":"ok",...}}
curl -I https://api.example.in/api/v1/public/hospitals
```

The second must show `strict-transport-security`, `x-content-type-options: nosniff` and `cache-control: no-store`.
Render redirects plain `http://` to https itself; if a plain-http request ever reaches the app it is refused with
`HTTPS_REQUIRED`.

## 5. The web app (Vercel)

1. Import the repository. **Root Directory:** `apps/web`. Framework: Next.js (detected). Vercel installs from the
   repository root and finds the pnpm workspace by itself.
2. Environment variables (these are baked into the build, so change them and **redeploy**):

   | Variable                                                   | Value                                                 |
   | ---------------------------------------------------------- | ----------------------------------------------------- |
   | `NEXT_PUBLIC_API_URL`                                      | `https://api.example.in/api/v1`                       |
   | `NEXT_PUBLIC_SITE_URL`                                     | `https://app.example.in` (printed into every QR code) |
   | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`                          | optional; see the README for restricting the key      |
   | `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | the web project's DSN, `production`                   |

3. Add the domain `app.example.in`.
4. The web app sends a **report-only** Content-Security-Policy (`next.config.ts`). During the first pilot week,
   open the browser console on the main flows (sign in, book, pay, reception, emergency map) and look for
   `Content-Security-Policy-Report-Only` warnings. When a full week of use is clean, rename the header in
   `next.config.ts` to `Content-Security-Policy` to enforce it. Razorpay's checkout and Google Maps are already
   in the allow-list.

## 6. Providers

**Razorpay.** In the dashboard, add a webhook:
URL `https://api.example.in/api/v1/webhooks/razorpay`, a secret (the same value as `RAZORPAY_WEBHOOK_SECRET`),
and these events: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`.
A booking is confirmed **only** by this webhook, so if it is wrong, patients pay and nothing confirms. Prove it
in test mode: pay with a test card, see the ticket appear; then use _Webhooks > Resend_ in the dashboard and
check that nothing happens twice (no second token, no second SMS).

**MSG91.** Register the five message templates exactly as listed in the README (DLT approves the exact text) and
put their ids in the `MSG91_TEMPLATE_*` variables. Prove it: log in with your own phone number and book once.

**Cloudinary.** Create the API key; the API refuses to start in production without it. Prove it: upload a doctor
photo in the hospital panel.

**Sentry.** Create two projects (Node.js and Browser JavaScript), put each DSN in its service. Prove it: in the
API's Render shell (in `apps/api`) run
`node -e "import('@sentry/node').then(s=>{s.init({dsn:process.env.SENTRY_DSN});s.captureMessage('MediQ test');return s.flush(3000)})"`
and check the message arrives. Create an alert rule that emails the on-call person for each new issue.

**Backups.** Follow `docs/BACKUP-RESTORE.md`, then run the restore drill **before** the first real patient.

## 7. The first admin, then hospitals

The seed refuses to run in production, so create the first platform admin with the command-line tool, from your
own computer with the **production** `DATABASE_URL` in the environment (or from the Render shell):

```bash
pnpm --filter api admin:create -- --login your.name --name "Your Full Name"
```

It prints a random temporary password once. Sign in at `https://app.example.in/admin/login`; you must change the
password before anything else works. Blood banks register themselves at `/blood/register-bank` and show up in **Admin > Blood
banks** as "Waiting for verification": check each licence number with the issuing authority before pressing Approve. Until then
the bank is not listed or alerted and cannot record donations. Hospitals: in the admin panel, create each one: that creates the hospital
admin's login with its own temporary password, shown once. Approve the hospital when its details are complete.

## 8. After every deploy: a five-minute smoke test

1. `/health` returns ok.
2. Patient: sign in with a real phone (the OTP SMS arrives), book a slot, pay with a test or small live payment,
   see the token and QR.
3. Reception: check the patient in by code, start and complete from the doctor screen, print a slip.
4. Cancel a booking: the refund appears in Razorpay.
5. The Sentry dashboard shows no new errors, and `/admin` shows today's booking.

## 9. Running it

- **Uptime.** Add a free monitor (UptimeRobot or similar) on `https://api.example.in/health` and
  `https://app.example.in`, alerting to a phone that is answered.
- **Money that needs a human.** The admin dashboard shows _refunds still to reach patients_. A **failed** refund
  that stays for a day means the gateway rejected it: look at the payment in Razorpay and refund manually.
- **Logs.** The API logs JSON with a request id (`X-Request-Id`, also shown in error responses): paste it into
  the log search to see one request's story. Passwords, tokens and OTP codes are never logged.
- **Scaling.** Run **one** API instance for the pilot. Safe against double-booking at any size (that is done by
  the database), but three things are per-instance: the login rate limits and the 2-second queue cache are in
  memory, and background jobs (slot generation, hold release, messages, refunds, reminders, the waitlist) run in the process.
  To run several instances later: set `JOBS_ENABLED=true` on one only, and move the rate limiter to Redis.
- **Rolling back.** Render > the service > _Deploys_ > redeploy the previous one. Safe as long as migrations stay
  additive (section 3). A bad migration is fixed by restoring from point-in-time (see the backup guide), not by
  hand-editing production.
- **Secrets.** Rotate `JWT_ACCESS_SECRET` to sign everyone out at once (an emergency tool). Never put secrets in
  the repository: the `.env` files are ignored by git.

## 10. Known caveats for the pilot

- One Neon region and one API instance: an outage of either takes MediQ down. Acceptable for 5 to 10 hospitals;
  state it to them.
- `pg` 8 is pinned (`^8`). Prisma's transaction handling issues concurrent queries on one connection, which
  `pg` 9 will no longer queue. Do not upgrade `pg` until Prisma's adapter supports it.
- The three `pnpm audit` findings are inside Prisma's own command-line tooling (a config merger and a MySQL
  driver), not code the API runs. Re-run `pnpm audit --prod` before launch and after any Prisma upgrade.
- WhatsApp messages need Twilio and an approved sender; SMS through MSG91 is the tested default.
