"use client";

import { useState } from "react";
import { formatDate, formatTime } from "@/lib/format";
import type { Availability, PublicSlot } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { Alert, EmptyState, LoadingBlock, cx } from "../ui";

const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" });
const DAY_MONTH = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function chip(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return { weekday: WEEKDAY.format(d), dayMonth: DAY_MONTH.format(d) };
}

/**
 * Date strip + time slots for one doctor (public data, no login needed).
 * `disabledStart` greys out the slot starting at that instant (the appointment
 * being rescheduled).
 */
export function SlotPicker({
  doctorId,
  selectedId,
  onSelect,
  disabledStart,
}: {
  doctorId: string;
  selectedId: string | null;
  onSelect: (slot: PublicSlot & { date: string }, timezone: string) => void;
  disabledStart?: string;
}) {
  const availability = useApi<Availability>(`/public/doctors/${doctorId}/availability`);
  const [chosen, setChosen] = useState<string | null>(null);
  const dates = availability.data?.dates ?? [];
  // Default to the first day that still has a free slot.
  const date = chosen ?? dates[0]?.date ?? null;
  const slots = useApi<{ timezone: string; date: string; items: PublicSlot[] }>(
    date ? `/public/doctors/${doctorId}/slots?date=${date}` : null,
  );
  const timezone = availability.data?.timezone ?? "Asia/Kolkata";

  if (availability.error) return <Alert>{availability.error}</Alert>;
  if (!availability.data) return <LoadingBlock />;
  if (dates.length === 0) {
    return (
      <EmptyState title="No free slots right now">
        This doctor has no open appointments in the next few weeks. Please check again later.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Choose a date"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
      >
        {dates.map((d) => {
          const c = chip(d.date);
          const active = d.date === date;
          return (
            <button
              key={d.date}
              role="tab"
              aria-selected={active}
              onClick={() => setChosen(d.date)}
              className={cx(
                "shrink-0 rounded-xl border px-3.5 py-2 text-center",
                active
                  ? "border-brand-700 bg-brand-700 text-white"
                  : "border-slate-300 bg-white text-slate-800 hover:border-brand-400",
              )}
            >
              <div className="text-xs opacity-80">{c.weekday}</div>
              <div className="text-sm font-semibold whitespace-nowrap">{c.dayMonth}</div>
              <div className={cx("text-[11px]", active ? "text-white/80" : "text-emerald-700")}>
                {d.openSlots} open
              </div>
            </button>
          );
        })}
      </div>

      {date && <p className="text-sm font-medium text-slate-700">{formatDate(date)}</p>}
      {slots.error && <Alert>{slots.error}</Alert>}
      {slots.loading && !slots.data && <LoadingBlock />}
      {slots.data && slots.data.items.length === 0 && <EmptyState title="No slots on this day" />}
      {slots.data && slots.data.items.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {slots.data.items.map((s) => {
            const isCurrent =
              !!disabledStart &&
              new Date(s.startAt).getTime() === new Date(disabledStart).getTime();
            const disabled = !s.available || isCurrent;
            const selected = s.id === selectedId;
            return (
              <li key={s.id}>
                <button
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() => onSelect({ ...s, date: slots.data!.date }, timezone)}
                  className={cx(
                    "w-full rounded-lg border px-2 py-2.5 text-sm font-medium whitespace-nowrap",
                    selected
                      ? "border-brand-700 bg-brand-700 text-white"
                      : disabled
                        ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 line-through"
                        : "border-slate-300 bg-white text-slate-900 hover:border-brand-500",
                  )}
                  title={
                    isCurrent
                      ? "Your current appointment"
                      : s.available
                        ? undefined
                        : "Fully booked"
                  }
                >
                  {formatTime(s.startAt, timezone)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
