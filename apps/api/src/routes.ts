import { Router } from "express";
import { mount } from "./utils/mount.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { appointmentsRouter } from "./modules/appointments/appointments.routes.js";
import { deskRouter } from "./modules/desk/desk.routes.js";
import { hospitalPanelRouter } from "./modules/hospitals/hospital-panel.routes.js";
import { bloodBankRouter } from "./modules/blood/bank-panel.routes.js";
import { donorRouter } from "./modules/blood/donor.routes.js";
import { bloodPublicRouter } from "./modules/blood/blood-public.routes.js";
import { accountRouter } from "./modules/patients/account.routes.js";
import { historyRouter } from "./modules/patients/history.routes.js";
import { profilesRouter } from "./modules/patients/profiles.routes.js";
import { publicRouter } from "./modules/public/public.routes.js";
import { waitlistRouter } from "./modules/waitlist/waitlist.routes.js";

/** Versioned REST API, shared by the web app and the future mobile app. */
export const apiRouter = Router();

mount(apiRouter, "/auth", authRouter);
mount(apiRouter, "/admin", adminRouter);
mount(apiRouter, "/hospital", hospitalPanelRouter);
mount(apiRouter, "/public", publicRouter);
mount(apiRouter, "/patient/profiles", profilesRouter);
mount(apiRouter, "/patient/account", accountRouter);
mount(apiRouter, "/patient/history", historyRouter);
mount(apiRouter, "/appointments", appointmentsRouter);
mount(apiRouter, "/waitlist", waitlistRouter);
mount(apiRouter, "/desk", deskRouter);
mount(apiRouter, "/blood", bloodPublicRouter);
mount(apiRouter, "/blood-bank", bloodBankRouter);
mount(apiRouter, "/donor", donorRouter);
