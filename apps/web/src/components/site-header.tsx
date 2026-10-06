"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { ROLE_HOME } from "@/lib/roles";
import { LanguageSwitcher } from "./language-switcher";
import { Logo } from "./ui";

/** Header + page frame for the public (visitor) pages. */
export function SiteHeader() {
  const { status, user } = useAuth();
  const t = useT();
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4">
        <Logo />
        <nav className="flex items-center gap-1 text-sm font-semibold">
          <Link href="/emergency" className="rounded-xl px-3 py-2 text-red-700 hover:bg-red-50">
            {t("nav.emergency")}
          </Link>
          <Link href="/blood" className="rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100">
            {t("nav.blood")}
          </Link>
          <Link href="/search" className="rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100">
            {t("nav.doctors")}
          </Link>
          <Link
            href="/hospitals"
            className="rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100"
          >
            {t("nav.hospitals")}
          </Link>
          {status === "authenticated" && user ? (
            <Link
              href={user.role === "PATIENT" ? "/patient/appointments" : ROLE_HOME[user.role]}
              className="rounded-xl px-3 py-2 text-brand-800 hover:bg-brand-50"
            >
              {user.role === "PATIENT" ? t("nav.myAppointments") : t("nav.dashboard")}
            </Link>
          ) : (
            <Link href="/login" className="rounded-xl px-3 py-2 text-brand-800 hover:bg-brand-50">
              {t("nav.login")}
            </Link>
          )}
          <LanguageSwitcher className="ml-1" />
        </nav>
      </div>
    </header>
  );
}

export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}
