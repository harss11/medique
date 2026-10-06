import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { sms } from "../../services/sms/index.js";
import { formatDateShort, formatTimeShort } from "../../utils/time.js";
import {
  isMessageTemplate,
  pickVariables,
  refundSentence,
  renderBody,
  type AppointmentTemplate,
  type BloodTemplate,
  type WaitlistTemplate,
  type RefundNote,
  type TemplateVars,
} from "./templates.js";
import { DEFAULT_LANGUAGE, toLanguage, type Language } from "../../utils/language.js";

/**
 * Messages go through an outbox table (NotificationLog):
 *
 *  1. `enqueueAppointmentMessage` inserts a row in the SAME transaction as the
 *     event (confirmation, cancellation, ...), so a message is never lost and
 *     never sent for something that rolled back.
 *  2. `dispatchNotifications` claims due rows (FOR UPDATE SKIP LOCKED, so several
 *     API instances can run it), sends them, and records the result.
 *  3. Failures are retried with a growing delay, up to MAX_ATTEMPTS.
 *
 * The unique key (appointment, template, channel) makes each message exactly-once,
 * however many times a job runs or an event is replayed.
 */

export const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 120;

/**
 * Queues one message for the patient. Online bookings go to the phone they signed in with; a
 * walk-in booked at the desk goes to the phone given at the desk (the receptionist's own
 * number must never receive it). The text is in the patient's chosen language (a walk-in has no
 * account and gets English). `refund` fills the refund sentence of a cancellation message.
 * Returns false if it was already queued or there is no phone.
 */
