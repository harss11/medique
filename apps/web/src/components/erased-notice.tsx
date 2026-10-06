"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Alert } from "./ui";

function Notice() {
  if (useSearchParams().get("erased") !== "1") return null;
  return (
    <div className="mx-auto max-w-5xl px-4">
      <Alert tone="success">
        Your account has been erased and you are signed out. Thank you for using MediQ.
      </Alert>
    </div>
  );
}

/** Confirms an account erasure on the home page (the page itself stays static). */
export function ErasedNotice() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
