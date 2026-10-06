"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { intOrNull, textOrNull, toMajor, toMinor } from "@/lib/format";
import type { Department, Doctor, Paginated } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { Alert, Button, Checkbox, Field, Select, Textarea } from "../ui";

/**
 * Add or edit a doctor. Fees are typed in rupees and sent in paise.
 * `onSaved` receives the API's doctor object.
 */
export function DoctorForm({
  doctor,
  onSaved,
  onCancel,
  submitLabel = "Save",
}: {
  doctor?: Doctor;
  onSaved: (doctor: Doctor) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const departments = useApi<Paginated<Department>>("/hospital/departments?limit=100");
  const [v, setV] = useState({
    name: doctor?.name ?? "",
    departmentId: doctor?.departmentId ?? "",
    qualification: doctor?.qualification ?? "",
    specialization: doctor?.specialization ?? "",
    registrationNumber: doctor?.registrationNumber ?? "",
    experienceYears: doctor?.experienceYears?.toString() ?? "",
    gender: doctor?.gender ?? "",
    languages: doctor?.languages.join(", ") ?? "",
    fee: doctor ? toMajor(doctor.consultationFee) : "",
    avgConsultMinutes: doctor?.avgConsultMinutes.toString() ?? "10",
    bio: doctor?.bio ?? "",
    isActive: doctor?.isActive ?? true,
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

    const consultationFee = toMinor(v.fee);
    const experienceYears = intOrNull(v.experienceYears);
    const avgConsultMinutes = Number(v.avgConsultMinutes);
    const local: Record<string, string> = {};
    if (Number.isNaN(consultationFee)) local.consultationFee = "Enter the fee in rupees, e.g. 500";
    if (Number.isNaN(experienceYears)) local.experienceYears = "Whole years";
    if (!Number.isInteger(avgConsultMinutes)) local.avgConsultMinutes = "Whole minutes";
    if (!v.departmentId) local.departmentId = "Choose a department";
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }

    const body: Record<string, unknown> = {
      name: v.name.trim(),
      departmentId: v.departmentId,
      qualification: textOrNull(v.qualification),
      specialization: textOrNull(v.specialization),
      registrationNumber: textOrNull(v.registrationNumber),
      experienceYears,
      gender: v.gender || null,
      languages: v.languages
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
      consultationFee,
      avgConsultMinutes,
      bio: textOrNull(v.bio),
    };
    if (doctor) body.isActive = v.isActive;

    setBusy(true);
    try {
      const saved = doctor
        ? await api.patch<Doctor>(`/hospital/doctors/${doctor.id}`, body)
        : await api.post<Doctor>("/hospital/doctors", body);
      onSaved(saved);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const depts = departments.data?.items ?? [];

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      {departments.data && depts.length === 0 && (
        <Alert tone="info">Add a department first (Departments tab).</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Full name"
          name="name"
          placeholder="Dr. Anil Sharma"
          required
          value={v.name}
          onChange={set("name")}
          error={errors.name}
        />
        <Select
          label="Department"
          name="departmentId"
          value={v.departmentId}
          onChange={set("departmentId")}
          error={errors.departmentId}
        >
          <option value="">Choose…</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {!d.isActive ? " (hidden)" : ""}
            </option>
          ))}
        </Select>
        <Field
          label="Consultation fee"
          name="fee"
          prefix="₹"
          inputMode="decimal"
          required
          value={v.fee}
          onChange={set("fee")}
          error={errors.consultationFee}
        />
        <Field
          label="Average consult (minutes)"
          name="avgConsultMinutes"
          inputMode="numeric"
          value={v.avgConsultMinutes}
          onChange={set("avgConsultMinutes")}
          error={errors.avgConsultMinutes}
          hint="Used for queue wait estimates"
        />
        <Field
          label="Qualification"
          name="qualification"
          placeholder="MBBS, MD"
          value={v.qualification}
          onChange={set("qualification")}
          error={errors.qualification}
        />
        <Field
          label="Specialization"
          name="specialization"
          value={v.specialization}
          onChange={set("specialization")}
          error={errors.specialization}
        />
        <Field
          label="Medical registration no."
          name="registrationNumber"
          value={v.registrationNumber}
          onChange={set("registrationNumber")}
          error={errors.registrationNumber}
        />
        <Field
          label="Experience (years)"
          name="experienceYears"
          inputMode="numeric"
          value={v.experienceYears}
          onChange={set("experienceYears")}
          error={errors.experienceYears}
        />
        <Select
          label="Gender"
          name="gender"
          value={v.gender}
          onChange={set("gender")}
          error={errors.gender}
        >
          <option value="">Not specified</option>
          <option value="FEMALE">Female</option>
          <option value="MALE">Male</option>
          <option value="OTHER">Other</option>
        </Select>
        <Field
          label="Languages"
          name="languages"
          placeholder="English, Hindi"
          value={v.languages}
          onChange={set("languages")}
          error={errors.languages}
          hint="Comma separated"
        />
        <Textarea
          label="About"
          name="bio"
          value={v.bio}
          onChange={set("bio")}
          error={errors.bio}
          className="sm:col-span-2"
        />
      </div>
      {doctor && (
        <Checkbox
          label="Active (accepting bookings)"
          hint="Turning this off removes future open slots; booked ones are kept."
          checked={v.isActive}
          onChange={(isActive) => setV((p) => ({ ...p, isActive }))}
        />
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
