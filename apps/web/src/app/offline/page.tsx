import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline" };

/** Shown by the service worker when a page can't be loaded without a connection. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-bold text-slate-900">You&apos;re offline</h1>
      <p className="mt-2 max-w-sm text-slate-600">
        Check your internet connection and try again. Your bookings are safe.
      </p>
    </main>
  );
}
