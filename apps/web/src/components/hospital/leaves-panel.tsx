"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { formatDate, textOrNull, todayIn } from "@/lib/format";
import type { Leave, Paginated, SlotSyncSummary } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { ConfirmDialog } from "../modal";
import { Alert, Button, Card, EmptyState, Field, LoadingBlock } from "../ui";
import { SlotSyncResult } from "./slot-sync-result";

/** Full-day leaves. Adding one removes that period's open slots. */
export function LeavesPanel({ doctorId, timezone }: { doctorId: string; timezone: string }) {
  const today = todayIn(timezone);
  const { data, error, reload } = useApi<Paginated<Leave>>(
    `/hospital/doctors/${doctorId}/leaves?limit=50`,
  );
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SlotSyncSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Leave | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    setSummary(null);
    setBusy(true);
    try {
      const res = await api.post<{ leave: Leave; slotSync: SlotSyncSummary }>(
        `/hospital/doctors/${doctorId}/leaves`,
        { startDate, endDate, reason: textOrNull(reason) },
      );
      setSummary(res.slotSync);
      setReason("");
      reload();
    } catch (err) {
      setErrors(fieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <form onSubmit={add} className="space-y-4" noValidate>
          <h2 className="font-semibold text-slate-900">Add leave</h2>
          {formError && <Alert>{formError}</Alert>}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="From"
              name="startDate"
              type="date"
              min={today}
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (e.target.value > endDate) setEndDate(e.target.value);
              }}
              error={errors.startDate}
            />
            <Field
              label="To (inclusive)"
              name="endDate"
              type="date"
              min={startDate}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              error={errors.endDate}
            />
            <Field
              label="Reason (optional)"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              error={errors.reason}
            />
          </div>
          <SlotSyncResult summary={summary} />
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>
              Add leave
            </Button>
          </div>
        </form>
      </Card>

      {error && <Alert>{error}</Alert>}
      {!data && !error && <LoadingBlock />}
      {data && data.items.length === 0 && <EmptyState title="No upcoming leaves" />}
      {data && data.items.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {data.items.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
              >
                <div>
                  <div className="font-medium text-slate-900">
                    {formatDate(l.startDate)}
                    {l.endDate !== l.startDate && ` – ${formatDate(l.endDate)}`}
                  </div>
                  {l.reason && <div className="text-sm text-slate-600">{l.reason}</div>}
                </div>
                <Button
                  variant="ghost"
                  className="h-9 px-3 text-red-700"
                  onClick={() => setRemoving(l)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove leave?"
        message="The doctor's slots for these days will open for booking again."
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const res = await api.delete<{ slotSync: SlotSyncSummary }>(
            `/hospital/leaves/${removing!.id}`,
          );
          setSummary(res.slotSync);
          reload();
        }}
      />
    </div>
  );
}
