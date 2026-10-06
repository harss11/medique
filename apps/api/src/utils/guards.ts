import type { RequestHandler } from "express";
import type { Role } from "../generated/prisma/client.js";

/**
 * Markers on middleware, so the route inventory (docs and the security tests) can tell which
 * endpoints require a login, which roles may call them, and which are rate limited, without
 * guessing from names. Markers change nothing at runtime.
 */
export type Guard =
  | { kind: "auth"; allowPasswordChange: boolean }
  | { kind: "roles"; roles: readonly Role[] }
  | { kind: "limit"; name: string };

const GUARDS = new WeakMap<object, Guard>();

export function tagGuard<T extends RequestHandler>(handler: T, guard: Guard): T {
  GUARDS.set(handler, guard);
  return handler;
}

export function guardOf(handler: unknown): Guard | undefined {
  return typeof handler === "function" ? GUARDS.get(handler) : undefined;
}
