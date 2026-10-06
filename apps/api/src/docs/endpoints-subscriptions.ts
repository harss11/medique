import {
  assignSchema,
  paymentSchema,
  planSchema,
  reasonSchema,
  subscriptionsQuery,
  updatePlanSchema,
} from "../modules/subscriptions/subscriptions.routes.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const HOSP = "Hospital panel";
const ADM = "Platform admin";

export const SUBSCRIPTION_ENDPOINTS: EndpointRegistry = {
  "GET /hospital/subscription": d(HOSP, "My plan, limits, usage and payments", {
    description:
      "The plan, its state (TRIALING, ACTIVE, GRACE, EXPIRED, SUSPENDED, CANCELLED), days left, what is used against each limit and the payments MediQ recorded. notice says what to tell the hospital: ending_soon, grace, expired, suspended or cancelled.",
  }),

  "GET /admin/plans": d(ADM, "All plans, with how many hospitals use each"),
  "POST /admin/plans": d(ADM, "Create a plan", {
    body: planSchema,
    description:
      "Limits left out (null) are unlimited. A plan's code is its stable name and cannot be changed later.",
  }),
  "PATCH /admin/plans/:id": d(ADM, "Change a plan", {
    body: updatePlanSchema,
    description:
      "Only the fields given change. Hospitals on the plan get the new limits at once. The plan new hospitals start on cannot be switched off.",
  }),

  "GET /admin/subscriptions": d(ADM, "Hospitals whose subscription needs attention", {
    query: subscriptionsQuery,
    description:
      "attention (default): ending within 7 days, in grace, expired, suspended or cancelled, soonest end first. all: every hospital.",
  }),
  "GET /admin/subscriptions/:hospitalId": d(ADM, "One hospital's subscription"),
  "PUT /admin/subscriptions/:hospitalId": d(ADM, "Assign or change a hospital's plan", {
    body: assignSchema,
    description:
      "Give either trialDays (a trial) or periodMonths (a paid period starting now), not both. With neither, only a free plan is accepted. Payment is handled offline: record it with POST .../payments.",
  }),
  "POST /admin/subscriptions/:hospitalId/payments": d(ADM, "Record a payment received offline", {
    body: paymentSchema,
    description:
      "Bank transfer, UPI, cash or cheque. Buys periodMonths months, continuing from the end of the current paid period (or from today after a lapse), and makes the subscription ACTIVE.",
  }),
  "POST /admin/subscriptions/:hospitalId/suspend": d(ADM, "Stop online bookings for a hospital", {
    body: reasonSchema,
    description:
      "Existing appointments and desk bookings carry on. Patients cannot book new online appointments until the subscription is resumed.",
  }),
  "POST /admin/subscriptions/:hospitalId/resume": d(
    ADM,
    "Resume a suspended or cancelled subscription",
  ),
  "POST /admin/subscriptions/:hospitalId/cancel": d(ADM, "End a hospital's subscription", {
    body: reasonSchema,
  }),
};
