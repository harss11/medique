import { listBloodBanksQuery } from "../modules/blood/admin-banks.routes.js";
import { listBloodRequestsQuery } from "../modules/blood/admin-requests.routes.js";
import {
  blockBankSchema,
  createBankStaffSchema,
  registerBankSchema,
  rejectBankSchema,
  updateBankSchema,
} from "../modules/blood/bank.schemas.js";
import { stockSchema } from "../modules/blood/bank-panel.routes.js";
import { bloodOtpSchema } from "../modules/blood/blood-public.routes.js";
import {
  availabilitySchema,
  donorProfileSchema,
  lookupQuery,
  recordDonationSchema,
  voidDonationSchema,
} from "../modules/blood/donor.schemas.js";
import { bloodBanksQuery } from "../modules/blood/public-banks.routes.js";
import {
  cancelByAdminSchema,
  closeRequestSchema,
  createRequestSchema,
  recoverRequestsSchema,
  respondSchema,
} from "../modules/blood/request.schemas.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const PUB = "Blood: public (no login)";
const DONOR = "Blood: donor";
const BANK = "Blood bank panel";
const ADM = "Platform admin";

const NOTE =
  "MediQ only connects people. Availability and safety of blood are the blood bank's responsibility, and blood must never be paid for through MediQ.";
const KEY_HEADER = {
  name: "X-Blood-Request-Key",
  description:
    "The secret key returned when the request was created (or recovered). Never put it in a URL.",
  required: true,
};
const BANK_WHO = "Role: blood bank staff, for their own blood bank only.";
const ACTIVE_ONLY =
  " The blood bank must have been verified by MediQ (otherwise 403 BANK_NOT_VERIFIED).";

