import { z } from "zod";
import { passwordSchema } from "../../utils/password.js";

export const staffLoginSchema = z.object({
  loginId: z.string().trim().toLowerCase().min(3, "Enter your login ID").max(64),
  // Policy is not enforced at login (old passwords may predate it), only a sane bound.
  password: z.string().min(1, "Enter your password").max(200),
});

export const otpRequestSchema = z.object({
  phone: z.string().trim().min(6, "Enter a valid phone number").max(20),
});

export const otpVerifySchema = z.object({
  phone: z.string().trim().min(6).max(20),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const patientSignupSchema = z.object({
  signupToken: z.string().min(1),
  name: z.string().trim().min(2, "Enter your full name").max(100),
  acceptPrivacyPolicy: z.literal(true, "You must accept the privacy policy"),
  acceptTerms: z.literal(true, "You must accept the terms of service"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: passwordSchema,
});

export type StaffLoginInput = z.infer<typeof staffLoginSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type PatientSignupInput = z.infer<typeof patientSignupSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
