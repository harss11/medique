import { Badge, Card, Select, cx } from "@/components/ui";
import { BLOOD_DISCLAIMER, BLOOD_GROUPS, bloodLabel, formatWhen } from "@/lib/blood";
import type { BloodGroup, BloodStockRow } from "@/lib/types";

/** The reminder that MediQ connects people and does not handle blood. Shown on every blood screen. */
export function BloodDisclaimer({ className }: { className?: string }) {
  return (
    <aside
      aria-label="Important"
      className={cx(
        "rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950",
        className,
      )}
    >
      <strong className="font-semibold">Please note. </strong>
      {BLOOD_DISCLAIMER}
    </aside>
  );
}

export function BloodGroupSelect({
  label = "Blood group",
  value,
  onChange,
  error,
  includeAny,
}: {
  label?: string;
  value: BloodGroup | "";
  onChange: (value: BloodGroup | "") => void;
  error?: string;
  includeAny?: boolean;
}) {
  return (
    <Select
      label={label}
      value={value}
      error={error}
      onChange={(e) => onChange(e.target.value as BloodGroup | "")}
    >
      <option value="">{includeAny ? "Any group" : "Choose"}</option>
      {BLOOD_GROUPS.map((g) => (
        <option key={g} value={g}>
          {bloodLabel(g)}
        </option>
      ))}
    </Select>
  );
}

/** Units per group. Old figures are shown as a guess ("call to confirm"). */
export function StockGrid({
  stock,
  highlight,
  showUnits = true,
}: {
  stock: BloodStockRow[];
  highlight?: BloodGroup;
  showUnits?: boolean;
}) {
  return (
    <ul className="grid grid-cols-4 gap-2" aria-label="Stock by blood group">
      {stock.map((s) => (
        <li
          key={s.bloodGroup}
          className={cx(
            "rounded-xl border px-2 py-2 text-center",
            s.units > 0 ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50",
            highlight === s.bloodGroup && "ring-2 ring-brand-600",
          )}
        >
          <div className="text-sm font-bold text-slate-900">{bloodLabel(s.bloodGroup)}</div>
          {showUnits && (
            <div
              className={cx(
                "text-lg font-bold tabular-nums",
                s.units > 0 ? "text-emerald-800" : "text-slate-400",
              )}
              title={s.updatedAt ? "Updated " + formatWhen(s.updatedAt) : "Not reported yet"}
            >
              {s.units}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function FreshnessNote({ updatedAt, stale }: { updatedAt: string | null; stale: boolean }) {
  if (!updatedAt)
    return <p className="text-xs text-slate-500">Stock not reported yet. Call to ask.</p>;
  return (
    <p className={cx("text-xs", stale ? "text-amber-700" : "text-slate-500")}>
      {stale ? "Not updated recently: call to confirm. " : "Updated "}
      {formatWhen(updatedAt)}
    </p>
  );
}

export function BloodBadge({ group }: { group: BloodGroup }) {
  return <Badge tone="red">{bloodLabel(group)}</Badge>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold text-slate-900">{title}</h2>
      {children}
    </Card>
  );
}
