"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { addDays, formatDate, formatTime, todayIn } from "@/lib/format";
import type { Paginated, Slot, SlotSyncSummary } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { Alert, Badge, Button, Card, EmptyState, LoadingBlock, cx } from "../ui";
import { SlotSyncResult } from "./slot-sync-result";

/** Day view of generated slots; single slots can be blocked or reopened. */
export function SlotsPanel({ doctorId, timezone }: { doctorId: string; timezone: string }) {
  const today = todayIn(timezone);
  const [date, setDate] = useState(today);
  const { data, error, reload, setData } = useApi<Paginated<Slot>>(
    `/hospital/doctors/${doctorId}/slots?from=${date}&to=${date}&limit=100`,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SlotSyncSummary | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // Captured once per mount; past slots are greyed out and can't be toggled.
  const [now] = useState(() => Date.now());

  async function toggle(slot: Slot) {
    setBusyId(slot.id);
    setActionError(null);
    try {
      const updated = await api.patch<Slot>(`/hospital/slots/${slot.id}`, {
        status: slot.status === "OPEN" ? "BLOCKED" : "OPEN",
      });
      setData((d) =>
        d
          ? {
              ...d,
              items: d.items.map((s) => (s.id === slot.id ? { ...s, status: updated.status } : s)),
            }
          : d,
      );
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function regenerate() {
    setRegenerating(true);
    setActionError(null);
    try {
      setSummary(await api.post<SlotSyncSummary>(`/hospital/doctors/${doctorId}/slots/generate`));
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setRegenerating(false);
    }
  }

  const items = data?.items ?? [];
  const open = items.filter((s) => s.status === "OPEN").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="h-10 px-3"
            aria-label="Previous day"
            disabled={date <= today}
            onClick={() => setDate(addDays(date, -1))}
          >
            ←
          </Button>
          <input
            type="date"
            aria-label="Date"
            min={today}
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm"
          />
          <Button
            variant="secondary"
            className="h-10 px-3"
            aria-label="Next day"
            onClick={() => setDate(addDays(date, 1))}
          >
            →
          </Button>
        </div>
        <Button variant="secondary" className="h-10" onClick={regenerate} loading={regenerating}>
          Regenerate slots
        </Button>
      </div>

      <p className="text-sm text-slate-600">
        {formatDate(date)} · {items.length} slots, {open} open. Slots are generated automatically
        for the next 30 days.
      </p>

      {(error || actionError) && <Alert>{error ?? actionError}</Alert>}
      <SlotSyncResult summary={summary} />
      {!data && !error && <LoadingBlock />}
      {data && items.length === 0 && (
        <EmptyState title="No slots on this day">
          The doctor has no session that day, or is on leave.
        </EmptyState>
      )}
      {items.length > 0 && (
        <Card className="p-3">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((s) => {
              const past = new Date(s.startAt).getTime() <= now;
              const blocked = s.status === "BLOCKED";
              return (
                <li
                  key={s.id}
                  className={cx(
                    "rounded-xl border p-3 text-sm",
                    blocked ? "border-red-200 bg-red-50" : "border-slate-200",
                    past && "opacity-50",
                  )}
                >
                  <div className="font-semibold text-slate-900">
                    {formatTime(s.startAt, timezone)} – {formatTime(s.endAt, timezone)}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-600">
                      {s.bookedCount}/{s.capacity} booked
                    </span>
                    {blocked && <Badge tone="red">Blocked</Badge>}
                  </div>
                  {!past && (
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => toggle(s)}
                      className="mt-2 text-xs font-medium text-brand-700 hover:underline disabled:opacity-50"
                    >
                      {blocked ? "Reopen" : "Block"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
