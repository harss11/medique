import * as Sentry from "@sentry/browser";
import { ApiError } from "./api";

/**
 * Browser error tracking. Off unless NEXT_PUBLIC_SENTRY_DSN is set. Expected failures (an
 * ApiError such as "slot taken" or a wrong code) are never reported, only genuine crashes.
 * No personal data is sent: user info, cookies, request bodies and query strings are
 * stripped, and phone numbers and emails inside messages are masked.
 */

const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const mask = (text: string) => text.replace(EMAIL, "[email]").replace(PHONE, "[number]");

/** The address without its query string or fragment (they can hold tokens and names). */
const bare = (url: string) => url.split(/[?#]/)[0]!;

let started = false;

export function initSentry(): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn || started) return;
  started = true;
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    // Browser extensions throw errors that are not ours.
    denyUrls: [/^chrome-extension:\/\//i, /^moz-extension:\/\//i, /^safari-extension:\/\//i],
    beforeSend(event, hint) {
      if (hint.originalException instanceof ApiError) return null;
      if (event.request?.url) event.request.url = bare(event.request.url);
      delete event.request?.cookies;
      delete event.request?.headers;
      delete event.request?.query_string;
      event.user = undefined;
      if (event.message) event.message = mask(event.message);
      for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = mask(ex.value);
      for (const crumb of event.breadcrumbs ?? []) {
        if (crumb.message) crumb.message = mask(crumb.message);
        if (crumb.data) delete crumb.data.url;
      }
      return event;
    },
    beforeBreadcrumb(crumb) {
      // Clicks and console output can contain what a patient typed or saw.
      return crumb.category === "ui.click" ||
        crumb.category === "ui.input" ||
        crumb.category === "console"
        ? null
        : crumb;
    },
  });
}

/** For error boundaries: reports a crash that React caught. */
export function reportCrash(error: Error & { digest?: string }): void {
  if (!started) return;
  Sentry.captureException(error, { tags: { digest: error.digest ?? "none" } });
}
