"use client";

import Link from "next/link";
import { Alert } from "@/components/ui";
import type { SubscriptionView } from "@/lib/types";
import { NOTICE_TEXT } from "./bits";

/** On every hospital page when the plan is ending, overdue or stopped. Says nothing when all is well. */
export function SubscriptionBanner({ view }: { view: SubscriptionView | null }) {
  if (!view || view.notice === "none") return null;
  const n = NOTICE_TEXT[view.notice];
  return (
    <Alert tone={n.tone}>
      {n.text}{" "}
      <Link href="/hospital/subscription" className="font-medium underline">
        See your plan
      </Link>
    </Alert>
  );
}