export const BLOOD_ENDPOINTS: EndpointRegistry = {
  "GET /public/blood-banks": d(PUB, "Find verified blood banks", {
    query: bloodBanksQuery,
    description:
      "Only banks MediQ has verified are listed. Stock figures older than the configured age carry stale: true (call to confirm). " +
      NOTE,
  }),
  "GET /public/blood-banks/:id": d(PUB, "One verified blood bank with its stock"),

  "POST /blood/otp": d(PUB, "Send a verification code", {
    body: bloodOtpSchema,
    description:
      "purpose REQUEST (to ask for blood), BANK_REGISTRATION (to register a blood bank) or RECOVERY (to get back into an open request). Recovery answers the same whether or not the number has an open request. Rate limited per address and per number.",
  }),
  "POST /blood/banks/register": d(PUB, "Register a blood bank", {
    body: registerBankSchema,
    description:
      "The contact phone is proved with a BANK_REGISTRATION code and the first staff login is created with the chosen password. The bank is not listed and cannot operate until the platform admin verifies its licence (status PENDING_VERIFICATION).",
  }),
  "POST /blood/requests": d(PUB, "Ask for blood in an emergency", {
    body: createRequestSchema,
    description:
      "Needs a REQUEST code for the phone number. Donors of the same blood group near the hospital and nearby blood banks are alerted by SMS. Limited per number per day, with no duplicate open request for the same group and hospital. Returns the secret key once; only its hash is stored. " +
      NOTE,
  }),
  "POST /blood/requests/recover": d(PUB, "Get back into my open requests", {
    body: recoverRequestsSchema,
    description:
      "Needs a RECOVERY code. Every open request of the number gets a new key (the old one stops working) and the new keys are returned.",
  }),
  "GET /blood/requests/:id": d(PUB, "See my request and who can help", {
    headers: [KEY_HEADER],
    description:
      "A donor's phone number appears only while that donor's I-can-help stands and the request is open. Blood banks that can help are shown with their public phone number. A wrong key and a wrong id answer the same 404.",
  }),
  "POST /blood/requests/:id/close": d(PUB, "Close my request", {
    headers: [KEY_HEADER],
    body: closeRequestSchema,
    description:
      "outcome FULFILLED or CANCELLED. Contact numbers disappear once a request is closed.",
  }),

  "GET /donor/profile": d(DONOR, "My donor profile", {
    description:
      "profile is null until the patient registers as a donor. Includes eligibility (age and waiting period).",
  }),
  "PUT /donor/profile": d(DONOR, "Register as a donor, or update my details", {
    body: donorProfileSchema,
    description:
      "The first time, acceptAlerts must be true: the donor agrees to be alerted and to share their phone number after saying I can help (recorded as a consent). Age must be within the allowed range. Once a blood bank has confirmed the blood group at a donation, the group cannot be changed here. Location is rounded to about 1 km.",
  }),
  "PATCH /donor/availability": d(DONOR, "Pause or resume alerts", { body: availabilitySchema }),
  "DELETE /donor/profile": d(DONOR, "Stop being a donor", {
    description:
      "Removes the profile and its alerts and answers. Donation records stay with the blood bank, no longer linked to a person.",
  }),
  "GET /donor/donations": d(DONOR, "My donation history", {
    description:
      "Donations recorded for me by blood banks (voided ones are not shown). Nothing is issued: it is a record that sets my waiting period.",
  }),
  "GET /donor/requests": d(DONOR, "Open requests I was alerted to", {
    description: "Never shows the requester's phone number, only their first name.",
  }),
  "POST /donor/requests/:id/respond": d(DONOR, "I can help / I cannot", {
    body: respondSchema,
    description:
      "Only for a request the donor was alerted to (otherwise 404). CAN_HELP is refused while the donor is not eligible (409 DONOR_NOT_ELIGIBLE). The first answer sends the requester one SMS. Answering CANNOT withdraws an earlier I-can-help and hides the donor's number again.",
  }),

  "GET /blood-bank/profile": d(BANK, "My blood bank", {
    description: BANK_WHO + " Includes the verification outcome and any rejection reason.",
  }),
  "PATCH /blood-bank/profile": d(BANK, "Edit my blood bank's details", {
    body: updateBankSchema,
    description:
      BANK_WHO +
      " The name and licence are locked once verified (400 FIELD_LOCKED). A rejected bank can fix them, which sends it back for verification.",
  }),
  "GET /blood-bank/stock": d(BANK, "Stock by blood group", { description: BANK_WHO }),
  "PUT /blood-bank/stock": d(BANK, "Update units on the shelf", {
    body: stockSchema,
    description: BANK_WHO + ACTIVE_ONLY + " Audited with before and after.",
  }),
  "GET /blood-bank/staff": d(BANK, "Staff logins of my blood bank", { description: BANK_WHO }),
  "POST /blood-bank/staff": d(BANK, "Add a colleague login", {
    body: createBankStaffSchema,
    description: BANK_WHO + " Returns the temporary password once.",
  }),
  "POST /blood-bank/staff/:id/reset-password": d(BANK, "Reset a colleague's password (shown once)"),
  "POST /blood-bank/staff/:id/block": d(BANK, "Block a colleague (not yourself)"),
  "POST /blood-bank/staff/:id/unblock": d(BANK, "Unblock a colleague"),
  "GET /blood-bank/donors/lookup": d(BANK, "Find a registered donor by phone", {
    query: lookupQuery,
    description:
      BANK_WHO +
      ACTIVE_ONLY +
      " The same 404 answer whether the number has no account or is not a donor. Every look-up is audited.",
  }),
  "POST /blood-bank/donations": d(BANK, "Record a donation", {
    body: recordDonationSchema,
    description:
      BANK_WHO +
      ACTIVE_ONLY +
      " Only blood bank staff can create donations. Refused with 409 DONOR_NOT_ELIGIBLE (with the date they can donate again) if the donor is too young or old or still in the waiting period (about 3 months for men, 4 for women and anyone who did not say). The donor's blood group is set to the one the bank confirmed, and the donor gets an SMS. Nothing is issued to the donor.",
  }),
  "GET /blood-bank/donations": d(BANK, "Donations recorded by my blood bank", {
    description: BANK_WHO + " Donor phone numbers are masked.",
  }),
  "POST /blood-bank/donations/:id/void": d(BANK, "Void a donation recorded by mistake", {
    body: voidDonationSchema,
    description:
      BANK_WHO +
      ACTIVE_ONLY +
      " Within 48 hours, with a reason. The donor's waiting period is recalculated from their earlier donations.",
  }),
  "GET /blood-bank/requests": d(BANK, "Open requests my blood bank was alerted to", {
    description: BANK_WHO,
  }),
  "POST /blood-bank/requests/:id/respond": d(BANK, "We can help / we cannot", {
    body: respondSchema,
    description:
      BANK_WHO + ACTIVE_ONLY + " The requester then sees the blood bank's public phone number.",
  }),

  "GET /admin/blood-banks": d(ADM, "Blood banks awaiting verification and all others", {
    query: listBloodBanksQuery,
  }),
  "GET /admin/blood-banks/:id": d(ADM, "A blood bank with licence details and staff"),
  "POST /admin/blood-banks/:id/approve": d(ADM, "Verify the licence and list the blood bank"),
  "POST /admin/blood-banks/:id/reject": d(ADM, "Reject (the bank can fix and resubmit)", {
    body: rejectBankSchema,
  }),
  "POST /admin/blood-banks/:id/block": d(ADM, "Block a listed blood bank", {
    body: blockBankSchema,
    description: "Its staff are signed out at once and it is no longer listed or alerted.",
  }),
  "POST /admin/blood-banks/:id/unblock": d(ADM, "Unblock a blood bank"),
  "GET /admin/blood-requests": d(ADM, "Emergency blood requests", {
    query: listBloodRequestsQuery,
  }),
  "POST /admin/blood-requests/:id/cancel": d(ADM, "Stop a request (for example abuse)", {
    body: cancelByAdminSchema,
  }),
};
