import { BLOOD_ENDPOINTS } from "./endpoints-blood.js";
import { DESK_ENDPOINTS } from "./endpoints-desk.js";
import { HOSPITAL_ENDPOINTS } from "./endpoints-hospital.js";
import { PUBLIC_AND_PATIENT_ENDPOINTS } from "./endpoints-public.js";
import { REVIEW_ENDPOINTS } from "./endpoints-reviews.js";
import { SLIP_AND_ADMIN_ENDPOINTS } from "./endpoints-slips-admin.js";
import { SUBSCRIPTION_ENDPOINTS } from "./endpoints-subscriptions.js";
import { WAITLIST_ENDPOINTS } from "./endpoints-waitlist.js";
import type { EndpointRegistry } from "./endpoint-types.js";

/** Every endpoint's description. A test fails if a route has no entry or an entry has no route. */
export const ENDPOINTS: EndpointRegistry = {
  ...PUBLIC_AND_PATIENT_ENDPOINTS,
  ...DESK_ENDPOINTS,
  ...HOSPITAL_ENDPOINTS,
  ...SLIP_AND_ADMIN_ENDPOINTS,
  ...BLOOD_ENDPOINTS,
  ...REVIEW_ENDPOINTS,
  ...WAITLIST_ENDPOINTS,
  ...SUBSCRIPTION_ENDPOINTS,
};

/** Display order of the groups in the reference. */
export const TAG_ORDER = [
  "System",
  "Auth",
  "Public (no login)",
  "Patient",
  "Desk and doctor queue",
  "Hospital panel",
  "Platform admin",
  "Blood: public (no login)",
  "Blood: donor",
  "Blood bank panel",
  "Webhooks",
];
