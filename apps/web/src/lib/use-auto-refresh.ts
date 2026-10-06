"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `reload` every `intervalMs` while the tab is visible, and once more the moment the
 * tab becomes visible again. Polling keeps the desk and queue screens current without a
 * socket server; at a few seconds apart it is cheap for the API (queue reads are cached).
 */
export function useAutoRefresh(reload: () => void, intervalMs: number, enabled = true) {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs, enabled]);
}
