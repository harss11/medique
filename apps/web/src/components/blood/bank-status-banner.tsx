"use client";

import Link from "next/link";
import { Alert } from "@/components/ui";
import type { OwnBloodBank } from "@/lib/types";
import { useApi } from "@/lib/use-api";

/** Where the blood bank stands with MediQ's licence check. Nothing shows once it is verified. */
export function BankStatusBanner() {
  const { data } = useApi<OwnBloodBank>("/blood-bank/profile");
  if (!data || data.status === "ACTIVE") return null;
  if (data.status === "REJECTED") {
    return (
      <Alert>
        MediQ could not verify your blood bank:{" "}
        <strong>{data.rejectedReason ?? "see your profile"}</strong>. Fix the details and resubmit
        in your{" "}
        <Link href="/blood-bank/profile" className="font-semibold underline">
          profile
        </Link>
        .
      </Alert>
    );
  }
  return (
    <Alert tone="info">
      MediQ is checking your licence. You will be listed, and able to record donations and answer
      requests, once it is approved.
    </Alert>
  );
}
