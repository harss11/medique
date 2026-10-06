"use client";

import { cx } from "@/components/ui";
import { useT } from "@/lib/i18n";
import type { Rating } from "@/lib/types";

/** Five stars, filled to the nearest half, for display. The number is always printed beside it. */
export function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cx("inline-flex text-amber-500", className)} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={value >= n - 0.25 ? "" : value >= n - 0.75 ? "opacity-60" : "text-slate-300"}
        >
          ★
        </span>
      ))}
    </span>
  );
}

/**
 * "★ 4.5 (12)", or a plain "No reviews yet". With `single`, the stars of one review (no count).
 */
export function RatingLine({
  rating,
  className,
  single = false,
}: {
  rating?: Rating | null;
  className?: string;
  single?: boolean;
}) {
  const t = useT();
  if (!rating || rating.average === null) {
    return <span className={cx("text-xs text-slate-500", className)}>{t("rating.none")}</span>;
  }
  const label = single
    ? t("rating.ariaPlain", { average: rating.average })
    : rating.count === 1
      ? t("rating.ariaOne", { average: rating.average })
      : t("rating.aria", { average: rating.average, count: rating.count });
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm", className)} aria-label={label}>
      <Stars value={rating.average} />
      <span className="font-semibold text-slate-900">{rating.average.toFixed(1)}</span>
      {!single && <span className="text-slate-500">({rating.count})</span>}
    </span>
  );
}

/** Choose 1 to 5 stars. Arrow keys work because these are radio buttons. */
export function StarInput({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  label?: string;
}) {
  const t = useT();
  const legend = label ?? t("rate.stars");
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-slate-800">{legend}</legend>
      <div className="flex gap-1" role="radiogroup" aria-label={legend}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input
              type="radio"
              name="rating"
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              className="peer sr-only"
              aria-label={t(n === 1 ? "rate.star" : "rate.starMany", { n })}
            />
            <span
              className={cx(
                "block rounded-lg px-1 text-4xl leading-none peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500",
                value >= n ? "text-amber-500" : "text-slate-300 hover:text-amber-300",
              )}
              aria-hidden="true"
            >
              ★
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
