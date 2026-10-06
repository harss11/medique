import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ENDPOINTS } from "./endpoints.js";
import { buildOpenApi, docKey } from "./openapi.js";
import { routeInventory } from "./route-inventory.js";

type Op = {
  tags: string[];
  summary: string;
  operationId: string;
  parameters?: Array<{ name: string; in: string }>;
  security?: unknown[];
  requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> };
  responses: Record<string, unknown>;
};
type Spec = { paths: Record<string, Record<string, Op>>; tags: Array<{ name: string }> };

const routes = routeInventory();
const spec = buildOpenApi(routes) as unknown as Spec;
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([m]) => m !== "servers")
    .map(([method, op]) => ({ path, method, op })),
);

describe("API documentation", () => {
  it("documents every endpoint the API serves", () => {
    const missing = routes.map(docKey).filter((k) => !ENDPOINTS[k]);
    expect(missing).toEqual([]);
  });

  it("documents nothing that does not exist", () => {
    const served = new Set(routes.map(docKey));
    expect(Object.keys(ENDPOINTS).filter((k) => !served.has(k))).toEqual([]);
  });

  it("has one operation per route, with a summary, a tag and a unique operationId", () => {
    expect(operations).toHaveLength(routes.length);
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { op } of operations) {
      expect(op.summary.length).toBeGreaterThan(5);
      expect(spec.tags.map((t) => t.name)).toContain(op.tags[0]);
    }
  });

  it("declares every {param} in a path", () => {
    for (const { path, op } of operations) {
      for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
        expect(
          op.parameters?.some((p) => p.in === "path" && p.name === name),
          path + " " + name,
        ).toBe(true);
      }
    }
  });

  it("marks exactly the authenticated endpoints as needing a bearer token", () => {
    for (const r of routes) {
      const key = r.path.replace("/api/v1", "").replace(/:(\w+)/g, "{$1}");
      const op = spec.paths[key]![r.method.toLowerCase()]!;
      expect(Boolean(op.security), r.method + " " + r.path).toBe(r.auth);
    }
  });

  it("describes request bodies from the real validation schemas", () => {
    const walkIn = spec.paths["/desk/appointments"]!.post!;
    const props = walkIn.requestBody!.content["application/json"]!.schema.properties!;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["slotId", "patient", "payment", "checkIn"]),
    );
    const upload = spec.paths["/hospital/doctors/{id}/photo"]!.post!;
    expect(upload.requestBody!.content["multipart/form-data"]).toBeDefined();
    expect(spec.paths["/appointments/{id}/receipt"]!.get!.responses["200"]).toMatchObject({
      content: { "application/pdf": expect.anything() },
    });
  });

  it("puts the health check at the root, not under /api/v1", () => {
    expect(
      (spec.paths["/health"] as unknown as { servers: Array<{ url: string }> }).servers[0]!.url,
    ).toBe("/");
  });
});

describe("the reference page", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it("serves the spec, the page and the UI files from this server only", async () => {
    const json = await fetch(base + "/api/docs/openapi.json");
    expect(json.status).toBe(200);
    expect(((await json.json()) as { info: { title: string } }).info.title).toBe("MediQ API");

    const page = await fetch(base + "/api/docs/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("swagger-ui-bundle.js");
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // no third-party scripts
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    const scripts = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
    expect(scripts).toBe("'self'"); // scripts: this server only, never inline
    expect(csp).not.toContain("upgrade-insecure-requests");

    expect((await fetch(base + "/api/docs/swagger-ui-bundle.js")).status).toBe(200);
    expect((await fetch(base + "/api/docs/init.js")).status).toBe(200);
  });
});
