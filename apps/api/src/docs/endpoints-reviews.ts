import { reviewSchema } from "../modules/appointments/appointments.routes.js";
import {
  adminReviewsQuery,
  hideReviewSchema,
  hospitalReviewsQuery,
  reportReviewSchema,
} from "../modules/reviews/reviews.routes.js";
import { paginationQuery } from "../utils/pagination.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const PUB = "Public (no login)";
const PAT = "Patient";
const HOSP = "Hospital panel";
const ADM = "Platform admin";

export const REVIEW_ENDPOINTS: EndpointRegistry = {
  "GET /public/doctors/:id/reviews": d(PUB, "Published reviews of a doctor", {
    query: paginationQuery,
    description:
      "Newest first, with the average and the count of each star. Reviewers appear as first name and initial only.",
  }),
  "GET /public/hospitals/:slug/reviews": d(PUB, "Published reviews across a hospital", {
    query: paginationQuery,
  }),

  "POST /appointments/:id/review": d(PAT, "Rate a completed visit", {
    body: reviewSchema,
    description:
      "Only the patient who booked the visit online, only once, only after the visit was completed and within the review window. Returns the appointment.",
  }),
  "PATCH /appointments/:id/review": d(PAT, "Change my review", {
    body: reviewSchema,
    description: "Allowed for a few days after writing it, and not once MediQ has hidden it.",
  }),
  "DELETE /appointments/:id/review": d(PAT, "Take my review back"),

  "GET /hospital/reviews": d(HOSP, "Reviews of my hospital", { query: hospitalReviewsQuery }),
  "POST /hospital/reviews/:id/report": d(HOSP, "Ask MediQ to look at a review", {
    body: reportReviewSchema,
    description: "A hospital cannot hide or change a review. The platform admin decides.",
  }),

  "GET /admin/reviews": d(ADM, "Reported and hidden reviews", { query: adminReviewsQuery }),
  "POST /admin/reviews/:id/hide": d(ADM, "Hide a review from the public", {
    body: hideReviewSchema,
  }),
  "POST /admin/reviews/:id/unhide": d(ADM, "Publish a hidden review again"),
  "POST /admin/reviews/:id/dismiss": d(ADM, "Keep the review: close the report"),
};
