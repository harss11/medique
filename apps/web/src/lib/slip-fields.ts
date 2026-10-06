import type { SlipField, SlipFieldKey } from "./types";

/**
 * The data a slip can print. Keep in step with SLIP_FIELDS in
 * apps/api/src/modules/slips/slip-fields.ts (the API rejects unknown keys).
 */
export const SLIP_FIELD_LIST: Array<{ key: SlipFieldKey; label: string; sample: string }> = [
  { key: "patientName", label: "Patient name", sample: "Rahul Sharma" },
  { key: "patientAge", label: "Age", sample: "34" },
  { key: "patientGender", label: "Gender (M/F)", sample: "M" },
  { key: "patientAgeGender", label: "Age / gender", sample: "34 / M" },
  { key: "patientPhone", label: "Patient phone", sample: "+91 98765 43210" },
  { key: "doctorName", label: "Doctor", sample: "Dr. Anil Sharma" },
  {
    key: "doctorQualification",
    label: "Doctor qualification",
    sample: "MBBS, MD (Internal Medicine)",
  },
  { key: "department", label: "Department", sample: "General Medicine" },
  { key: "date", label: "Date", sample: "12 Oct 2026" },
  { key: "time", label: "Time", sample: "9:30 am" },
  { key: "tokenNumber", label: "Token number", sample: "12" },
  { key: "hospitalName", label: "Hospital name", sample: "Sunrise Multispeciality Hospital" },
  { key: "reasonForVisit", label: "Reason for visit", sample: "Fever and cough for 3 days" },
  { key: "fee", label: "Fee", sample: "₹500.00" },
  { key: "checkInCode", label: "Check-in code", sample: "K7M2-9QXF-3R" },
];

export const FIELD_INFO = Object.fromEntries(SLIP_FIELD_LIST.map((f) => [f.key, f])) as Record<
  SlipFieldKey,
  (typeof SLIP_FIELD_LIST)[number]
>;

export const PAPER_PRESETS = [
  { id: "a5", label: "A5 portrait (148 × 210 mm)", w: 148, h: 210 },
  { id: "a4", label: "A4 portrait (210 × 297 mm)", w: 210, h: 297 },
  { id: "a6", label: "A6 portrait (105 × 148 mm)", w: 105, h: 148 },
  { id: "a5l", label: "A5 landscape (210 × 148 mm)", w: 210, h: 148 },
  { id: "half", label: "Half A4 landscape (210 × 148.5 mm)", w: 210, h: 148.5 },
  { id: "thermal", label: "Thermal roll (80 × 120 mm)", w: 80, h: 120 },
] as const;

export const MAX_OFFSET_MM = 20;

/** Rounds to 0.1 mm, the precision the API stores. */
export const round1 = (n: number) => Math.round(n * 10) / 10;

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** A new field placed near the top-left, staggered so several new fields do not overlap. */
export function defaultField(key: SlipFieldKey, index: number, paperW: number): SlipField {
  return {
    key,
    xMm: round1(Math.min(10, Math.max(0, paperW - 45))),
    yMm: round1(10 + (index % 12) * 9),
    maxWidthMm: round1(Math.min(60, paperW - 10)),
    fontSizePt: key === "tokenNumber" ? 20 : 11,
    bold: key === "tokenNumber" || key === "patientName",
    align: "left",
  };
}

/** Keeps a field inside the paper after the paper size or the field itself changed. */
export function fitField(f: SlipField, paperW: number, paperH: number): SlipField {
  const maxWidthMm = round1(clamp(f.maxWidthMm, 5, paperW));
  return {
    ...f,
    maxWidthMm,
    xMm: round1(clamp(f.xMm, 0, Math.max(0, paperW - maxWidthMm))),
    yMm: round1(clamp(f.yMm, 0, paperH)),
  };
}
