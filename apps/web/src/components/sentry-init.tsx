"use client";

import { useEffect } from "react";
import { initSentry } from "@/lib/sentry";

/** Starts browser error tracking once (nothing happens without NEXT_PUBLIC_SENTRY_DSN). */
export function SentryInit() {
  useEffect(() => {
    initSentry();
  }, []);
  return null;
}
