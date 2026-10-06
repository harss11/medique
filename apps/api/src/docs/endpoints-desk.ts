import {
  bulkSlipSchema,
  cancelSchema as deskCancelSchema,
  dayQuery,
  slotsQuery as deskSlotsQuery,
  walkInSchema,
} from "../modules/desk/desk.routes.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const DESK = "Desk and doctor queue";
const WHO =
  "Roles: receptionist, hospital admin or doctor. The hospital comes from the login. A doctor sees and acts on only their own patients (another doctor's data is a 404).";

export const DESK_ENDPOINTS: EndpointRegistry = {
  "GET /desk/doctors": d(DESK, "Doctors you can work with", { description: WHO }),
  "GET /desk/appointments": d(
    DESK,
    "A day's patients in token order, with counts and the live queue",
    {
      query: dayQuery,
      description:
        WHO +
        " Defaults to today in the hospital's timezone. For one doctor the response includes the queue state.",
    },
  ),
  "GET /desk/slots": d(
    DESK,
    "Slots a walk-in can take (current and later today, or a future day)",
    {
      query: deskSlotsQuery,
    },
  ),
  "POST /desk/appointments": d(DESK, "Book a walk-in patient", {
    body: walkInSchema,
    description:
      "Uses the same slot lock as online booking, so a walk-in and an online patient can never take one seat. The token is the next integer for that doctor and day. payment=CASH records cash received (the token is issued either way); PAY_LATER leaves it owed. Reception only.",
  }),
  "POST /desk/check-in": d(DESK, "Check a patient in by the code on their ticket", {
    description:
      "Body: { code }. The code is shown under the patient's QR. Today's appointments of this hospital only.",
  }),
  "GET /desk/appointments/:id": d(
    DESK,
    "One appointment (staff view, no check-in code or commission)",
  ),
  "POST /desk/appointments/:id/check-in": d(DESK, "Mark a booked patient as arrived", {
    description: "Reception only; today only. Checking in twice is harmless.",
  }),
  "POST /desk/appointments/:id/start": d(DESK, "Start the consultation", {
    description:
      "Body: { completeCurrent?: boolean }. Only one patient can be with a doctor. If someone is still in, answers 409 IN_PROGRESS_EXISTS with details.currentToken unless completeCurrent is true.",
  }),
  "POST /desk/appointments/:id/complete": d(DESK, "Finish the consultation"),
  "POST /desk/appointments/:id/no-show": d(DESK, "Mark the patient as not arrived"),
  "POST /desk/appointments/:id/cash": d(DESK, "Record cash received for an unpaid appointment", {
    description: "The token is unchanged. Creates a CASH payment recording who collected it.",
  }),
  "POST /desk/appointments/:id/cancel": d(DESK, "Cancel at the desk", {
    body: deskCancelSchema,
    description:
      "PATIENT_REQUEST follows the hospital's refund policy; HOSPITAL (doctor unavailable) refunds in full. Online payments are refunded through the gateway; cash refunds are recorded as paid back now and the response says how much to hand over.",
  }),
  "GET /desk/slip-templates": d(DESK, "Slip templates (names and paper sizes)"),
  "GET /desk/appointments/:id/slip": d(DESK, "Print one doctor slip (PDF, data only)", {
    pdf: true,
    description:
      "Optional ?templateId. Prints only the patient's details at the template's millimetre positions; the paper is pre-printed. Audit logged.",
  }),
  "POST /desk/slips": d(DESK, "Print many slips in one PDF", {
    pdf: true,
    body: bulkSlipSchema,
    description:
      "Chosen appointments, or everything still to be seen for a day (optionally one doctor). At most 300 per job.",
  }),
};
