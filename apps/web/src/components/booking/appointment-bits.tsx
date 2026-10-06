"use client";

import Link from "next/link";
import { formatDate, formatMoney, formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Appointment, AppointmentStatus } from "@/lib/types";
import { DoctorAvatar } from "../hospital/doctor-avatar";
import { Badge } from "../ui";

const STATUS: Record<AppointmentStatus, { tone: "green" | "amber" | "red" | "slate" | "blue" }> = {
  PENDING_PAYMENT: { tone: "amber" },
  CONFIRMED: { tone: "green" },
  CHECKED_IN: { tone: "blue" },
  IN_PROGRESS: { tone: "blue" },
  COMPLETED: { tone: "slate" },
  CANCELLED: { tone: "red" },
  NO_SHOW: { tone: "red" },
  EXPIRED: { tone: "slate" },
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const t = useT();
  return <Badge tone={STATUS[status].tone}>{t(`status.${status}`)}</Badge>;
}

/** "Mon, 12 Oct 2026 · 9:30 am" in the hospital's timezone. */
export function whenText(a: Pick<Appointment, "appointmentDate" | "slotStart" | "hospital">) {
  return `${formatDate(a.appointmentDate)} · ${formatTime(a.slotStart, a.hospital.timezone)}`;
}

/** One row in "My appointments". */
export function AppointmentRow({ appointment: a }: { appointment: Appointment }) {
  return (
    <Link
      href={`/patient/appointments/${a.id}`}
      className="flex items-start gap-4 px-5 py-4 hover:bg-slate-50"
    >
      <DoctorAvatar doctor={a.doctor} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{a.doctor.name}</span>
          <StatusBadge status={a.status} />
        </div>
        <div className="truncate text-sm text-slate-600">
          {a.hospital.name} · {a.department.name}
        </div>
        <div className="text-sm text-slate-600">
          {whenText(a)} · for {a.patient.fullName}
        </div>
      </div>
      <div className="text-right">
        {a.tokenNumber != null && (
          <div className="rounded-lg bg-brand-50 px-2.5 py-1 text-sm font-bold text-brand-800">
            Token {a.tokenNumber}
          </div>
        )}
        <div className="mt-1 text-xs text-slate-500">{formatMoney(a.feeAmount, a.currency)}</div>
      </div>
    </Link>
  );
}
