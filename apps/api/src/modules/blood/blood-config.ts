import { env } from "../../config/env.js";
import type { DonorRules } from "./blood-rules.js";

/** The waiting periods and age limits from the environment, as the rules module wants them. */
export const donorRules: DonorRules = {
  gapDaysMale: env.DONOR_GAP_DAYS_MALE,
  gapDaysOther: env.DONOR_GAP_DAYS_OTHER,
  minAge: env.DONOR_MIN_AGE,
  maxAge: env.DONOR_MAX_AGE,
};

/** A mistaken donation record can be voided for this long after it was made. */
export const VOID_WINDOW_HOURS = 48;
export const BLOOD_TIMEZONE = "Asia/Kolkata";
