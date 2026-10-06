import { Router, type Request, type Response } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate.js";
import {
  loginLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshLimiter,
} from "../../middleware/rateLimit.js";
import { AppError, ok } from "../../utils/http.js";
import { requestMeta } from "../../utils/request.js";
import { parse } from "../../utils/validate.js";
import {
  changePasswordSchema,
  otpRequestSchema,
  otpVerifySchema,
  patientSignupSchema,
  staffLoginSchema,
} from "./auth.schemas.js";
import {
  changePassword,
  completePatientSignup,
  getCurrentUser,
  refreshSession,
  requestPatientOtp,
  staffLogin,
  verifyPatientOtp,
  type Session,
} from "./auth.service.js";
import {
  clearRefreshCookie,
  isMobileClient,
  readRefreshToken,
  revokeRefreshToken,
  setRefreshCookie,
} from "./tokens.js";

export const authRouter = Router();

/**
 * Web clients receive the refresh token only as an httpOnly cookie (JavaScript
 * never sees it). The mobile app receives it in the JSON body.
 */
function sendSession(req: Request, res: Response, session: Session, status = 200) {
  const mobile = isMobileClient(req);
  if (!mobile) setRefreshCookie(res, session.refreshToken, session.refreshTokenExpiresAt);
  return ok(
    res,
    {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      user: session.user,
      ...(mobile
        ? {
            refreshToken: session.refreshToken,
            refreshTokenExpiresAt: session.refreshTokenExpiresAt,
          }
        : {}),
    },
    status,
  );
}

/** POST /auth/staff/login — admin, hospital admin, receptionist, doctor */
authRouter.post("/staff/login", loginLimiter, async (req, res) => {
  const body = parse(staffLoginSchema, req.body);
  sendSession(req, res, await staffLogin(body, requestMeta(req)));
});

/** POST /auth/otp/request — send a login code to a patient's phone */
authRouter.post("/otp/request", otpRequestLimiter, async (req, res) => {
  const body = parse(otpRequestSchema, req.body);
  ok(res, await requestPatientOtp(body.phone, requestMeta(req)));
});

/** POST /auth/otp/verify — log in, or get a sign-up token for a new number */
authRouter.post("/otp/verify", otpVerifyLimiter, async (req, res) => {
  const body = parse(otpVerifySchema, req.body);
  const result = await verifyPatientOtp(body, requestMeta(req));
  if (result.status === "SIGNUP_REQUIRED") {
    return ok(res, { status: result.status, signupToken: result.signupToken });
  }
  return sendSession(req, res, result.session);
});

/** POST /auth/patient/signup — create the patient account after OTP + consent */
authRouter.post("/patient/signup", otpVerifyLimiter, async (req, res) => {
  const body = parse(patientSignupSchema, req.body);
  sendSession(req, res, await completePatientSignup(body, requestMeta(req)), 201);
});

/** POST /auth/refresh — rotate the refresh token and get a new access token */
authRouter.post("/refresh", refreshLimiter, async (req, res) => {
  const token = readRefreshToken(req);
  if (!token) throw AppError.unauthorized("Please log in", "NO_REFRESH_TOKEN");
  try {
    sendSession(req, res, await refreshSession(token, requestMeta(req)));
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
});

/** POST /auth/logout — revoke this device's refresh token */
authRouter.post("/logout", async (req, res) => {
  const token = readRefreshToken(req);
  if (token) await revokeRefreshToken(token);
  clearRefreshCookie(res);
  ok(res, null);
});

/** GET /auth/me */
authRouter.get("/me", authenticate({ allowPasswordChange: true }), async (req, res) => {
  ok(res, await getCurrentUser(requireAuth(req)));
});

/** POST /auth/change-password — also completes the forced first-login reset */
authRouter.post(
  "/change-password",
  loginLimiter,
  authenticate({ allowPasswordChange: true }),
  async (req, res) => {
    const body = parse(changePasswordSchema, req.body);
    sendSession(req, res, await changePassword(requireAuth(req), body, requestMeta(req)));
  },
);
