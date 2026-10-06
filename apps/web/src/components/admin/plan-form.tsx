"use client";

import { useState } from "react";
import { Alert, Button, Checkbox, Field, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { textOrNull, toMajor, toMinor } from "@/lib/format";
import type { AdminPlan } from "@/lib/types";

/** "" means unlimited; otherwise a whole number. NaN when it is neither. */
const parseLimit = (text: string): number | null => {
  const t = text.trim();
  if (t === "") return null;
  return /^\d{1,6}$/.test(t) ? Number(t) : Number.NaN;
};

/** Create a plan, or change one (its code stays). */
export function PlanForm({
  plan,
  onSaved,
  onCancel,
}: {
  plan: AdminPlan | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [price, setPrice] = useState(plan ? toMajor(plan.priceMonthly) : "0");
  const [maxDoctors, setMaxDoctors] = useState(plan?.maxDoctors?.toString() ?? "");
  const [maxStaff, setMaxStaff] = useState(plan?.maxStaff?.toString() ?? "");
  const [maxBookings, setMaxBookings] = useState(plan?.maxMonthlyBookings?.toString() ?? "");
  const [analytics, setAnalytics] = useState(plan?.analytics ?? true);
  const [slipPrinting, setSlipPrinting] = useState(plan?.slipPrinting ?? true);
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const priceMinor = toMinor(price);
    const limits = [parseLimit(maxDoctors), parseLimit(maxStaff), parseLimit(maxBookings)];
    if (Number.isNaN(priceMinor))
      return setError("Enter the monthly price in rupees, for example 999.");
    if (limits.some((l) => l !== null && Number.isNaN(l))) {
      return setError("Limits are whole numbers. Leave one empty for unlimited.");
    }
    const body = {
      name: name.trim(),
      description: textOrNull(description),
      priceMonthly: priceMinor,
      maxDoctors: limits[0],
      maxStaff: limits[1],
      maxMonthlyBookings: limits[2],
      analytics,
      slipPrinting,
      isActive,
    };
    setBusy(true);
    setError(null);
    try {
      if (plan) await api.patch(`/admin/plans/${plan.id}`, body);
      else await api.post("/admin/plans", { ...body, code: code.trim() });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!plan && (
        <Field
          label="Code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toLowerCase())}
          hint="A short name that never changes, for example standard"
          required
        />
      )}
      <Field
        label="Name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Textarea
        label="Description (optional)"
        name="description"
        value={description}
        maxLength={300}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Field
        label="Price per month"
        name="price"
        prefix="Rs."
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        hint="0 for a free plan"
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Doctors"
          name="maxDoctors"
          inputMode="numeric"
          placeholder="Unlimited"
          value={maxDoctors}
          onChange={(e) => setMaxDoctors(e.target.value)}
        />
        <Field
          label="Staff logins"
          name="maxStaff"
          inputMode="numeric"
          placeholder="Unlimited"
          value={maxStaff}
          onChange={(e) => setMaxStaff(e.target.value)}
        />
        <Field
          label="Online bookings a month"
          name="maxBookings"
          inputMode="numeric"
          placeholder="Unlimited"
          value={maxBookings}
          onChange={(e) => setMaxBookings(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Checkbox label="Analytics" checked={analytics} onChange={setAnalytics} />
        <Checkbox label="Slip printing" checked={slipPrinting} onChange={setSlipPrinting} />
        <Checkbox
          label="Available to assign"
          checked={isActive}
          onChange={setIsActive}
          hint="Hospitals already on a plan that is switched off keep it."
        />
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {plan ? "Save plan" : "Create plan"}
        </Button>
      </div>
    </form>
  );
}
