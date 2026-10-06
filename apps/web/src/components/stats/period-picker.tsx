"use client";

import { useState } from "react";
import { cx } from "@/components/ui";

export type Period = { days: number } | { from: string; to: string };

const PRESETS = [7, 30, 90] as const;

/** The query-string part for a period (the API counts "days" in the hospital's own timezone). */
export function periodQuery(p: Period): string {
  return "days" in p ? "days=" + p.days : "from=" + p.from + "&to=" + p.to;
}

/** Last 7 / 30 / 90 days, or a custom range. */
export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  const custom = "from" in value;
  const [from, setFrom] = useState("from" in value ? value.from : "");
  const [to, setTo] = useState("to" in value ? value.to : "");
  const invalid = from !== "" && to !== "" && from > to;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div role="group" aria-label="Period" className="flex gap-1">
        {PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={!custom && value.days === n}
            onClick={() => onChange({ days: n })}
            className={cx(
              "rounded-full px-3 py-1.5 text-sm font-medium",
              !custom && value.days === n
                ? "bg-brand-700 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200",
            )}
          >
            Last {n} days
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom}
          onClick={() => {
            if (from && to && !invalid) onChange({ from, to });
          }}
          className={cx(
            "rounded-full px-3 py-1.5 text-sm font-medium",
            custom ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
          )}
        >
          Custom
        </button>
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            if (e.target.value && to && e.target.value <= to)
              onChange({ from: e.target.value, to });
          }}
          className="h-9 rounded-lg border border-slate-300 px-2"
        />
        to
        <input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            if (from && e.target.value && from <= e.target.value)
              onChange({ from, to: e.target.value });
          }}
          className="h-9 rounded-lg border border-slate-300 px-2"
        />
      </div>
      {invalid && (
        <p className="text-xs text-red-600">The start date must not be after the end date.</p>
      )}
    </div>
  );
}
