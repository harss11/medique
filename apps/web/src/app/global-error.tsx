"use client";

import { useEffect } from "react";
import { reportCrash } from "@/lib/sentry";

/** Last resort when the root layout itself fails (it must render its own html and body). */
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{ fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "4rem 1rem" }}
      >
        <h1>Something went wrong</h1>
        <p>Please try again. For emergencies call 112.</p>
        <button onClick={reset} style={{ padding: "0.6rem 1.2rem", fontSize: "1rem" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
