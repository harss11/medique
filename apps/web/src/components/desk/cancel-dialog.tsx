"use client";

import { useState } from "react";
import { Modal } from "@/components/modal";
import { Alert, Button, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatMoney, textOrNull } from "@/lib/format";
import type { CancelResult, StaffAppointment } from "@/lib/types";

/** What the desk must tell the patient about their money after a cancellation. */
export function refundMessage(r: CancelResult["refund"], currency: string): string {
  if (!r) return "Nothing had been paid, so there is nothing to refund.";
  if (r.amount === 0) return "No refund applies under the cancellation policy.";
  const amount = formatMoney(r.amount, currency);
  return r.method === "CASH"
    ? `Hand ${amount} back to the patient in cash now.`
    : `${amount} will be refunded to the patient’s account in 5-7 days.`;
}

const REASONS = [
  {
    value: "PATIENT_REQUEST",
    label: "The patient asked to cancel",
    hint: "The refund follows the hospital’s cancellation policy.",
  },
  {
    value: "HOSPITAL",
    label: "The hospital cannot see them",
    hint: "For example the doctor is unavailable. Full refund.",
  },
] as const;

/** Cancels a booking at the desk and then shows the refund instructions. */
export function CancelDialog({
  appointment,
  onClose,
  onDone,
}: {
  appointment: StaffAppointment | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [initiator, setInitiator] = useState<"PATIENT_REQUEST" | "HOSPITAL">("PATIENT_REQUEST");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CancelResult | null>(null);

  function close() {
    if (busy) return;
    const finished = result !== null;
    setResult(null);
    setError(null);
    setReason("");
    setInitiator("PATIENT_REQUEST");
    onClose();
    if (finished) onDone();
  }

  async function submit() {
    if (!appointment) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.post<CancelResult>(`/desk/appointments/${appointment.id}/cancel`, {
          initiator,
          reason: textOrNull(reason),
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const a = appointment;
  return (
    <Modal open={!!a} title={result ? "Booking cancelled" : "Cancel this booking?"} onClose={close}>
      {a && result && (
        <div className="space-y-4">
          <Alert tone="success">
            Token {a.tokenNumber} ({a.patient.fullName}) is cancelled and the slot is free again.
          </Alert>
          <Alert tone="info">{refundMessage(result.refund, a.currency)}</Alert>
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
      {a && !result && (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Token <strong>{a.tokenNumber}</strong> · {a.patient.fullName} · {a.doctor.name}
          </p>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-slate-700">
              Why is it cancelled?
            </legend>
            {REASONS.map((r) => (
              <label
                key={r.value}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50"
              >
                <input
                  type="radio"
                  name="initiator"
                  className="mt-0.5 accent-brand-700"
                  checked={initiator === r.value}
                  onChange={() => setInitiator(r.value)}
                />
                <span>
                  <span className="font-medium text-slate-900">{r.label}</span>
                  <span className="block text-xs text-slate-500">{r.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Textarea
            label="Note (optional)"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={busy}>
              Keep booking
            </Button>
            <Button variant="danger" onClick={submit} loading={busy}>
              Cancel booking
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
