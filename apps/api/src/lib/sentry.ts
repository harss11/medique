import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import { env } from "../config/env.js";

/**
 * Error tracking. Entirely off unless SENTRY_DSN is set. Only unexpected server errors (5xx
 * and crashes) are reported; validation errors, 4xx and other expected AppErrors never are.
 * Reports must not carry patient data: bodies, query strings, cookies, headers and
 * identifying user fields are removed, and phone numbers and emails in text are masked.
 */

const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export function maskPersonalText(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[number]");
}

/** Removes personal data from an event before it leaves the server. Exported for tests. */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split("?")[0]!;
  }
  if (event.user) event.user = { id: event.user.id };
  if (event.message) event.message = maskPersonalText(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = maskPersonalText(ex.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = maskPersonalText(crumb.message);
    delete crumb.data;
  }
  return event;
}

let enabled = false;

export function initSentry(): void {
  if (!env.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Belt and braces with scrubEvent: collect no user info, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: (event) => scrubEvent(event),
  });
  enabled = true;
}

export function sentryEnabled(): boolean {
  return enabled;
}

/** Reports an unexpected error with the request id (so it can be matched to the log line). */
export function captureServerError(
  err: unknown,
  context: { requestId?: string; userId?: string; role?: string; method?: string; route?: string },
): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag("request_id", context.requestId ?? "unknown");
    if (context.role) scope.setTag("role", context.role);
    if (context.method) scope.setTag("method", context.method);
    if (context.route) scope.setTag("route", context.route);
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(err);
  });
}

/** Sends anything still queued, so a crash or deploy does not lose the last errors. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}
