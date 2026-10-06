"use client";

import { Badge, Card, cx } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import type {
  Plan,
  SubscriptionNotice,
  SubscriptionPaymentRow,
  SubscriptionState,
  SubscriptionView,
} from "@/lib/types";

const STATE: Record<
  SubscriptionState,
  { tone: "green" | "amber" | "red" | "slate" | "blue"; label: string }
> = {
  TRIALING: { tone: "blue", label: "Trial" },
  ACTIVE: { tone: "green", label: "Active" },
  GRACE: { tone: "amber", label: "Payment due" },
  EXPIRED: { tone: "red", label: "Expired" },
  SUSPENDED: { tone: "red", label: "Suspended" },
  CANCELLED: { tone: "slate", label: "Cancelled" },
};

export function StateBadge({ state }: { state: SubscriptionState | null }) {
  if (!state) return <Badge tone="slate">No plan</Badge>;
  const s = STATE[state];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const METHOD_LABEL = {
  BANK_TRANSFER: "Bank transfer",
  UPI: "UPI",
  CASH: "Cash",
  CHEQUE: "Cheque",
  OTHER: "Other",
} as const;

/** "Unlimited" or the number. */
export const limitText = (n: number | null) => (n === null ? "Unlimited" : String(n));

/** "Rs.999 per month" or "Free". */
export function priceText(plan: Pick<Plan, "priceMonthly" | "currency">) {
  return plan.priceMonthly === 0
    ? "Free"
    : `${formatMoney(plan.priceMonthly, plan.currency)} per month`;
}

/** How much of a limit is used: a bar for a limit, plain count when unlimited. */
export function UsageRow({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const pct = limit === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const full = limit !== null && used >= limit;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-slate-700">{label}</span>
        <span
          className={cx("font-medium tabular-nums", full ? "text-amber-700" : "text-slate-900")}
        >
          {used} of {limitText(limit).toLowerCase()}
        </span>
      </div>
      {limit !== null && (
        <div
          className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <div
            className={cx("h-full", full ? "bg-amber-500" : "bg-brand-600")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function UsageCard({ view }: { view: SubscriptionView }) {
  return (
    <Card className="space-y-4 p-4">
      <h2 className="font-semibold text-slate-900">Use of your plan</h2>
      <UsageRow label="Doctors" used={view.usage.doctors} limit={view.plan?.maxDoctors ?? null} />
      <UsageRow label="Staff logins" used={view.usage.staff} limit={view.plan?.maxStaff ?? null} />
      <UsageRow
        label="Online bookings this month"
        used={view.usage.monthlyBookings}
        limit={view.plan?.maxMonthlyBookings ?? null}
      />
    </Card>
  );
}

export function PaymentsTable({ payments }: { payments: SubscriptionPaymentRow[] }) {
  if (payments.length === 0)
    return <p className="text-sm text-slate-600">No payments recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Paid on</th>
            <th className="py-2 pr-4 font-medium">Amount</th>
            <th className="py-2 pr-4 font-medium">How</th>
            <th className="py-2 pr-4 font-medium">Covers</th>
            <th className="py-2 font-medium">Reference</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {payments.map((p) => (
            <tr key={p.id}>
              <td className="py-2 pr-4 whitespace-nowrap">{formatDate(p.paidAt.slice(0, 10))}</td>
              <td className="py-2 pr-4 font-medium whitespace-nowrap">
                {formatMoney(p.amount, p.currency)}
              </td>
              <td className="py-2 pr-4 whitespace-nowrap">{METHOD_LABEL[p.method]}</td>
              <td className="py-2 pr-4 whitespace-nowrap">
                {formatDate(p.periodStart.slice(0, 10))} to {formatDate(p.periodEnd.slice(0, 10))}
              </td>
              <td className="py-2 text-slate-600">
                {p.reference ?? "—"}
                {p.note ? <span className="block text-xs text-slate-500">{p.note}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One line for the date the plan runs to, in words. */
export function endText(
  view: Pick<SubscriptionView, "status" | "trialEndsAt" | "currentPeriodEnd" | "daysLeft">,
) {
  const end = view.status === "TRIALING" ? view.trialEndsAt : view.currentPeriodEnd;
  if (!end) return "No end date";
  const day = formatDate(end.slice(0, 10));
  const left = view.daysLeft;
  if (left === null) return day;
  if (left < 0) return `${day} (ended ${-left} ${-left === 1 ? "day" : "days"} ago)`;
  if (left === 0) return `${day} (today)`;
  return `${day} (${left} ${left === 1 ? "day" : "days"} left)`;
}

export const NOTICE_TEXT: Record<
  Exclude<SubscriptionNotice, "none">,
  { tone: "info" | "error"; text: string }
> = {
  ending_soon: {
    tone: "info",
    text: "Your MediQ plan ends soon. Please arrange the payment so online bookings are not interrupted.",
  },
  grace: {
    tone: "info",
    text: "Your MediQ plan period has ended. Online bookings continue for a few more days. Please arrange the payment now.",
  },
  expired: {
    tone: "error",
    text: "Your MediQ plan has ended, so patients cannot book online. Bookings at your desk and existing appointments are not affected. Please contact MediQ.",
  },
  suspended: {
    tone: "error",
    text: "Your hospital is suspended, so patients cannot book online. Bookings at your desk and existing appointments are not affected. Please contact MediQ.",
  },
  cancelled: {
    tone: "error",
    text: "Your MediQ plan was cancelled, so patients cannot book online. Please contact MediQ.",
  },
};
