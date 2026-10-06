"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, api, applySession } from "@/lib/api";
import { homeFor } from "@/lib/roles";
import type { Session } from "@/lib/types";
import { useRedirectIfAuthenticated } from "./auth-guards";
import { Alert, Button, Card, Field, FullPageSpinner, Logo } from "./ui";

/**
 * Shared login form for every staff portal (admin, hospital, reception, doctor).
 * The API decides the role; after login the user is sent to their own dashboard.
 */
export function StaffLoginForm({ title, subtitle }: { title: string; subtitle: string }) {
  const router = useRouter();
  const status = useRedirectIfAuthenticated();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await api.post<Session>(
        "/auth/staff/login",
        { loginId, password },
        { auth: false },
      );
      applySession(session);
      router.replace(homeFor(session.user));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (status !== "anonymous") return <FullPageSpinner />;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Logo />
          <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {error && <Alert>{error}</Alert>}
            <Field
              label="Login ID"
              name="loginId"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
            />
            <Field
              label="Password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="px-3 text-xs font-medium text-slate-600 hover:text-slate-900"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              }
            />
            <Button
              type="submit"
              className="w-full"
              loading={submitting}
              disabled={!loginId || !password}
            >
              Log in
            </Button>
          </form>
        </Card>

        <p className="text-center text-xs text-slate-500">
          Forgot your password? Contact your hospital administrator.
          <br />
          <Link href="/" className="mt-2 inline-block font-medium text-brand-700 hover:underline">
            Back to home
          </Link>
        </p>
      </div>
    </main>
  );
}
