import { useSyncExternalStore } from "react";
import type { BloodBankStatus, BloodGroup } from "./types";

export const BLOOD_GROUPS: BloodGroup[] = [
  "A_POS",
  "A_NEG",
  "B_POS",
  "B_NEG",
  "AB_POS",
  "AB_NEG",
  "O_POS",
  "O_NEG",
];

/** "A_POS" to "A+". */
export const bloodLabel = (g: BloodGroup) => g.replace("_POS", "+").replace("_NEG", "-");

/** How each verification status is worded and coloured. */
export const BANK_STATUS: Record<
  BloodBankStatus,
  { label: string; tone: "green" | "amber" | "red" | "slate" }
> = {
  PENDING_VERIFICATION: { label: "Waiting for verification", tone: "amber" },
  ACTIVE: { label: "Verified", tone: "green" },
  REJECTED: { label: "Rejected", tone: "red" },
  BLOCKED: { label: "Blocked", tone: "red" },
};

/** Shown wherever blood is asked for, offered or recorded. */
export const BLOOD_DISCLAIMER =
  "MediQ only connects people. It does not collect, store, test or sell blood. Whether blood is available, and whether it is safe, is the responsibility of the blood bank and the hospital. Never pay anyone for blood through MediQ, and always have blood checked by the hospital before use.";

// ---------------------------------------------------------------------------
// The secret key that lets a requester come back to their request. It lives only in this
// browser (never in a URL, so it cannot end up in a log or a shared link).
// ---------------------------------------------------------------------------

const keyName = (id: string) => "mediq-blood-key:" + id;

export function saveRequestKey(id: string, key: string): void {
  try {
    localStorage.setItem(keyName(id), key);
  } catch {
    // Private mode: the requester can recover with a code instead.
  }
}

export function readRequestKey(id: string): string | null {
  try {
    return localStorage.getItem(keyName(id));
  } catch {
    return null;
  }
}

export function forgetRequestKey(id: string): void {
  try {
    localStorage.removeItem(keyName(id));
  } catch {
    // Nothing to forget.
  }
}

const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

/**
 * The stored key for a request: undefined until it has been read in the browser (and on the
 * server), null when this browser has none. Keeping those apart avoids a hydration mismatch.
 */
export function useRequestKey(id: string): string | null | undefined {
  return useSyncExternalStore<string | null | undefined>(
    subscribe,
    () => readRequestKey(id),
    () => undefined,
  );
}

/** The date or time in the visitor's own locale. */
export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
