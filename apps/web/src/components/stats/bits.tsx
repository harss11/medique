import { Card, cx } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import type { MoneySummary, OutstandingRefund } from "@/lib/types";

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <Card className={cx("p-4", tone === "warn" && "border-amber-300 bg-amber-50")}>
      <div className="text-2xl font-bold text-slate-900 tabular-nums">{value}</div>
      <div className="text-xs text-slate-600 sm:text-sm">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </Card>
  );
}

export const pct = (v: number | null | undefined) => (v == null ? "–" : v + "%");

/** Online money, commission and cash for one currency, with each figure explained. */
export function MoneyBlock({ m, asHospital }: { m: MoneySummary; asHospital?: boolean }) {
  const f = (n: number) => formatMoney(n, m.currency);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Paid online" value={f(m.onlineGross)} hint="received in this period" />
        <StatCard label="Refunded" value={f(m.onlineRefunded)} hint="online refunds completed" />
        <StatCard
          label={asHospital ? "MediQ fee" : "MediQ commission"}
          value={f(m.commission)}
          hint="on money kept after refunds"
        />
        <StatCard
          label={asHospital ? "You keep (online)" : "Hospitals keep (online)"}
          value={f(m.hospitalShare)}
          hint="after refunds and commission"
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Cash at the desk"
          value={f(m.cashNet)}
          hint={"collected " + f(m.cashCollected) + ", returned " + f(m.cashRefunded)}
        />
      </div>
    </div>
  );
}

/** Refunds still owed to patients: shown only when there are any. */
export function OutstandingRefunds({
  rows,
  asHospital,
}: {
  rows: OutstandingRefund[];
  asHospital?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <Card className="border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="font-semibold">Refunds still to reach patients</div>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.currency + r.status}>
            {r.count} {r.status === "FAILED" ? "failed" : "pending"} ·{" "}
            {formatMoney(r.amount, r.currency)}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs">
        {asHospital
          ? "These are retried automatically. Failed ones need attention: contact MediQ support if they stay for more than a day."
          : "Pending refunds are retried automatically. Failed ones need a look: check the payment gateway and the API log."}
      </p>
    </Card>
  );
}
