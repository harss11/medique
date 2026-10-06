"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, FullPageSpinner, Logo } from "@/components/ui";
import { ApiError, api, applySession } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/roles";
import type { Session } from "@/lib/types";

/** Mirrors the API policy so users get instant feedback; the API still validates. */
function passwordProblem(p: string): string | null {
  if (p.length < 10) return "At least 10 characters";
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return "Include at least one letter and one number";
  return null;
}

export default function ChangePasswordPage() {
  const router = useRouter();
  const { status, user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "anonymous") router.replace("/");
    // Patients sign in with OTP and have no password.
    if (status === "authenticated" && user?.role === "PATIENT") router.replace(ROLE_HOME.PATIENT);
  }, [status, user, router]);

  if (status !== "authenticated" || !user || user.role === "PATIENT") return <FullPageSpinner />;

  const forced = user.mustChangePassword;
  const problem = newPassword ? passwordProblem(newPassword) : null;
  const mismatch = confirm.length > 0 && confirm !== newPassword;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await api.post<Session>("/auth/change-password", {
        currentPassword,
        newPassword,
      });
      applySession(session);
      router.replace(ROLE_HOME[session.user.role]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Logo />
          <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-900">
            {forced ? "Set a new password" : "Change password"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">Signed in as {user.loginId}</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {forced && (
              <Alert tone="info">
                You&apos;re using a temporary password. Choose a new one to continue.
              </Alert>
            )}
            {error && <Alert>{error}</Alert>}
            <Field
              label={forced ? "Temporary password" : "Current password"}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <Field
              label="New password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              error={problem ?? undefined}
              hint="At least 10 characters, with a letter and a number."
            />
            <Field
              label="Confirm new password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={mismatch ? "Passwords don't match" : undefined}
            />
            <Button
              type="submit"
              className="w-full"
              loading={busy}
              disabled={!currentPassword || !newPassword || !!problem || confirm !== newPassword}
            >
              Save new password
            </Button>
            <p className="text-center text-xs text-slate-500">
              This signs you out on all other devices.
            </p>
          </form>
        </Card>

        {forced && (
          <p className="text-center text-sm">
            <button
              type="button"
              onClick={async () => {
                await logout();
                router.replace("/");
              }}
              className="font-medium text-slate-600 hover:text-slate-900"
            >
              Log out
            </button>
          </p>
        )}
      </div>
    </main>
  );
}
