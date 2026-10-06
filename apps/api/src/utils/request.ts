import type { Request } from "express";

/** Network context recorded with audit entries, tokens and OTPs. */
export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export function requestMeta(req: Request): RequestMeta {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent")?.slice(0, 500),
  };
}
