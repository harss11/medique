"use client";

import type { ReactNode } from "react";
import { RequireRole } from "@/components/auth-guards";
import { DashboardShell, type NavItem } from "@/components/dashboard-shell";

const RECEPTION_NAV: NavItem[] = [
  { href: "/reception", label: "Today" },
  { href: "/reception/walk-in", label: "New walk-in" },
];

/** Page frame (login guard + header) for the reception desk. */
export function ReceptionFrame({ children }: { children: ReactNode }) {
  return (
    <RequireRole roles={["RECEPTIONIST"]} loginPath="/reception/login">
      <DashboardShell nav={RECEPTION_NAV}>{children}</DashboardShell>
    </RequireRole>
  );
}

export function DoctorFrame({ children }: { children: ReactNode }) {
  return (
    <RequireRole roles={["DOCTOR"]} loginPath="/doctor/login">
      <DashboardShell>{children}</DashboardShell>
    </RequireRole>
  );
}
