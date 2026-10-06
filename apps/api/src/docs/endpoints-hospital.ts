import {
  createDoctorLoginSchema,
  createDoctorSchema,
  createLeaveSchema,
  listDoctorsQuery,
  listLeavesQuery,
  listSlotsQuery,
  updateDoctorSchema,
  updateSlotSchema,
} from "../modules/doctors/doctors.schemas.js";
import {
  createSchema as createDepartmentSchema,
  listQuery as departmentsListQuery,
  updateSchema as updateDepartmentSchema,
} from "../modules/hospitals/departments.routes.js";
import { hospitalAnalyticsQuery } from "../modules/analytics/analytics.routes.js";
import {
  updateEmergencySchema,
  updateProfileSchema,
} from "../modules/hospitals/hospitals.schemas.js";
import {
  createReceptionistSchema,
  listQuery as staffListQuery,
} from "../modules/staff/staff.routes.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const H = "Hospital panel";
const HOSP =
  "Role: hospital admin, for their own hospital only (another hospital's records are a 404).";

export const HOSPITAL_ENDPOINTS: EndpointRegistry = {
  "GET /hospital/summary": d(H, "Overview and setup checklist", { description: HOSP }),
  "GET /hospital/profile": d(H, "Hospital profile", { description: HOSP }),
  "PATCH /hospital/profile": d(H, "Edit profile", { body: updateProfileSchema, description: HOSP }),
  "PATCH /hospital/emergency": d(H, "Emergency number and bed count", {
    body: updateEmergencySchema,
    description: HOSP + " Shown on the public emergency finder.",
  }),

  "GET /hospital/analytics": d(H, "This hospital's bookings, money and busy times", {
    query: hospitalAnalyticsQuery,
    description:
      HOSP +
      " Defaults to the last 30 days in the hospital's timezone. Includes per-doctor and per-department counts, bookings by hour of day, average wait (check-in to doctor) and consultation minutes, online money received, MediQ's commission and what the hospital keeps, and cash taken at the desk.",
  }),

  "GET /hospital/departments": d(H, "Departments", { query: departmentsListQuery }),
  "POST /hospital/departments": d(H, "Add a department", { body: createDepartmentSchema }),
  "PATCH /hospital/departments/:id": d(H, "Edit a department", { body: updateDepartmentSchema }),
  "DELETE /hospital/departments/:id": d(H, "Delete a department (not one with doctors)"),

  "GET /hospital/doctors": d(H, "Doctors", { query: listDoctorsQuery }),
  "POST /hospital/doctors": d(H, "Add a doctor", { body: createDoctorSchema }),
  "GET /hospital/doctors/:id": d(H, "A doctor with schedules"),
  "PATCH /hospital/doctors/:id": d(H, "Edit a doctor", {
    body: updateDoctorSchema,
    description: "Changing isActive regenerates their slots.",
  }),
  "DELETE /hospital/doctors/:id": d(H, "Remove a doctor (kept if they have bookings)"),
  "POST /hospital/doctors/:id/photo": d(H, "Upload a photo", {
    upload: "photo",
    description: "PNG or JPG checked by content, 5 MB at most.",
  }),
  "DELETE /hospital/doctors/:id/photo": d(H, "Remove the photo"),
  "POST /hospital/doctors/:id/login": d(H, "Create a login for the doctor", {
    body: createDoctorLoginSchema,
    description: "Returns the temporary password once.",
  }),
  "PUT /hospital/doctors/:id/schedules": d(H, "Replace weekly timings", {
    description:
      "Body: { sessions: [...] }, several sessions per day allowed. Regenerates slots; slots with bookings are never deleted.",
  }),
  "GET /hospital/doctors/:id/leaves": d(H, "Leaves", { query: listLeavesQuery }),
  "POST /hospital/doctors/:id/leaves": d(H, "Add a leave", { body: createLeaveSchema }),
  "DELETE /hospital/leaves/:id": d(H, "Remove a leave"),
  "GET /hospital/doctors/:id/slots": d(H, "Slot grid", { query: listSlotsQuery }),
  "POST /hospital/doctors/:id/slots/generate": d(H, "Generate slots now"),
  "PATCH /hospital/slots/:id": d(H, "Block or reopen one slot", { body: updateSlotSchema }),

  "GET /hospital/staff": d(H, "Receptionists and doctor logins", { query: staffListQuery }),
  "POST /hospital/staff/receptionists": d(H, "Create a receptionist login", {
    body: createReceptionistSchema,
    description: "Returns the temporary password once.",
  }),
  "POST /hospital/staff/:id/reset-password": d(H, "Reset a staff password (shown once)"),
  "POST /hospital/staff/:id/block": d(H, "Block a staff login"),
  "POST /hospital/staff/:id/unblock": d(H, "Unblock a staff login"),
};
