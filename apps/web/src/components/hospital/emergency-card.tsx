"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { formatDateTime, intOrNull } from "@/lib/format";
import type { Hospital } from "@/lib/types";
import { Alert, Button, Card, Field } from "../ui";

/** Emergency number and bed availability; updated often, so kept on its own. */
export function EmergencyCard({
  hospital,
  onSaved,
}: {
  hospital: Hospital;
  onSaved: (h: Hospital) => void;
}) {
  const [phone, setPhone] = useState(hospital.emergencyPhone ?? "");
  const [total, setTotal] = useState(hospital.totalBeds?.toString() ?? "");
  const [available, setAvailable] = useState(hospital.availableBeds?.toString() ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setError(null);
    setSaved(false);
    const totalBeds = intOrNull(total);
    const availableBeds = intOrNull(available);
    if (Number.isNaN(totalBeds) || Number.isNaN(availableBeds)) {
      setError("Bed counts must be whole numbers");
      return;
    }
    setBusy(true);
    try {
      const h = await api.patch<Hospital>("/hospital/emergency", {
        emergencyPhone: phone.trim(),
        totalBeds,
        availableBeds,
      });
      onSaved(h);
      setSaved(true);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-slate-900">Emergency & beds</h2>
          <span className="text-xs text-slate-500">
            Beds updated {formatDateTime(hospital.bedsUpdatedAt)}
          </span>
        </div>
        {error && <Alert>{error}</Alert>}
        {saved && <Alert tone="success">Saved. Shown on the public emergency page.</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Emergency number"
            name="emergencyPhone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={errors.emergencyPhone}
          />
          <Field
            label="Total beds"
            name="totalBeds"
            inputMode="numeric"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            error={errors.totalBeds}
          />
          <Field
            label="Available beds"
            name="availableBeds"
            inputMode="numeric"
            value={available}
            onChange={(e) => setAvailable(e.target.value)}
            error={errors.availableBeds}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            Update
          </Button>
        </div>
      </form>
    </Card>
  );
}
