"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Field } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";

export type CodePurpose = "REQUEST" | "BANK_REGISTRATION" | "RECOVERY";

const COOLDOWN_SECONDS = 60;

/**
 * Proving a phone number with a code, shared by every public blood flow. The code is checked by
 * the server when the form is finally submitted, not here, so nothing is "verified" in the browser.
 */
export function usePhoneCode(purpose: CodePurpose) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await api.post("/blood/otp", { phone, purpose }, { auth: false });
      setSent(true);
      setCode("");
      setWait(COOLDOWN_SECONDS);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === "OTP_COOLDOWN") setWait(COOLDOWN_SECONDS);
    } finally {
      setSending(false);
    }
  }

  return { phone, setPhone, code, setCode, sent, sending, error, wait, send };
}

export type PhoneCode = ReturnType<typeof usePhoneCode>;

export function PhoneCodeFields({
  state,
  phoneLabel = "Mobile number",
  hint,
  codeError,
}: {
  state: PhoneCode;
  phoneLabel?: string;
  hint?: string;
  codeError?: string;
}) {
  const { phone, setPhone, code, setCode, sent, sending, error, wait, send } = state;
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field
          className="flex-1"
          label={phoneLabel}
          name="blood-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="98765 43210"
          hint={hint}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Button
          type="button"
          variant="secondary"
          loading={sending}
          disabled={phone.trim().length < 8 || wait > 0}
          onClick={send}
        >
          {sent ? (wait > 0 ? "Resend in " + wait + "s" : "Resend code") : "Send code"}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {sent && (
        <Field
          label="6-digit code"
          name="blood-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          hint="Sent by SMS to this number."
          error={codeError}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
        />
      )}
    </div>
  );
}
