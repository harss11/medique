import { Badge } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import type { AppointmentStatus, Gender, QueueCounts, StaffAppointment } from "@/lib/types";

const STATUS: Record<
  AppointmentStatus,
  { label: string; tone: "green" | "amber" | "red" | "slate" | "blue" }
> = {
  PENDING_PAYMENT: { label: "Awaiting payment", tone: "amber" },
  CONFIRMED: { label: "Booked", tone: "blue" },
  CHECKED_IN: { label: "Waiting", tone: "amber" },
  IN_PROGRESS: { label: "With doctor", tone: "green" },
  COMPLETED: { label: "Seen", tone: "slate" },
  CANCELLED: { label: "Cancelled", tone: "red" },
  NO_SHOW: { label: "No-show", tone: "red" },
  EXPIRED: { label: "Expired", tone: "slate" },
};

export function QueueStatusBadge({ status }: { status: AppointmentStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const GENDER: Record<Gender, string> = { MALE: "M", FEMALE: "F", OTHER: "Other", UNDISCLOSED: "" };

/** "34 y · M" (either part may be missing). */
export function ageGender(p: StaffAppointment["patient"]): string {
  return [p.ageYears != null ? `${p.ageYears} y` : null, p.gender ? GENDER[p.gender] : null]
    .filter(Boolean)
    .join(" · ");
}

/** What the patient has paid, or what is still owed. */
export function PaymentBadge({ a }: { a: StaffAppointment }) {
  if (a.payment?.status === "REFUNDED") return <Badge tone="slate">Refunded</Badge>;
  if (a.payment?.status === "PARTIALLY_REFUNDED") return <Badge tone="slate">Part refunded</Badge>;
  if (a.paid) {
    return <Badge tone="green">{a.payment?.method === "CASH" ? "Paid cash" : "Paid online"}</Badge>;
  }
  if (a.feeAmount === 0) return <Badge tone="slate">No fee</Badge>;
  return <Badge tone="amber">Owes {formatMoney(a.feeAmount, a.currency)}</Badge>;
}

export function SummaryChips({ summary }: { summary: QueueCounts & { cancelled?: number } }) {
  const items: Array<[string, number, string]> = [
    ["Booked", summary.booked, "text-sky-800 bg-sky-50"],
    ["Waiting", summary.waiting, "text-amber-800 bg-amber-50"],
    ["With doctor", summary.inProgress, "text-emerald-800 bg-emerald-50"],
    ["Seen", summary.completed, "text-slate-700 bg-slate-100"],
    ["No-show", summary.noShow, "text-red-800 bg-red-50"],
  ];
  if (summary.cancelled !== undefined) {
    items.push(["Cancelled", summary.cancelled, "text-slate-600 bg-slate-100"]);
  }
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Totals for the day">
      {items.map(([label, n, tone]) => (
        <li key={label} className={`rounded-full px-3 py-1 text-sm font-medium ${tone}`}>
          {label} <span className="font-bold tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  );
}

/** The big square token number used on desk and doctor lists. */
export function TokenBubble({ token, active }: { token: number | null; active?: boolean }) {
  return (
    <div
      className={`flex size-12 shrink-0 items-center justify-center rounded-xl text-xl font-bold tabular-nums ${
        active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-900"
      }`}
      aria-label={token != null ? `Token ${token}` : "No token"}
    >
      {token ?? "–"}
    </div>
  );
}
