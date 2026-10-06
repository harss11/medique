import "dotenv/config";
import { z } from "zod";

/**
 * All configuration comes from environment variables and is validated once at
 * startup. The process refuses to boot with missing or unsafe settings.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    DATABASE_URL: z.url(),
    /** Max connections this API instance opens. Keep (instances x this) under the DB limit. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    OTP_HMAC_SECRET: z.string().min(32, "OTP_HMAC_SECRET must be at least 32 characters"),

    CORS_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((v) =>
        v
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
      ),

    COOKIE_SECURE: z.stringbool().default(false),
    COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
    COOKIE_DOMAIN: z
      .string()
      .optional()
      .transform((v) => v || undefined),

    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    /** Testing knob: multiplies every per-IP rate limit. Must stay 1 in production. */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().min(1).max(1000).default(1),

    /** Error tracking (Sentry). Leave SENTRY_DSN empty to switch it off. */
    SENTRY_DSN: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined)
      .pipe(z.url().optional()),
    SENTRY_ENVIRONMENT: z.string().default("development"),
    /** Share of requests traced for performance (0 = errors only). */
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

    /** Serves the interactive API reference at /api/docs. Off by default in production. */
    DOCS_ENABLED: z.stringbool().optional(),

    SMS_PROVIDER: z.enum(["mock", "msg91", "twilio"]).default("mock"),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

    PRIVACY_POLICY_VERSION: z.string().default("2026-10-06"),
    TERMS_VERSION: z.string().default("2026-10-01"),

    // File storage (doctor photos, slip templates). Uploads fail with 503 until set.
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    /** Top-level folder, so dev/staging/prod files never mix. */
    STORAGE_FOLDER: z.string().default("mediq-dev"),

    // Booking rules
    /** How long a slot stays held while the patient pays. */
    BOOKING_HOLD_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
    /** Online booking closes this long before the slot starts. */
    BOOKING_CLOSES_MINUTES_BEFORE: z.coerce.number().int().min(0).max(1440).default(15),
    /** Patients can cancel or reschedule until this long before the slot starts. */
    CHANGE_CLOSES_MINUTES_BEFORE: z.coerce.number().int().min(0).max(1440).default(60),
    /** How many unpaid holds one patient may have at once (stops slot hoarding). */
    MAX_PENDING_HOLDS_PER_PATIENT: z.coerce.number().int().min(1).max(10).default(3),
    MAX_RESCHEDULES_PER_APPOINTMENT: z.coerce.number().int().min(0).max(10).default(2),
    /**
     * mock: development only, "Pay" confirms instantly through POST /appointments/:id/mock-pay.
     * razorpay: real payments, confirmed only by the webhook (Phase 4).
     */
    PAYMENT_MODE: z.enum(["mock", "razorpay"]).default("mock"),

    // Razorpay (dashboard > Settings > API Keys, and Webhooks)
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /** Secret you type when creating the webhook in the Razorpay dashboard. */
    RAZORPAY_WEBHOOK_SECRET: z.string().min(8).optional(),
    /**
     * Release the held slot as soon as a payment attempt fails (the rule in the brief).
     * A payment that succeeds afterwards still re-takes the seat if it is free, and is
     * refunded automatically if it is not.
     */
    RELEASE_HOLD_ON_PAYMENT_FAILURE: z.stringbool().default(true),
    REFUND_RETRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),

    // Notifications
    /** SMS or WHATSAPP for appointment messages (OTP is always SMS). */
    NOTIFICATION_CHANNEL: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
    REMINDER_HOURS_BEFORE: z.coerce.number().min(0.25).max(48).default(2),
    NOTIFY_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(15),
    MSG91_AUTH_KEY: z.string().optional(),
    /** MSG91 flow (DLT) template ids, one per message. See README for the exact texts. */
    MSG91_TEMPLATE_OTP_LOGIN: z.string().optional(),
    MSG91_TEMPLATE_BOOKING_CONFIRMED: z.string().optional(),
    MSG91_TEMPLATE_APPOINTMENT_REMINDER: z.string().optional(),
    MSG91_TEMPLATE_APPOINTMENT_CANCELLED: z.string().optional(),
    MSG91_TEMPLATE_APPOINTMENT_RESCHEDULED: z.string().optional(),
    /** Verification codes for blood requests and blood bank registration. Falls back to the login code template. */
    MSG91_TEMPLATE_OTP_VERIFY: z.string().optional(),
    MSG91_TEMPLATE_BLOOD_REQUEST_ALERT: z.string().optional(),
    MSG91_TEMPLATE_BLOOD_REQUEST_BANK_ALERT: z.string().optional(),
    MSG91_TEMPLATE_BLOOD_REQUEST_ANSWERED: z.string().optional(),
    MSG91_TEMPLATE_DONATION_RECORDED: z.string().optional(),
    MSG91_TEMPLATE_WAITLIST_SLOT_OPEN: z.string().optional(),
    /**
     * Hindi versions of the messages, as JSON: {"booking_confirmed":"template id", ...}. Indian SMS must use
     * DLT-registered templates, so Hindi needs its own approved texts. A message without a Hindi template id is
     * sent in English.
     */
    MSG91_HINDI_TEMPLATE_IDS: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v?.trim()) return {} as Record<string, string>;
        try {
          const parsed: unknown = JSON.parse(v);
          const ok =
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            Object.values(parsed).every((x) => typeof x === "string");
          if (ok) return parsed as Record<string, string>;
        } catch {
          // reported below
        }
        ctx.addIssue({ code: "custom", message: "must be a JSON object of template names to ids" });
        return z.NEVER;
      }),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    /** Sender number for SMS, e.g. +15005550006. */
    TWILIO_FROM: z.string().optional(),
    /** WhatsApp sender, e.g. +14155238886 (the Twilio sandbox number). */
    TWILIO_WHATSAPP_FROM: z.string().optional(),

    // Reviews
    /** How long after a visit the patient can leave a review, and how long they can still edit it. */
    REVIEW_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    REVIEW_EDIT_DAYS: z.coerce.number().int().min(0).max(60).default(7),

    // Waitlist
    WAITLIST_MAX_ACTIVE_PER_USER: z.coerce.number().int().min(1).max(20).default(5),
    /** Most waiting patients told about one freed seat at a time (more are told only if seats stay free). */
    WAITLIST_NOTIFY_BATCH: z.coerce.number().int().min(1).max(10).default(3),
    WAITLIST_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(900).default(60),
    /** How long a told patient holds their place before the next one in line is told. */
    WAITLIST_NOTICE_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

    // Hospital subscriptions
    /** Days after a paid period ends before a hospital stops taking online bookings. */
    SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
    /** The plan new hospitals start on. */
    DEFAULT_PLAN_CODE: z.string().trim().min(2).max(40).default("pilot"),

    // Blood bank module
    /** Days a donor must wait between donations. Women and anyone who did not state a gender wait the longer time. */
    DONOR_GAP_DAYS_MALE: z.coerce.number().int().min(30).max(365).default(90),
    DONOR_GAP_DAYS_OTHER: z.coerce.number().int().min(30).max(365).default(120),
    DONOR_MIN_AGE: z.coerce.number().int().min(16).max(30).default(18),
    DONOR_MAX_AGE: z.coerce.number().int().min(40).max(80).default(65),
    /** How long a blood request stays open before it closes by itself. */
    BLOOD_REQUEST_TTL_HOURS: z.coerce.number().min(1).max(72).default(24),
    /** Closed requests lose the requester name, number and note after this many days. */
    BLOOD_REQUEST_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(90),
    BLOOD_REQUESTS_PER_PHONE_PER_DAY: z.coerce.number().int().min(1).max(20).default(3),
    /** Most donors alerted by one request (nearest first), and most alerts one donor gets per day. */
    BLOOD_MAX_DONORS_ALERTED: z.coerce.number().int().min(1).max(500).default(100),
    BLOOD_MAX_ALERTS_PER_DONOR_PER_DAY: z.coerce.number().int().min(1).max(10).default(2),
    /** Stock figures older than this are shown as "call to confirm". */
    BLOOD_STOCK_STALE_HOURS: z.coerce.number().min(1).max(168).default(24),

    // Background jobs
    JOBS_ENABLED: z.stringbool().default(true),
    HOLD_RELEASE_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
    /** How many days ahead bookable slots are generated. */
    SLOT_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    SLOT_JOB_INTERVAL_HOURS: z.coerce.number().min(0.1).max(24).default(6),
  })
  .superRefine((env, ctx) => {
    const cloudinary = [
      env.CLOUDINARY_CLOUD_NAME,
      env.CLOUDINARY_API_KEY,
      env.CLOUDINARY_API_SECRET,
    ];
    if (cloudinary.some(Boolean) && !cloudinary.every(Boolean)) {
      ctx.addIssue({
        code: "custom",
        path: ["CLOUDINARY_CLOUD_NAME"],
        message: "set all three CLOUDINARY_* variables, or none",
      });
    }
    const need = (names: Array<keyof typeof env>, why: string) => {
      for (const name of names) {
        if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: `required ${why}` });
      }
    };
    if (env.PAYMENT_MODE === "razorpay") {
      need(
        ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
        "when PAYMENT_MODE=razorpay",
      );
    }
    if (env.SMS_PROVIDER === "msg91") {
      need(
        [
          "MSG91_AUTH_KEY",
          "MSG91_TEMPLATE_OTP_LOGIN",
          "MSG91_TEMPLATE_BOOKING_CONFIRMED",
          "MSG91_TEMPLATE_APPOINTMENT_REMINDER",
          "MSG91_TEMPLATE_APPOINTMENT_CANCELLED",
          "MSG91_TEMPLATE_APPOINTMENT_RESCHEDULED",
          "MSG91_TEMPLATE_BLOOD_REQUEST_ALERT",
          "MSG91_TEMPLATE_BLOOD_REQUEST_BANK_ALERT",
          "MSG91_TEMPLATE_BLOOD_REQUEST_ANSWERED",
          "MSG91_TEMPLATE_DONATION_RECORDED",
          "MSG91_TEMPLATE_WAITLIST_SLOT_OPEN",
        ],
        "when SMS_PROVIDER=msg91",
      );
    }
    if (env.SMS_PROVIDER === "twilio") {
      need(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"], "when SMS_PROVIDER=twilio");
    }
    if (env.NOTIFICATION_CHANNEL === "WHATSAPP" && env.SMS_PROVIDER !== "mock") {
      need(["TWILIO_WHATSAPP_FROM"], "when NOTIFICATION_CHANNEL=WHATSAPP");
      if (env.SMS_PROVIDER !== "twilio") {
        ctx.addIssue({
          code: "custom",
          path: ["NOTIFICATION_CHANNEL"],
          message: "WhatsApp messages need SMS_PROVIDER=twilio",
        });
      }
    }
    if (env.NODE_ENV !== "production") return;
    if (env.PAYMENT_MODE === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_MODE"],
        message: "mock payments are not allowed in production",
      });
    }
    if (!cloudinary.every(Boolean)) {
      ctx.addIssue({
        code: "custom",
        path: ["CLOUDINARY_CLOUD_NAME"],
        message: "file storage must be configured in production",
      });
    }
    if (env.SMS_PROVIDER === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER"],
        message: "mock SMS is not allowed in production",
      });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message: "must be true in production",
      });
    }
    if (env.RATE_LIMIT_MULTIPLIER !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_MULTIPLIER"],
        message: "must be 1 in production",
      });
    }
    if (env.CORS_ORIGINS.some((o) => !o.startsWith("https://"))) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "production origins must be https",
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
/** The API reference is public documentation in development and off in production unless asked for. */
export const docsEnabled = env.DOCS_ENABLED ?? !isProduction;
