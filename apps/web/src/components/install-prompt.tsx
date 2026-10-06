"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "./ui";

/** Chrome, Edge and Samsung Internet offer installation through this event. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const SNOOZE_KEY = "mediq-install-snoozed-until";
const SNOOZE_DAYS = 30;

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false; // private mode or blocked storage: just show it
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86_400_000));
  } catch {
    // Not remembered; harmless.
  }
}

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone and iPad Safari never fire the install event: they need the Share-sheet hint. */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

const never = () => () => {};

/**
 * Invites visitors to install MediQ on their home screen. It appears only where installing is
 * possible and not yet done, can be dismissed (and stays away for 30 days), and never blocks
 * anything. Patients open the app daily on hospital days: installing makes tokens one tap away.
 */
export function InstallPrompt() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(false);
  const ios = useSyncExternalStore(
    never,
    () => isIosSafari() && !installed() && !snoozed(),
    () => false,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep it for our own button instead of the browser's mini-bar
      if (!installed() && !snoozed()) setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setEvent(null);
      setHidden(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden || (!event && !ios)) return null;

  function dismiss() {
    snooze();
    setHidden(true);
  }

  async function install() {
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice.catch(() => null);
    if (choice?.outcome !== "accepted") snooze();
    setEvent(null);
    setHidden(true);
  }

  return (
    <aside
      aria-label="Install MediQ"
      className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon-192.png" alt="" width={44} height={44} className="rounded-xl" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-slate-900">Install MediQ</div>
        <div className="text-slate-600">
          {event
            ? "Open your tokens in one tap, even on a weak connection."
            : "Tap the Share button, then “Add to Home Screen”."}
        </div>
      </div>
      {event && (
        <Button className="h-9 px-3" onClick={install}>
          Install
        </Button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Not now"
        className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100"
      >
        ✕
      </button>
    </aside>
  );
}
