import { joinSchema, waitlistQuery } from "../modules/waitlist/waitlist.routes.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const PAT = "Patient";

export const WAITLIST_ENDPOINTS: EndpointRegistry = {
  "GET /waitlist": d(PAT, "The days I am waiting for", {
    query: waitlistQuery,
    description:
      "Each entry shows my place in the line, whether seats are open right now and, once I was told, until when I should book.",
  }),
  "POST /waitlist": d(PAT, "Wait for a seat on a fully booked day", {
    body: joinSchema,
    description:
      "Only for a day that has bookable slots, all full, inside the booking window. Answers SLOTS_AVAILABLE when a seat is free (book it instead), ALREADY_BOOKED, ALREADY_ON_WAITLIST or WAITLIST_LIMIT. When a seat opens the oldest waiting patients get an SMS. The seat is not held for them: whoever books first gets it. Rate limited.",
  }),
  "DELETE /waitlist/:id": d(PAT, "Stop waiting"),
};
