import { z } from "zod";
import { BLOOD_GROUPS } from "./blood-rules.js";

/** The eight blood groups as a Zod enum. */
export const BLOOD_GROUP_VALUES = BLOOD_GROUPS as unknown as [
  (typeof BLOOD_GROUPS)[number],
  ...(typeof BLOOD_GROUPS)[number][],
];
export const bloodGroupSchema = z.enum(BLOOD_GROUP_VALUES);
