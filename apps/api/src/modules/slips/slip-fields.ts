import { z } from "zod";

/**
 * The pieces of data a doctor slip can print, and the validation of a slip template.
 * Positions are in millimetres from the top-left corner of the paper, so a template is
 * independent of screen size and printer resolution.
 */
export const SLIP_FIELDS = {
  patientName: { label: "Patient name", sample: "Rahul Sharma" },
  patientAge: { label: "Age", sample: "34" },
  patientGender: { label: "Gender (M/F)", sample: "M" },
  patientAgeGender: { label: "Age / gender", sample: "34 / M" },
  patientPhone: { label: "Patient phone", sample: "+91 98765 43210" },
  doctorName: { label: "Doctor", sample: "Dr. Anil Sharma" },
  doctorQualification: { label: "Doctor qualification", sample: "MBBS, MD (Internal Medicine)" },
  department: { label: "Department", sample: "General Medicine" },
  date: { label: "Date", sample: "12 Oct 2026" },
  time: { label: "Time", sample: "9:30 am" },
  tokenNumber: { label: "Token number", sample: "12" },
  hospitalName: { label: "Hospital name", sample: "Sunrise Multispeciality Hospital" },
  reasonForVisit: { label: "Reason for visit", sample: "Fever and cough for 3 days" },
  fee: { label: "Fee", sample: "₹500.00" },
  checkInCode: { label: "Check-in code", sample: "K7M2-9QXF-3R" },
} as const;

export type SlipFieldKey = keyof typeof SLIP_FIELDS;
export const SLIP_FIELD_KEYS = Object.keys(SLIP_FIELDS) as [SlipFieldKey, ...SlipFieldKey[]];

export type SlipValues = Partial<Record<SlipFieldKey, string>>;

export const SAMPLE_VALUES: SlipValues = Object.fromEntries(
  SLIP_FIELD_KEYS.map((key) => [key, SLIP_FIELDS[key].sample]),
);

export const MIN_PAPER_MM = 40;
export const MAX_PAPER_MM = 500;
export const MAX_OFFSET_MM = 20;

const mm = (min: number, max: number) => z.number().min(min).max(max);
/** Rounded to 0.1 mm: finer than any printer can place, and keeps stored values tidy. */
const roundMm = (v: number) => Math.round(v * 10) / 10;

export const slipFieldSchema = z.object({
  key: z.enum(SLIP_FIELD_KEYS),
  /** Left edge of the text box. */
  xMm: mm(0, MAX_PAPER_MM).transform(roundMm),
  /** Top edge of the text box. */
  yMm: mm(0, MAX_PAPER_MM).transform(roundMm),
  /** Width of the text box; text shrinks (down to 6 pt) and then truncates to fit. */
  maxWidthMm: mm(5, MAX_PAPER_MM).transform(roundMm),
  fontSizePt: mm(5, 48),
  bold: z.boolean().default(false),
  align: z.enum(["left", "center", "right"]).default("left"),
});
export type SlipField = z.output<typeof slipFieldSchema>;

export const slipTemplateBodySchema = z
  .object({
    name: z.string().trim().min(2, "Give the template a name").max(60),
    paperWidthMm: mm(MIN_PAPER_MM, MAX_PAPER_MM),
    paperHeightMm: mm(MIN_PAPER_MM, MAX_PAPER_MM),
    /** Printer calibration: shifts everything right (+) / down (+). */
    offsetXMm: mm(-MAX_OFFSET_MM, MAX_OFFSET_MM).default(0).transform(roundMm),
    offsetYMm: mm(-MAX_OFFSET_MM, MAX_OFFSET_MM).default(0).transform(roundMm),
    fields: z.array(slipFieldSchema).max(SLIP_FIELD_KEYS.length),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.fields.forEach((f, i) => {
      if (seen.has(f.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "key"],
          message: "Each field can be placed only once",
        });
      }
      seen.add(f.key);
      if (f.xMm > t.paperWidthMm) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "xMm"],
          message: "Field is outside the paper",
        });
      }
      if (f.yMm > t.paperHeightMm) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "yMm"],
          message: "Field is outside the paper",
        });
      }
      if (f.xMm + f.maxWidthMm > t.paperWidthMm + 0.05) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "maxWidthMm"],
          message: "Field is wider than the paper",
        });
      }
    });
  });

export type SlipTemplateBody = z.output<typeof slipTemplateBodySchema>;

/** Stored fields are re-validated when read, so a damaged row can never crash a print run. */
export function parseStoredFields(value: unknown): SlipField[] {
  const parsed = z.array(slipFieldSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