export async function enqueueAppointmentMessage(
  db: DbClient,
  appointmentId: string,
  template: AppointmentTemplate,
  extra: TemplateVars = {},
  refund?: RefundNote | null,
): Promise<boolean> {
  const a = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      source: true,
      slotStart: true,
      tokenNumber: true,
      bookedBy: { select: { id: true, phone: true, language: true } },
      doctor: { select: { name: true } },
      hospital: { select: { name: true, timezone: true } },
      patientProfile: { select: { fullName: true, phone: true } },
    },
  });
  if (!a) return false;
  const walkIn = a.source === "WALK_IN";
  const phone = walkIn ? a.patientProfile.phone : a.bookedBy.phone;
  if (!phone) return false;

  const language = walkIn ? DEFAULT_LANGUAGE : toLanguage(a.bookedBy.language);
  const vars: TemplateVars = {
    name: a.patientProfile.fullName,
    doctor: a.doctor.name,
    hospital: a.hospital.name,
    date: formatDateShort(a.slotStart, a.hospital.timezone),
    time: formatTimeShort(a.slotStart, a.hospital.timezone),
    token: a.tokenNumber != null ? String(a.tokenNumber) : "",
    ...(refund !== undefined ? { refund: refundSentence(refund, language) } : {}),
    ...extra,
  };
  const { count } = await db.notificationLog.createMany({
    data: [
      {
        // A walk-in has no account; the booker here is the receptionist, not the recipient.
        userId: walkIn ? null : a.bookedBy.id,
        appointmentId,
        channel: env.NOTIFICATION_CHANNEL,
        provider: sms.name,
        to: phone,
        template,
        templateVars: vars,
        language,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

export interface GroupMessage {
  /** Messages that belong together ("blood-request:<id>"): each recipient gets each template once. */
  groupKey: string;
  to: string;
  userId?: string | null;
  template: BloodTemplate | WaitlistTemplate;
  vars: TemplateVars;
  /** Overrides the recipient's own choice. Without it a known user gets their language, anyone else English. */
  language?: Language;
}

/**
 * Queues messages that are not about an appointment (blood requests, donations, the waitlist). Call it with
 * the transaction client so the messages commit with the event. Each (group, template, phone)
 * is queued once, however often this runs. Always SMS: these are urgent and short.
 */
export async function enqueueGroupMessages(
  db: DbClient,
  messages: GroupMessage[],
): Promise<number> {
  if (messages.length === 0) return 0;
  const userIds = [...new Set(messages.flatMap((m) => (m.userId ? [m.userId] : [])))];
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, language: true },
      })
    : [];
  const languageOf = new Map(users.map((u) => [u.id, toLanguage(u.language)]));
  const { count } = await db.notificationLog.createMany({
    data: messages.map((m) => ({
      language:
        m.language ??
        (m.userId ? (languageOf.get(m.userId) ?? DEFAULT_LANGUAGE) : DEFAULT_LANGUAGE),
      userId: m.userId ?? null,
      groupKey: m.groupKey,
      channel: "SMS" as const,
      provider: sms.name,
      to: m.to,
      template: m.template,
      templateVars: m.vars,
    })),
    skipDuplicates: true,
  });
  return count;
}

interface ClaimedRow {
  id: string;
  to: string;
  template: string;
  channel: "SMS" | "WHATSAPP";
  templateVars: TemplateVars | null;
  language: string;
  attempts: number;
}

/** Sends due messages. Returns how many were sent and how many failed this round. */
export async function dispatchNotifications(limit = 50): Promise<{ sent: number; failed: number }> {
  // Claim and lease in one statement: another instance skips these rows for LEASE_SECONDS.
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "NotificationLog"
    SET attempts = attempts + 1,
        "nextAttemptAt" = now() + ${LEASE_SECONDS}::float8 * interval '1 second'
    WHERE id IN (
      SELECT id FROM "NotificationLog"
      WHERE status IN ('QUEUED', 'FAILED')
        AND attempts < ${MAX_ATTEMPTS}
        AND ("appointmentId" IS NOT NULL OR "groupKey" IS NOT NULL)
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text AS id, "to", template, channel::text AS channel, "templateVars", language, attempts`;

  let sent = 0;
  let failed = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + CONCURRENCY).map(async (row) => {
        try {
          if (!isMessageTemplate(row.template)) throw new Error(`unknown template ${row.template}`);
          const vars = row.templateVars ?? {};
          const language = toLanguage(row.language);
          const result = await sms.send({
            to: row.to,
            template: row.template,
            channel: row.channel,
            language,
            body: renderBody(row.template, vars, language),
            variables: pickVariables(row.template, vars),
          });
          await prisma.notificationLog.update({
            where: { id: row.id },
            data: {
              status: "SENT",
              sentAt: new Date(),
              providerMessageId: result.providerMessageId ?? null,
              error: null,
              nextAttemptAt: null,
            },
          });
          sent++;
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : "unknown error";
          logger.warn(
            {
              notificationId: row.id,
              template: row.template,
              attempts: row.attempts,
              err: message,
            },
            "message not sent",
          );
          await prisma.notificationLog.update({
            where: { id: row.id },
            data: {
              status: "FAILED",
              error: message.slice(0, 500),
              // Back off: 2, 4, 6, 8 minutes. After the last attempt it stays FAILED for good.
              nextAttemptAt:
                row.attempts >= MAX_ATTEMPTS
                  ? null
                  : new Date(Date.now() + row.attempts * 2 * 60_000),
            },
          });
        }
      }),
    );
  }
  return { sent, failed };
}

/**
 * Queues the reminder for confirmed appointments that start within
 * REMINDER_HOURS_BEFORE. Bookings made inside that window are skipped: the
 * confirmation message just went out. Safe to run as often as you like.
 */
export async function enqueueDueReminders(now: Date = new Date()): Promise<number> {
  const seconds = env.REMINDER_HOURS_BEFORE * 3600;
  const horizon = new Date(now.getTime() + seconds * 1000);
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "Appointment"
    WHERE status = 'CONFIRMED'
      AND "slotStart" > ${now}
      AND "slotStart" <= ${horizon}
      AND "confirmedAt" IS NOT NULL
      AND "confirmedAt" <= "slotStart" - ${seconds}::float8 * interval '1 second'
    LIMIT 500`;
  let queued = 0;
  for (const { id } of due) {
    if (await enqueueAppointmentMessage(prisma, id, "appointment_reminder")) queued++;
  }
  return queued;
}

/** Send soon after a transaction commits instead of waiting for the next job tick. Never throws. */
export function kickDispatcher(): void {
  setImmediate(() => {
    dispatchNotifications().catch((err) => logger.error({ err }, "notification dispatch failed"));
  });
}
