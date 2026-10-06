import { cx } from "@/components/ui";

/**
 * Small dependency-free charts. Each draws plain SVG/HTML and carries its numbers in text
 * (a title on every bar and a visually hidden table) so screen readers get the data too.
 */

const niceMax = (max: number) => {
  if (max <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / pow) * pow;
};

export interface Bar {
  label: string;
  value: number;
  /** Shown in the tooltip and to screen readers. */
  text?: string;
}

/** Vertical bars over time. Labels are thinned so they never collide. */
export function BarChart({
  bars,
  title,
  format = (n) => String(n),
  tone = "bg-brand-600",
}: {
  bars: Bar[];
  title: string;
  format?: (n: number) => string;
  tone?: string;
}) {
  const top = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const every = Math.max(1, Math.ceil(bars.length / 8));
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium text-slate-700">{title}</figcaption>
      <div className="flex h-40 items-end gap-px" role="img" aria-label={title}>
        {bars.map((b) => (
          <div
            key={b.label}
            className="flex h-full min-w-0 flex-1 items-end"
            title={b.text ?? b.label + ": " + format(b.value)}
          >
            <div
              className={cx("w-full rounded-t-sm", b.value > 0 ? tone : "bg-slate-100")}
              style={{ height: b.value > 0 ? Math.max(3, (b.value / top) * 100) + "%" : "2px" }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-px text-[10px] text-slate-500">
        {bars.map((b, i) => (
          <div
            key={b.label}
            className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap"
          >
            {i % every === 0 ? b.label : ""}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Highest bar: {format(Math.max(0, ...bars.map((b) => b.value)))}
      </p>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {bars.map((b) => (
            <tr key={b.label}>
              <th scope="row">{b.label}</th>
              <td>{format(b.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Horizontal bars for a ranked list (doctors, departments, hospitals). */
export function HBars({
  rows,
  title,
  tone = "bg-brand-600",
}: {
  rows: Array<{ label: string; value: number; note?: string }>;
  title: string;
  tone?: string;
}) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium text-slate-700">{title}</figcaption>
      {rows.length === 0 && <p className="text-sm text-slate-500">Nothing in this period.</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="text-sm">
            <div className="flex justify-between gap-3">
              <span className="min-w-0 truncate text-slate-800">{r.label}</span>
              <span className="shrink-0 font-medium text-slate-900 tabular-nums">
                {r.value}
                {r.note && <span className="ml-2 font-normal text-slate-500">{r.note}</span>}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-slate-100">
              <div
                className={cx("h-2 rounded-full", tone)}
                style={{ width: (r.value / top) * 100 + "%" }}
              />
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}
