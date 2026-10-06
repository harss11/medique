"use client";

import Link from "next/link";
import { formatDate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Availability } from "@/lib/types";
import { useApi } from "@/lib/use-api";

/** On the doctor page: days that are fully booked, each with a way to ask to be told if a seat opens. */
export function WaitlistInvite({ doctorId }: { doctorId: string }) {
  const t = useT();
  const { data } = useApi<Availability>(`/public/doctors/${doctorId}/availability`, {
    auth: false,
  });
  const days = data?.fullDates ?? [];
  if (days.length === 0) return null;
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="font-semibold text-slate-900">{t("waitlist.inviteTitle")}</h3>
      <p className="mt-0.5 text-sm text-slate-700">{t("waitlist.inviteText")}</p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {days.map((d) => (
          <li key={d}>
            <Link
              href={`/patient/waitlist/join/${doctorId}/${d}`}
              className="inline-flex h-10 items-center rounded-xl border border-amber-300 bg-white px-3.5 text-sm font-medium text-slate-900 hover:border-brand-500"
            >
              {t("waitlist.inviteDay", { date: formatDate(d) })}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
