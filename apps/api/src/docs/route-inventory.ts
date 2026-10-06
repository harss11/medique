import type { Router } from "express";
import type { Role } from "../generated/prisma/client.js";
import { guardOf, type Guard } from "../utils/guards.js";
import { mountPathOf } from "../utils/mount.js";
import { apiRouter } from "../routes.js";
import { webhooksRouter } from "../modules/payments/webhook.routes.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteInfo {
  method: HttpMethod;
  /** Full path as served, with :params (e.g. /api/v1/desk/appointments/:id/start). */
  path: string;
  /** Needs a signed-in user. */
  auth: boolean;
  /** Roles allowed (intersection when several gates apply); null when no role gate. */
  roles: Role[] | null;
  /** Names of the rate limiters on this route, besides the global one. */
  limiters: string[];
  /** Reachable while a temporary password is still pending (change-password, me, logout). */
  allowPasswordChange: boolean;
}

interface Layer {
  handle: unknown;
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function join(a: string, b: string): string {
  return (a + "/" + b).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
}

function summarise(method: HttpMethod, path: string, guards: Guard[]): RouteInfo {
  const roleGates = guards.filter((g) => g.kind === "roles");
  let roles: Role[] | null = null;
  for (const g of roleGates) {
    roles = roles === null ? [...g.roles] : roles.filter((r) => g.roles.includes(r));
  }
  const auths = guards.filter((g) => g.kind === "auth");
  return {
    method,
    path,
    auth: auths.length > 0,
    roles,
    limiters: guards.flatMap((g) => (g.kind === "limit" && g.name !== "global" ? [g.name] : [])),
    allowPasswordChange: auths.some((g) => g.allowPasswordChange),
  };
}

function walk(router: Router, prefix: string, inherited: Guard[], out: RouteInfo[]): void {
  const guards = [...inherited];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (layer.route) {
      const { path, methods, stack } = layer.route;
      if (typeof path !== "string") throw new Error("Route paths must be strings: " + String(path));
      const own = stack.map((l) => guardOf(l.handle)).filter((g): g is Guard => !!g);
      for (const m of METHODS) {
        if (methods[m.toLowerCase()])
          out.push(summarise(m, join(prefix, path), [...guards, ...own]));
      }
      continue;
    }
    const child = layer.handle as Router & { stack?: Layer[] };
    if (Array.isArray(child.stack)) {
      const at = mountPathOf(child);
      if (at === undefined) {
        throw new Error("A router is mounted without mount(): its paths would be undocumented.");
      }
      walk(child, join(prefix, at), guards, out);
      continue;
    }
    const g = guardOf(layer.handle);
    if (g) guards.push(g);
  }
}

/** Every endpoint the API serves, with its real guards, read from the running router. */
export function routeInventory(): RouteInfo[] {
  const out: RouteInfo[] = [];
  walk(apiRouter, "/api/v1", [], out);
  walk(webhooksRouter, "/api/v1/webhooks", [], out);
  out.push({
    method: "GET",
    path: "/health",
    auth: false,
    roles: null,
    limiters: [],
    allowPasswordChange: false,
  });
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export const routeKey = (r: Pick<RouteInfo, "method" | "path">) => r.method + " " + r.path;
