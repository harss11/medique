"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { loginUrl, safeNext } from "@/lib/next-path";
import { ROLE_HOME, homeFor } from "@/lib/roles";
import type { Role } from "@/lib/types";
import { FullPageSpinner } from "./ui";

/**
 * Client-side route guard for dashboards. This is a UX convenience only: the
 * API enforces role and ownership on every request regardless of what the UI shows.
 * Signed-out visitors are sent to the login page and brought back afterwards.
 */
export function RequireRole({
  roles,
  loginPath,
  children,
}: {
  roles: Role[];
  loginPath: string;
  children: ReactNode;
}) {
  const { status, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const allowed =
    status === "authenticated" && !!user && !user.mustChangePassword && roles.includes(user.role);

  useEffect(() => {
    if (status === "anonymous") {
      router.replace(loginUrl(loginPath, pathname + window.location.search));
    } else if (status === "authenticated" && user && !allowed) {
      router.replace(user.mustChangePassword ? "/change-password" : ROLE_HOME[user.role]);
    }
  }, [status, user, allowed, loginPath, pathname, router]);

  return allowed ? <>{children}</> : <FullPageSpinner />;
}

/**
 * On login pages: send already signed-in users onward, to `next` when it is a
 * safe in-site path, otherwise to their own dashboard.
 */
export function useRedirectIfAuthenticated(next?: string | null) {
  const { status, user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "authenticated" && user) {
      router.replace(user.mustChangePassword ? homeFor(user) : (safeNext(next) ?? homeFor(user)));
    }
  }, [status, user, next, router]);
  return status;
}
