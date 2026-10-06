import type { Prisma } from "../../generated/prisma/client.js";
import { formatMoneyPdf } from "../receipts/receipt.service.js";
import { formatTimeShort } from "../../utils/time.js";
import { formatCheckInCode } from "../appointments/booking-rules.js";
import { ageInYears } from "../queue/queue-rules.js";
import type { SlipValues } from "./slip-fields.js";

/** Everything needed to print one slip, loaded in one query. */
export const slipAppointmentInclude = {
  patientProfile: { select: { fullName: true, phone: true, dateOfBirth: true, gender: true } },
  doctor: { select: { name: true, qualification: true } },
  department: { select: { name: true } },
  hospital: { select: { name: true, timezone: true } },
} satisfies Prisma.AppointmentInclude;

export type SlipAppointment = Prisma.AppointmentGetPayload<{
  include: typeof slipAppointmentInclude;
}>;

const GENDER_LETTER = { MALE: "M", FEMALE: "F", OTHER: "O", UNDISCLOSED: "" } as const;

/** "12 Oct 2026" in the hospital's timezone. */
function dateText(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(instant);
}

/** The text that goes into each slip field for one appointment. */
export function slipValuesFor(a: SlipAppointment, now: Date = new Date()): SlipValues {
  const age = ageInYears(a.patientProfile.dateOfBirth, now);
  const gender = a.patientProfile.gender ? GENDER_LETTER[a.patientProfile.gender] : "";
  const tz = a.hospital.timezone;
  return {
    patientName: a.patientProfile.fullName,
    patientAge: age != null ? String(age) : "",
    patientGender: gender,
    patientAgeGender: [age != null ? String(age) : "", gender].filter(Boolean).join(" / "),
    patientPhone: a.patientProfile.phone ?? "",
    doctorName: a.doctor.name,
    doctorQualification: a.doctor.qualification ?? "",
    department: a.department.name,
    date: dateText(a.slotStart, tz),
    time: formatTimeShort(a.slotStart, tz),
    tokenNumber: a.tokenNumber != null ? String(a.tokenNumber) : "",
    hospitalName: a.hospital.name,
    reasonForVisit: a.reasonForVisit ?? "",
    fee: formatMoneyPdf(a.feeAmount, a.currency),
    checkInCode: formatCheckInCode(a.checkInCode),
  };
}
