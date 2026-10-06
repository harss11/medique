"use client";

import { useState, type FormEvent } from "react";
import { fieldErrors, errorMessage } from "@/lib/api";
import { intOrNull, textOrNull } from "@/lib/format";
import type { Hospital } from "@/lib/types";
import { Alert, Button, Card, Checkbox, Field, Textarea } from "../ui";

/** Form state is all strings; converted to API types on submit. */
interface Values {
  name: string;
  slug: string;
  city: string;
  state: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  phone: string;
  email: string;
  emergencyPhone: string;
  description: string;
  latitude: string;
  longitude: string;
  commissionPercent: string;
  refundFullHours: string;
  refundPartialPercent: string;
  timezone: string;
  totalBeds: string;
  adminName: string;
  loginId: string;
  approve: boolean;
}

function initialValues(h?: Hospital): Values {
  const s = (v: string | number | null | undefined) => (v == null ? "" : String(v));
  return {
    name: s(h?.name),
    slug: s(h?.slug),
    city: s(h?.city),
    state: s(h?.state),
    addressLine1: s(h?.addressLine1),
    addressLine2: s(h?.addressLine2),
    postalCode: s(h?.postalCode),
    phone: s(h?.phone),
    email: s(h?.email),
    emergencyPhone: s(h?.emergencyPhone),
    description: s(h?.description),
    latitude: s(h?.latitude),
    longitude: s(h?.longitude),
    commissionPercent: h ? String(h.commissionPercent) : "10",
    refundFullHours: h ? String(h.refundFullHours) : "24",
    refundPartialPercent: h ? String(h.refundPartialPercent) : "50",
    timezone: h?.timezone ?? "Asia/Kolkata",
    totalBeds: s(h?.totalBeds),
    adminName: "",
    loginId: "",
    approve: false,
  };
}

function numberOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Create (no `hospital`) or edit (with `hospital`) a hospital as the admin.
 * `onSubmit` receives the API body and should throw ApiError on failure.
 */
