"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { ROLE_LABEL, ROLE_LOGIN } from "@/lib/roles";
import { LanguageSwitcher } from "./language-switcher";
import { Button, Card, Logo, cx } from "./ui";

export interface NavItem {
  href: string;
  label: string;
}

export function DashboardShell({ children, nav }: { children: ReactNode; nav?: NavItem[] }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  if (!user) return null;

  // The first item is the section root (e.g. /hospital): exact match only.
  const isActive = (href: string, index: number) =>
    index === 0 ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  async function handleLogout() {
    const loginPath = ROLE_LOGIN[user!.role];
    await logout();
    router.replace(loginPath);
  }

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Logo />
            <span className="hidden rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800 sm:inline">
              {ROLE_LABEL[user.role]}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <div className="hidden text-right text-sm leading-tight sm:block">
              <div className="font-medium text-slate-900">{user.name}</div>
              <div className="text-slate-500">
                {user.hospital?.name ?? user.loginId ?? user.phone}
              </div>
            </div>
            <Button variant="secondary" className="h-9 px-3" onClick={handleLogout}>
              {t("nav.logout")}
            </Button>
          </div>
        </div>
        {nav && nav.length > 0 && (
          <nav aria-label={t("nav.sections")} className="mx-auto max-w-5xl overflow-x-auto px-2">
            <ul className="flex gap-1">
              {nav.map((item, i) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive(item.href, i) ? "page" : undefined}
                    className={cx(
                      "block border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap",
                      isActive(item.href, i)
                        ? "border-brand-700 text-brand-800"
                        : "border-transparent text-slate-600 hover:text-slate-900",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}

/** Placeholder tiles for features arriving in later phases. */
export function ComingSoon({ items }: { items: Array<{ title: string; description: string }> }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <Card key={item.title} className="opacity-80">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-slate-900">{item.title}</h3>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              Coming soon
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">{item.description}</p>
        </Card>
      ))}
    </div>
  );
}
