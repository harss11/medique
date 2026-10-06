"use client";

import Link from "next/link";
import { useEffect } from "react";
import { reportCrash } from "@/lib/sentry";

/** Shown when a page crashes. The crash is reported (if tracking is on); the visitor can retry. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportCrash(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-bold text-slate-900">Something went wrong</h1>
      <p className="text-slate-600">
        We hit an unexpected problem. Your booking and payment are safe. Please try again.
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="inline-flex h-11 items-center rounded-xl bg-brand-700 px-5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex h-11 items-center rounded-xl border border-slate-300 px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Home
        </Link>
      </div>
      <p className="text-sm text-slate-500">
        Need help? For emergencies call{" "}
        <a className="font-semibold underline" href="tel:112">
          112
        </a>
        .
      </p>
    </main>
  );
}