export function HospitalForm({
  hospital,
  onSubmit,
  submitLabel,
}: {
  hospital?: Hospital;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  submitLabel: string;
}) {
  const creating = !hospital;
  const slugEditable = creating || hospital.status === "PENDING_APPROVAL";
  const [v, setV] = useState<Values>(() => initialValues(hospital));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof Values) => (e: { target: { value: string } }) =>
    setV((prev) => ({ ...prev, [key]: e.target.value }));
  const err = (key: string) => errors[key];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setError(null);

    const body: Record<string, unknown> = {
      name: v.name.trim(),
      city: v.city.trim(),
      state: textOrNull(v.state),
      addressLine1: textOrNull(v.addressLine1),
      addressLine2: textOrNull(v.addressLine2),
      postalCode: textOrNull(v.postalCode),
      phone: v.phone.trim(),
      email: v.email.trim(),
      emergencyPhone: v.emergencyPhone.trim(),
      description: textOrNull(v.description),
      latitude: numberOrNull(v.latitude),
      longitude: numberOrNull(v.longitude),
      commissionPercent: Number(v.commissionPercent),
      refundFullHours: Number(v.refundFullHours),
      refundPartialPercent: Number(v.refundPartialPercent),
      timezone: v.timezone.trim(),
      totalBeds: intOrNull(v.totalBeds),
    };
    if (slugEditable && v.slug.trim()) body.slug = v.slug.trim().toLowerCase();
    if (creating) {
      if (v.adminName.trim()) body.adminName = v.adminName.trim();
      if (v.loginId.trim()) body.loginId = v.loginId.trim().toLowerCase();
      body.approve = v.approve;
    }

    // Catch obvious number typos before the round trip.
    const local: Record<string, string> = {};
    for (const k of [
      "latitude",
      "longitude",
      "commissionPercent",
      "refundFullHours",
      "refundPartialPercent",
      "totalBeds",
    ] as const) {
      if (Number.isNaN(body[k])) local[k] = "Enter a number";
    }
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }

    setBusy(true);
    try {
      await onSubmit(body);
    } catch (e2) {
      setErrors(fieldErrors(e2));
      setError(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {error && <Alert>{error}</Alert>}

      <Card className="space-y-4">
        <h2 className="font-semibold text-slate-900">Hospital</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Hospital name"
            name="name"
            required
            value={v.name}
            onChange={set("name")}
            error={err("name")}
            className="sm:col-span-2"
          />
          <Field
            label="Public URL"
            name="slug"
            prefix="/h/"
            placeholder={creating ? "generated from the name" : undefined}
            value={v.slug}
            onChange={set("slug")}
            disabled={!slugEditable}
            error={err("slug")}
            hint={
              slugEditable
                ? "Printed on QR codes. Locked after approval."
                : "Locked after approval (printed QR codes use it)."
            }
            className="sm:col-span-2"
          />
          <Field
            label="Address line 1"
            name="addressLine1"
            value={v.addressLine1}
            onChange={set("addressLine1")}
            error={err("addressLine1")}
          />
          <Field
            label="Address line 2"
            name="addressLine2"
            value={v.addressLine2}
            onChange={set("addressLine2")}
            error={err("addressLine2")}
          />
          <Field
            label="City"
            name="city"
            required
            value={v.city}
            onChange={set("city")}
            error={err("city")}
          />
          <Field
            label="State"
            name="state"
            value={v.state}
            onChange={set("state")}
            error={err("state")}
          />
          <Field
            label="PIN code"
            name="postalCode"
            inputMode="numeric"
            value={v.postalCode}
            onChange={set("postalCode")}
            error={err("postalCode")}
          />
          <Field
            label="Total beds"
            name="totalBeds"
            inputMode="numeric"
            value={v.totalBeds}
            onChange={set("totalBeds")}
            error={err("totalBeds")}
          />
          <Field
            label="Latitude"
            name="latitude"
            inputMode="decimal"
            value={v.latitude}
            onChange={set("latitude")}
            error={err("latitude")}
            hint="For the emergency map"
          />
          <Field
            label="Longitude"
            name="longitude"
            inputMode="decimal"
            value={v.longitude}
            onChange={set("longitude")}
            error={err("longitude")}
          />
          <Textarea
            label="Description"
            name="description"
            value={v.description}
            onChange={set("description")}
            error={err("description")}
            className="sm:col-span-2"
          />
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold text-slate-900">Contact</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Phone"
            name="phone"
            type="tel"
            value={v.phone}
            onChange={set("phone")}
            error={err("phone")}
          />
          <Field
            label="Emergency number"
            name="emergencyPhone"
            type="tel"
            value={v.emergencyPhone}
            onChange={set("emergencyPhone")}
            error={err("emergencyPhone")}
          />
          <Field
            label="Email"
            name="email"
            type="email"
            value={v.email}
            onChange={set("email")}
            error={err("email")}
            className="sm:col-span-2"
          />
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold text-slate-900">Platform settings</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Commission %"
            name="commissionPercent"
            inputMode="decimal"
            value={v.commissionPercent}
            onChange={set("commissionPercent")}
            error={err("commissionPercent")}
            hint="Per online booking, up to 2 decimals"
          />
          <Field
            label="Timezone"
            name="timezone"
            value={v.timezone}
            onChange={set("timezone")}
            error={err("timezone")}
            hint="IANA name, e.g. Asia/Kolkata"
          />
          <Field
            label="Full refund until (hours before)"
            name="refundFullHours"
            inputMode="numeric"
            value={v.refundFullHours}
            onChange={set("refundFullHours")}
            error={err("refundFullHours")}
            hint="Patients cancelling at least this early get 100% back"
          />
          <Field
            label="Refund after that (%)"
            name="refundPartialPercent"
            inputMode="numeric"
            value={v.refundPartialPercent}
            onChange={set("refundPartialPercent")}
            error={err("refundPartialPercent")}
            hint="Later cancellations. Hospital cancellations always refund 100%"
          />
        </div>
      </Card>

      {creating && (
        <Card className="space-y-4">
          <h2 className="font-semibold text-slate-900">Hospital login</h2>
          <p className="text-sm text-slate-600">
            A temporary password is generated and shown once after saving. The hospital must change
            it at first login.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Account name"
              name="adminName"
              placeholder="Hospital name + Admin"
              value={v.adminName}
              onChange={set("adminName")}
              error={err("adminName")}
            />
            <Field
              label="Login ID"
              name="loginId"
              placeholder="generated, e.g. sunrise.admin"
              autoCapitalize="none"
              value={v.loginId}
              onChange={set("loginId")}
              error={err("loginId")}
            />
          </div>
          <Checkbox
            label="Approve now"
            hint="Otherwise the hospital starts as pending and you approve it from its page."
            checked={v.approve}
            onChange={(approve) => setV((p) => ({ ...p, approve }))}
          />
        </Card>
      )}

      <div className="flex justify-end">
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
