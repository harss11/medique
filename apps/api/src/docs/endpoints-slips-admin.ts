import { auditLogQuery } from "../modules/admin/admin.routes.js";
import { adminStatsQuery } from "../modules/analytics/analytics.routes.js";
import {
  adminUpdateHospitalSchema,
  blockHospitalSchema,
  createHospitalSchema,
  listHospitalsQuery,
  resetCredentialsSchema,
} from "../modules/hospitals/hospitals.schemas.js";
import { slipTemplateBodySchema } from "../modules/slips/slip-fields.js";
import { testPrintSchema } from "../modules/slips/slip-templates.routes.js";
import { d, type EndpointRegistry } from "./endpoint-types.js";

const H = "Hospital panel";
const ADM = "Platform admin";

export const SLIP_AND_ADMIN_ENDPOINTS: EndpointRegistry = {
  "GET /hospital/slip-templates": d(H, "Slip templates with layouts"),
  "POST /hospital/slip-templates": d(H, "Create a slip template", {
    body: slipTemplateBodySchema,
    description:
      "Positions are millimetres from the paper's top-left corner. The first template becomes the default; at most 10.",
  }),
  "GET /hospital/slip-templates/:id": d(H, "One slip template"),
  "PATCH /hospital/slip-templates/:id": d(H, "Save a layout", { body: slipTemplateBodySchema }),
  "DELETE /hospital/slip-templates/:id": d(H, "Delete a template (another becomes default)"),
  "POST /hospital/slip-templates/:id/default": d(H, "Make this the template reception prints with"),
  "POST /hospital/slip-templates/:id/background": d(H, "Upload a scan of the blank slip", {
    upload: "background",
    description:
      "Editor backdrop only; never printed. 503 STORAGE_NOT_CONFIGURED without file storage.",
  }),
  "DELETE /hospital/slip-templates/:id/background": d(H, "Remove the scan"),
  "POST /hospital/slip-templates/test-print": d(H, "Print a sample from an unsaved layout", {
    body: testPrintSchema,
    pdf: true,
    description: "guides=true adds a ruler and field boxes for checking alignment on plain paper.",
  }),

  "GET /admin/audit-logs": d(ADM, "Audit log", {
    query: auditLogQuery,
    description:
      "Bookings, cancellations, refunds, credential changes and hospital changes, with who did them.",
  }),
  "GET /admin/stats": d(ADM, "Revenue and booking statistics", {
    query: adminStatsQuery,
    description:
      "Defaults to the last 30 days (at most 366). Bookings are counted by visit date; online money by the day it was paid and refunds by the day they were processed, per currency. Commission is MediQ's fee on the money kept after refunds. Cash taken at the desk is reported separately and carries no commission. refundsOutstanding lists refunds still owed to patients right now.",
  }),
  "GET /admin/hospitals": d(ADM, "Hospitals", { query: listHospitalsQuery }),
  "POST /admin/hospitals": d(ADM, "Create a hospital and its login", {
    body: createHospitalSchema,
    description: "Returns the hospital's temporary credentials once.",
  }),
  "GET /admin/hospitals/:id": d(ADM, "Hospital details, counts and staff logins"),
  "PATCH /admin/hospitals/:id": d(ADM, "Edit a hospital", { body: adminUpdateHospitalSchema }),
  "POST /admin/hospitals/:id/approve": d(ADM, "Approve a pending hospital"),
  "POST /admin/hospitals/:id/block": d(ADM, "Block a hospital", {
    body: blockHospitalSchema,
    description: "Staff cannot log in and patients cannot book.",
  }),
  "POST /admin/hospitals/:id/unblock": d(ADM, "Unblock a hospital"),
  "POST /admin/hospitals/:id/reset-credentials": d(ADM, "Reset a hospital login (shown once)", {
    body: resetCredentialsSchema,
  }),
  "POST /admin/jobs/generate-slots": d(ADM, "Generate slots for every doctor now"),
};
