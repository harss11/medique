"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { DAY_NAMES } from "@/lib/format";
import type { ScheduleSession, SlotSyncSummary } from "@/lib/types";
import { Alert, Button, Card, cx } from "../ui";
import { SlotSyncResult } from "./slot-sync-result";

const SLOT_LENGTHS = [5, 10, 15, 20, 30, 45, 60];
// Monday first, the way Indian hospitals usually write timings.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface Row extends ScheduleSession {
  key: string;
}

let keySeq = 0;
const newKey = () => `s${++keySeq}`;

const inputClass =
  "h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm outline-none focus:ring-2 focus:ring-brand-500";

function toMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Problems the API would reject anyway, shown inline before saving. */
function validate(rows: Row[]): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const r of rows) {
    const start = toMinutes(r.startTime);
    const end = toMinutes(r.endTime);
    if (!r.startTime || !r.endTime) problems[r.key] = "Set start and end time";
    else if (end <= start) problems[r.key] = "End must be after start";
    else if (end - start < r.slotMinutes) problems[r.key] = "Shorter than one slot";
    else if (!(r.capacityPerSlot >= 1 && r.capacityPerSlot <= 50))
      problems[r.key] = "Patients per slot: 1-50";
    else {
      const clash = rows.find(
        (o) =>
          o.key !== r.key &&
          o.dayOfWeek === r.dayOfWeek &&
          toMinutes(o.startTime) < end &&
          start < toMinutes(o.endTime),
      );
      if (clash) problems[r.key] = "Overlaps another session";
    }
  }
  return problems;
}

function slotsIn(r: Row) {
  const len = toMinutes(r.endTime) - toMinutes(r.startTime);
  return len > 0 ? Math.floor(len / r.slotMinutes) : 0;
}

/**
 * Weekly timings editor. Each day can have several sessions (morning and
 * evening OPD). Saving replaces the whole schedule and regenerates slots.
 */
export function ScheduleEditor({
  doctorId,
  initial,
  onSaved,
}: {
  doctorId: string;
  initial: ScheduleSession[];
  onSaved: (sessions: ScheduleSession[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((s) => ({ ...s, key: newKey() })));
  const [summary, setSummary] = useState<SlotSyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const problems = validate(rows);

  const update = (key: string, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
    setSummary(null);
  };
  const add = (dayOfWeek: number) => {
    const sameDay = rows.filter((r) => r.dayOfWeek === dayOfWeek);
    const last = sameDay.at(-1);
    setRows((rs) => [
      ...rs,
      last
        ? { ...last, key: newKey(), id: undefined, startTime: "17:00", endTime: "20:00" }
        : {
            key: newKey(),
            dayOfWeek,
            startTime: "09:00",
            endTime: "13:00",
            slotMinutes: 15,
            capacityPerSlot: 1,
          },
    ]);
    setDirty(true);
    setSummary(null);
  };
  const remove = (key: string) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setDirty(true);
    setSummary(null);
  };
  /** Copies Monday's sessions to Tuesday-Saturday. */
  const copyMonday = () => {
    const monday = rows.filter((r) => r.dayOfWeek === 1);
    setRows([
      ...rows.filter((r) => r.dayOfWeek === 0 || r.dayOfWeek === 1),
      ...[2, 3, 4, 5, 6].flatMap((d) =>
        monday.map((m) => ({ ...m, id: undefined, key: newKey(), dayOfWeek: d })),
      ),
    ]);
    setDirty(true);
    setSummary(null);
  };

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.put<{ schedules: ScheduleSession[]; slotSync: SlotSyncSummary }>(
        `/hospital/doctors/${doctorId}/schedules`,
        {
          sessions: rows.map(({ dayOfWeek, startTime, endTime, slotMinutes, capacityPerSlot }) => ({
            dayOfWeek,
            startTime,
            endTime,
            slotMinutes,
            capacityPerSlot,
          })),
        },
      );
      setRows(res.schedules.map((s) => ({ ...s, key: newKey() })));
      setSummary(res.slotSync);
      setDirty(false);
      onSaved(res.schedules);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const perWeek = rows.reduce((n, r) => n + slotsIn(r) * r.capacityPerSlot, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          {rows.length === 0
            ? "No timings yet: patients cannot book this doctor."
            : `${perWeek} bookings per week.`}
        </p>
        <Button
          variant="secondary"
          className="h-9 px-3"
          onClick={copyMonday}
          disabled={!rows.some((r) => r.dayOfWeek === 1)}
        >
          Copy Monday to Tue–Sat
        </Button>
      </div>

      <Card className="divide-y divide-slate-100 p-0">
        {DAY_ORDER.map((day) => {
          const dayRows = rows.filter((r) => r.dayOfWeek === day);
          return (
            <div key={day} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
              <div className="w-28 shrink-0 pt-2 text-sm font-medium text-slate-900">
                {DAY_NAMES[day]}
              </div>
              <div className="flex-1 space-y-2">
                {dayRows.length === 0 && <div className="pt-2 text-sm text-slate-400">Closed</div>}
                {dayRows.map((r) => (
                  <div key={r.key}>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="time"
                        aria-label="Start time"
                        className={inputClass}
                        value={r.startTime}
                        onChange={(e) => update(r.key, { startTime: e.target.value })}
                      />
                      <span className="text-slate-400">to</span>
                      <input
                        type="time"
                        aria-label="End time"
                        className={inputClass}
                        value={r.endTime}
                        onChange={(e) => update(r.key, { endTime: e.target.value })}
                      />
                      <select
                        aria-label="Slot length"
                        className={inputClass}
                        value={r.slotMinutes}
                        onChange={(e) => update(r.key, { slotMinutes: Number(e.target.value) })}
                      >
                        {SLOT_LENGTHS.map((m) => (
                          <option key={m} value={m}>
                            {m} min slots
                          </option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1 text-sm text-slate-600">
                        <input
                          type="number"
                          min={1}
                          max={50}
                          aria-label="Patients per slot"
                          className={cx(inputClass, "w-16")}
                          value={r.capacityPerSlot}
                          onChange={(e) =>
                            update(r.key, { capacityPerSlot: Number(e.target.value) })
                          }
                        />
                        per slot
                      </label>
                      <button
                        type="button"
                        onClick={() => remove(r.key)}
                        className="rounded-lg px-2 py-1 text-sm text-red-700 hover:bg-red-50"
                        aria-label={`Remove ${DAY_NAMES[day]} session`}
                      >
                        Remove
                      </button>
                    </div>
                    <p
                      className={cx(
                        "mt-1 text-xs",
                        problems[r.key] ? "text-red-600" : "text-slate-500",
                      )}
                    >
                      {problems[r.key] ?? `${slotsIn(r)} slots`}
                    </p>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => add(day)}
                  aria-label={`Add ${DAY_NAMES[day]} session`}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  + Add session
                </button>
              </div>
            </div>
          );
        })}
      </Card>

      {error && <Alert>{error}</Alert>}
      <SlotSyncResult summary={summary} />
      <div className="flex justify-end">
        <Button onClick={save} loading={busy} disabled={!dirty || Object.keys(problems).length > 0}>
          Save timings
        </Button>
      </div>
    </div>
  );
}
