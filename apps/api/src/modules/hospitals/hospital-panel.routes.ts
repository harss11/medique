import { mount } from "../../utils/mount.js";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/authorize.js";
import { hospitalAnalyticsRouter } from "../analytics/analytics.routes.js";
import { hospitalReviewsRouter } from "../reviews/reviews.routes.js";
import {
  hospitalSubscriptionRouter,
  requirePlanFeature,
} from "../subscriptions/subscriptions.routes.js";
import { doctorsRouter } from "../doctors/doctors.routes.js";
import { staffRouter } from "../staff/staff.routes.js";
import { slipTemplatesRouter } from "../slips/slip-templates.routes.js";
import { departmentsRouter } from "./departments.routes.js";
import { hospitalProfileRouter } from "./hospital-profile.routes.js";

/**
 * /hospital — the hospital admin's own panel. Every handler scopes queries to
 * the signed-in user's hospital (see scope.ts).
 */
export const hospitalPanelRouter = Router();

hospitalPanelRouter.use(authenticate(), requireRole("HOSPITAL_ADMIN"));

mount(hospitalPanelRouter, "/", hospitalProfileRouter);
mount(hospitalPanelRouter, "/departments", departmentsRouter);
mount(hospitalPanelRouter, "/staff", staffRouter);
hospitalPanelRouter.use("/slip-templates", requirePlanFeature("slipPrinting"));
hospitalPanelRouter.use("/analytics", requirePlanFeature("analytics"));
mount(hospitalPanelRouter, "/slip-templates", slipTemplatesRouter);
mount(hospitalPanelRouter, "/analytics", hospitalAnalyticsRouter);
mount(hospitalPanelRouter, "/subscription", hospitalSubscriptionRouter);
mount(hospitalPanelRouter, "/reviews", hospitalReviewsRouter);
mount(hospitalPanelRouter, "/", doctorsRouter);
