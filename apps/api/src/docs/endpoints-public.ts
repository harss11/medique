import {
  changePasswordSchema,
  otpRequestSchema,
  otpVerifySchema,
  patientSignupSchema,
  staffLoginSchema,
} from "../modules/auth/auth.schemas.js";
import {
  cancelSchema as cancelOnlineSchema,
  listQuery as appointmentsListQuery,
  lockSchema,
  rescheduleSchema,
} from "../modules/appointments/appointments.routes.js";
import {
  createSchema as createProfileSchema,
  updateSchema as updateProfileSchema,
} from "../modules/patients/profiles.routes.js";
import {
  doctorsQuery,
  emergencyQuery,
  hospitalsQuery,
  queueQuery,
  slotsQuery as publicSlotsQuery,
} from "../modules/public/public.routes.js";
import { languageSchema } from "../modules/patients/account.routes.js";
import { historyQuery } from "../modules/patients/history.routes.js";
import { doctorSearchQuery } from "../modules/search/search.routes.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const AUTH = "Auth";
const PUB = "Public (no login)";
const PAT = "Patient";

export const PUBLIC_AND_PATIENT_ENDPOINTS: EndpointRegistry = {
  "GET /health": d("System", "Liveness and database check", {
    description:
      "Returns 503 DB_UNAVAILABLE when the database cannot be reached. Used by the hosting platform.",
  }),

  "POST /auth/staff/login": d(AUTH, "Staff login (login ID and password)", {
    body: staffLoginSchema,
    description:
      "For hospital admins, receptionists, doctors and the platform admin. Locks the account after repeated failures. A temporary password forces a change before anything else works.",
  }),
  "POST /auth/otp/request": d(AUTH, "Send a login code to a patient's phone", {
    body: otpRequestSchema,
    description:
      "Rate limited per IP and per phone number. Always answers the same way whether or not the number has an account.",
  }),
  "POST /auth/otp/verify": d(AUTH, "Check the code; sign in or begin signup", {
    body: otpVerifySchema,
    description: "Returns a session, or { status: SIGNUP_REQUIRED, signupToken } for a new number.",
  }),
  "POST /auth/patient/signup": d(AUTH, "Create a patient account", {
    body: patientSignupSchema,
    description:
      "Requires accepting the privacy policy and terms; the acceptance is stored with the version.",
  }),
  "POST /auth/refresh": d(AUTH, "Get a new access token", {
    description:
      "Web: uses the httpOnly refresh cookie and needs the X-Requested-With header. Mobile: send X-Client-Type: mobile and the refreshToken in the body. Refresh tokens rotate; reusing an old one ends the whole session.",
  }),
  "POST /auth/logout": d(AUTH, "End this device's session"),
  "GET /auth/me": d(AUTH, "The signed-in user"),
  "POST /auth/change-password": d(AUTH, "Change password (staff)", {
    body: changePasswordSchema,
    description: "Signs out every other device. Allowed while a temporary password is pending.",
  }),

  "GET /public/hospitals": d(PUB, "Search active hospitals", { query: hospitalsQuery }),
  "GET /public/search/doctors": d(PUB, "Search doctors across hospitals", {
    query: doctorSearchQuery,
    description:
      "Words (every word must match a name, speciality, qualification, department, hospital or city), then filters: city, specialization, gender, language, minRating, maxFee (paise) and availableOn (a day with a free seat). sort: recommended (default), soonest, rating, fee_asc, fee_desc, experience. Each doctor carries rating and nextAvailable. facets lists the values people can filter by. capped is true when more than 1000 doctors matched the words: narrow the search.",
  }),
  "GET /public/hospitals/:slug": d(PUB, "A hospital page with the departments that have doctors"),
  "GET /public/hospitals/:slug/doctors": d(PUB, "Doctors of a hospital", { query: doctorsQuery }),
  "GET /public/doctors/:id": d(PUB, "A doctor with their hospital"),
  "GET /public/doctors/:id/availability": d(PUB, "Days with free slots in the booking window", {
    description:
      "dates: days with a free slot. fullDates: days that have slots, all taken (a patient can join the waitlist).",
  }),
  "GET /public/doctors/:id/slots": d(PUB, "Slots of one day", { query: publicSlotsQuery }),
  "GET /public/slots/:id": d(PUB, "One slot with its doctor and hospital"),
  "GET /public/queue/:token": d(PUB, "Live queue of a doctor today", {
    query: queueQuery,
    description:
      ":token is the doctor's QR token. Numbers only (now serving, waiting, last token), never names. ?token=N adds the estimated wait for that token (people ahead x average consultation minutes).",
  }),
  "GET /public/emergency": d(PUB, "Nearest open hospitals with emergency numbers", {
    query: emergencyQuery,
    description:
      "Nearest first when lat and lng are given. Bed counts older than 24 hours are flagged bedsStale.",
  }),

  "POST /appointments/lock": d(PAT, "Hold a slot for 5 minutes", {
    body: lockSchema,
    description:
      "Locks the slot row inside a transaction, so two patients can never hold the same seat. The hold expires on its own if unpaid. Rate limited.",
  }),
  "GET /appointments": d(PAT, "My appointments", { query: appointmentsListQuery }),
  "GET /appointments/:id": d(PAT, "One of my appointments", {
    description:
      "Includes the check-in code and QR value, the refund policy and what cancelling would refund now.",
  }),
  "POST /appointments/:id/payment-order": d(PAT, "Create a payment order for a held slot", {
    description:
      "Created at the server's price. The booking is confirmed only by the verified payment webhook, never by this call or the browser.",
  }),
  "POST /appointments/:id/mock-pay": d(PAT, "Pretend to pay (development only)", {
    description:
      "Answers 404 unless PAYMENT_MODE=mock. The API refuses to start in production with mock payments.",
  }),
  "POST /appointments/:id/cancel": d(PAT, "Cancel my appointment", {
    body: cancelOnlineSchema,
    description:
      "Frees the seat and queues a refund by the hospital's policy. Closed shortly before the visit.",
  }),
  "POST /appointments/:id/reschedule": d(PAT, "Move to another slot of the same doctor", {
    body: rescheduleSchema,
    description:
      "No new payment. Issues a new token and QR. Limited number of reschedules per appointment.",
  }),
  "GET /appointments/:id/receipt": d(PAT, "PDF receipt", { pdf: true }),

  "GET /patient/profiles": d(PAT, "My family profiles"),
  "POST /patient/profiles": d(PAT, "Add a family member", { body: createProfileSchema }),
  "PATCH /patient/profiles/:id": d(PAT, "Edit a profile", { body: updateProfileSchema }),
  "DELETE /patient/profiles/:id": d(PAT, "Remove a profile (not one with upcoming visits)"),

  "GET /patient/history": d(PAT, "My past visits", {
    query: historyQuery,
    description:
      "Visits that happened, across hospitals and the family profiles I manage, newest first. scope=all adds cancelled and missed ones. Optional profileId (one of my profiles) and year. summary has the number of visits, doctors and hospitals and what I paid after refunds. Each visit says whether it can still be reviewed.",
  }),
  "PATCH /patient/account/language": d(PAT, "Choose my language", {
    body: languageSchema,
    description:
      "en or hi. Used for the SMS MediQ sends me from now on (booking, reminders, waitlist, blood alerts). Messages already queued keep the language they were queued in.",
  }),
  "GET /patient/account/export": d(PAT, "Download a copy of my data", {
    description:
      "Everything held about the signed-in patient: account, consents, profiles, appointments with their payments and refunds. A patient's right of access under the DPDP Act.",
  }),
  "POST /patient/account/erase": d(PAT, "Erase my account", {
    description:
      'Body: { confirm: "ERASE" }. Removes name, phone, date of birth, messages and device records, and signs the patient out everywhere. Appointments, fees and payment records are kept without personal details. Answers 409 ERASE_BLOCKED while an appointment is upcoming, a slot is on hold or a refund is still on its way.',
  }),

  "POST /webhooks/razorpay": d("Webhooks", "Razorpay payment events", {
    description:
      "Called by Razorpay, not by clients. The raw body is checked against the X-Razorpay-Signature HMAC; every event is stored once (replays do nothing); amounts are checked against the order. This is the only thing that confirms a booking.",
  }),
};
