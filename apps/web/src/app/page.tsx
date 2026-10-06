"use client";

import Link from "next/link";
import { ErasedNotice } from "@/components/erased-notice";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/ui";
import { useT, type MessageKey } from "@/lib/i18n";

const STEPS: Array<{ n: string; title: MessageKey; text: MessageKey }> = [
  { n: "1", title: "home.step1.title", text: "home.step1.text" },
  { n: "2", title: "home.step2.title", text: "home.step2.text" },
  { n: "3", title: "home.step3.title", text: "home.step3.text" },
];

const STAFF_PORTALS: Array<{ href: string; label: MessageKey }> = [
  { href: "/hospital/login", label: "home.staff.hospital" },
  { href: "/reception/login", label: "home.staff.reception" },
  { href: "/doctor/login", label: "home.staff.doctor" },
  { href: "/admin/login", label: "home.staff.admin" },
];

export default function HomePage() {
  const t = useT();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4">
        <Logo />
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <Link
            href="/login"
            className="rounded-xl px-4 py-2 text-sm font-semibold text-brand-800 hover:bg-brand-50"
          >
            {t("nav.login")}
          </Link>
        </div>
      </header>

      <ErasedNotice />

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:pt-20">
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            {t("home.title")}
          </h1>
          <p className="mt-4 max-w-xl text-lg text-slate-600">{t("home.subtitle")}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              href="/hospitals"
              className="inline-flex h-12 items-center justify-center rounded-xl bg-brand-700 px-6 font-semibold text-white hover:bg-brand-800"
            >
              {t("home.book")}
            </Link>
            <Link
              href="/search"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-brand-300 bg-white px-6 font-semibold text-brand-800 hover:bg-brand-50"
            >
              {t("home.findDoctor")}
            </Link>
            <Link
              href="/emergency"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-red-300 bg-red-50 px-6 font-semibold text-red-800 hover:bg-red-100"
            >
              {t("home.emergency")}
            </Link>
            <Link
              href="/blood"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-6 font-semibold text-slate-800 hover:bg-slate-50"
            >
              {t("home.blood")}
            </Link>
          </div>

          <ol className="mt-16 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-2xl border border-slate-200 p-5">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">
                  {s.n}
                </span>
                <h2 className="mt-3 font-semibold text-slate-900">{t(s.title)}</h2>
                <p className="mt-1 text-sm text-slate-600">{t(s.text)}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <nav aria-label="Staff portals" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-slate-500">{t("home.staff")}</span>
            {STAFF_PORTALS.map((p) => (
              <Link key={p.href} href={p.href} className="hover:text-slate-900">
                {t(p.label)}
              </Link>
            ))}
          </nav>
          <nav aria-label="Legal" className="flex gap-4">
            <Link href="/privacy" className="hover:text-slate-900">
              {t("home.privacy")}
            </Link>
            <Link href="/terms" className="hover:text-slate-900">
              {t("home.terms")}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
