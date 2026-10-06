"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { textOrNull, todayIn } from "@/lib/format";
import type { PatientProfile, Relation } from "@/lib/types";
import { Alert, Button, Field, Select } from "../ui";

export const RELATION_LABEL: Record<Relation, string> = {
  SELF: "Myself",
  SPOUSE: "Spouse",
  CHILD: "Child",
  PARENT: "Parent",
  SIBLING: "Sibling",
  OTHER: "Other",
};

/** Add or edit a family member. Only what's needed to book: name, relation, optional DOB/gender/phone. */
export function ProfileForm({
  profile,
  onSaved,
  onCancel,
}: {
  profile?: PatientProfile;
  onSaved: (p: PatientProfile) => void;
  onCancel?: () => void;
}) {
  const isSelf = profile?.relation === "SELF";
  const [v, setV] = useState({
    fullName: profile?.fullName ?? "",
    relation: profile?.relation === "SELF" || !profile ? "CHILD" : profile.relation,
    dateOfBirth: profile?.dateOfBirth ?? "",
    gender: profile?.gender ?? "",
    phone: profile?.phone ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((p) => ({ ...p, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setError(null);
    setBusy(true);
    const body = {
      fullName: v.fullName.trim(),
      ...(isSelf ? {} : { relation: v.relation }),
      dateOfBirth: v.dateOfBirth,
      gender: textOrNull(v.gender),
      phone: v.phone.trim(),
    };
    try {
      const saved = profile
        ? await api.patch<PatientProfile>(`/patient/profiles/${profile.id}`, body)
        : await api.post<PatientProfile>("/patient/profiles", body);
      onSaved(saved);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field
        label="Full name"
        name="fullName"
        required
        autoFocus
        value={v.fullName}
        onChange={set("fullName")}
        error={errors.fullName}
        hint="As it should appear on the appointment slip."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {!isSelf && (
          <Select
            label="Relation"
            name="relation"
            value={v.relation}
            onChange={set("relation")}
            error={errors.relation}
          >
            {(["SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"] as const).map((r) => (
              <option key={r} value={r}>
                {RELATION_LABEL[r]}
              </option>
            ))}
          </Select>
        )}
        <Select
          label="Gender (optional)"
          name="gender"
          value={v.gender}
          onChange={set("gender")}
          error={errors.gender}
        >
          <option value="">Prefer not to say</option>
          <option value="FEMALE">Female</option>
          <option value="MALE">Male</option>
          <option value="OTHER">Other</option>
        </Select>
        <Field
          label="Date of birth (optional)"
          name="dateOfBirth"
          type="date"
          max={todayIn()}
          value={v.dateOfBirth}
          onChange={set("dateOfBirth")}
          error={errors.dateOfBirth}
        />
        <Field
          label="Phone (optional)"
          name="phone"
          type="tel"
          value={v.phone}
          onChange={set("phone")}
          error={errors.phone}
        />
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
