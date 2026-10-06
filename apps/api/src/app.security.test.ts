import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe("security headers", () => {
  it("sends the standard hardening headers and hides the framework", async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("strict-transport-security")).toContain("includeSubDomains");
    expect(res.headers.get("x-frame-options")).toBeTruthy();
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("never lets API responses be cached", async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers unknown routes with the standard envelope", async () => {
    const res = await fetch(`${base}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});

describe("request ids", () => {
  it("echoes a well-formed id and replaces a malformed one", async () => {
    const good = await fetch(`${base}/api/v1/x`, { headers: { "X-Request-Id": "abc-12345678" } });
    expect(good.headers.get("x-request-id")).toBe("abc-12345678");
    const bad = await fetch(`${base}/api/v1/x`, { headers: { "X-Request-Id": "bad id!" } });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("CORS", () => {
  it("refuses a browser origin that is not allow-listed", async () => {
    const res = await fetch(`${base}/api/v1/x`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toMatchObject({ error: { code: "CORS_NOT_ALLOWED" } });
  });

  it("allows the configured origin with credentials, and answers preflight", async () => {
    const origin = "http://localhost:3000";
    const res = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not allow a header or method outside the list", async () => {
    const res = await fetch(`${base}/api/v1/x`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "TRACE",
        "Access-Control-Request-Headers": "x-evil",
      },
    });
    expect(res.headers.get("access-control-allow-methods") ?? "").not.toContain("TRACE");
    expect(res.headers.get("access-control-allow-headers") ?? "").not.toContain("x-evil");
  });
});

describe("error handling", () => {
  it("rejects broken JSON and oversized bodies without leaking internals", async () => {
    const broken = await fetch(`${base}/api/v1/auth/staff/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

    const huge = await fetch(`${base}/api/v1/auth/staff/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: "x".repeat(300_000) }),
    });
    expect(huge.status).toBe(413);
    const text = await huge.text();
    expect(text).not.toMatch(/node_modules|at .*:\d+:\d+/);
  });
});
