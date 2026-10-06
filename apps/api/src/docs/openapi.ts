import { z } from "zod";
import { ENDPOINTS, TAG_ORDER } from "./endpoints.js";
import { routeInventory, routeKey, type RouteInfo } from "./route-inventory.js";

type Json = Record<string, unknown>;

const PREFIX = "/api/v1";

/** "GET /api/v1/desk/x" to the registry key "GET /desk/x" (health keeps its own path). */
export function docKey(r: Pick<RouteInfo, "method" | "path">): string {
  return routeKey({
    method: r.method,
    path: r.path.startsWith(PREFIX) ? r.path.slice(PREFIX.length) : r.path,
  });
}

function jsonSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
  delete out.$schema;
  return out;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
}

function queryParameters(schema: z.ZodType): Json[] {
  const js = jsonSchema(schema) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({
    name,
    in: "query",
    required: js.required?.includes(name) ?? false,
    schema: s,
  }));
}

function accessLine(r: RouteInfo): string {
  if (!r.auth) return "Access: no login needed.";
  if (r.roles) return "Access: signed-in " + r.roles.join(", ") + " only.";
  return "Access: any signed-in user.";
}

const ERROR_REF = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
});

function operation(r: RouteInfo): Json {
  const doc = ENDPOINTS[docKey(r)];
  if (!doc) throw new Error("No documentation for " + docKey(r));
  const parameters: Json[] = pathParams(r.path).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: name === "id" ? { type: "string", format: "uuid" } : { type: "string" },
  }));
  if (doc.query) parameters.push(...queryParameters(doc.query));
  for (const h of doc.headers ?? []) {
    parameters.push({
      name: h.name,
      in: "header",
      required: h.required,
      description: h.description,
      schema: { type: "string" },
    });
  }

  const op: Json = {
    tags: [doc.tag],
    summary: doc.summary,
    description: [
      doc.description,
      accessLine(r),
      r.limiters.length ? "Rate limited: " + r.limiters.join(", ") + "." : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    operationId: (
      r.method.toLowerCase() +
      r.path
        .replace(PREFIX, "")
        .replace(/[/:]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))
    ).replace(/[^A-Za-z0-9]/g, ""),
    ...(parameters.length ? { parameters } : {}),
    ...(r.auth ? { security: [{ bearerAuth: [] }] } : {}),
    "x-roles": r.roles ?? (r.auth ? "any" : "public"),
  };

  if (doc.body) {
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: jsonSchema(doc.body) } },
    };
  } else if (doc.upload) {
    op.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: [doc.upload],
            properties: { [doc.upload]: { type: "string", format: "binary" } },
          },
        },
      },
    };
  }

  const responses: Record<string, Json> = {
    "200": doc.pdf
      ? {
          description: "The PDF file.",
          content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
        }
      : {
          description: "Success. The result is in data.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
        },
    "400": ERROR_REF("The input is invalid (error.code VALIDATION_ERROR lists each field)."),
  };
  if (r.auth) {
    responses["401"] = ERROR_REF("Not signed in, or the session has ended.");
    responses["403"] = ERROR_REF("Signed in, but not allowed to do this.");
  }
  if (pathParams(r.path).length)
    responses["404"] = ERROR_REF("Not found (also used when the record belongs to someone else).");
  responses["429"] = ERROR_REF("Too many requests. Wait for the Retry-After header.");
  op.responses = responses;
  return op;
}

const INTRO = `
REST API behind the MediQ web app (and the future mobile app).

**Responses** are always \`{ "success": boolean, "data": ..., "error": { "code", "message", "details?" } | null }\`, except PDF downloads.

**Signing in.** Staff: \`POST /auth/staff/login\`. Patients: \`POST /auth/otp/request\` then \`/auth/otp/verify\`. Both return a short-lived **access token**: click *Authorize* and paste it (without "Bearer"). Refresh tokens rotate; the web app keeps its refresh token in an httpOnly cookie, a mobile app sends \`X-Client-Type: mobile\` and keeps it in secure storage.

**Roles and ownership.** Every endpoint checks the role *and* that the record belongs to the caller (their hospital, their own patient). Someone else's record answers 404, never 403, so existence is not revealed.

**Money** is in minor units (paise for INR). **Dates** are \`YYYY-MM-DD\` in the hospital's timezone; **instants** are ISO 8601 UTC.

**Lists** accept \`page\` and \`limit\` (max 100) and return \`{ items, pagination }\`.

**Bookings** are never double-booked: a seat is taken inside a database transaction with a row lock. A booking is confirmed **only** by the verified Razorpay webhook.
`.trim();

export function buildOpenApi(routes: RouteInfo[] = routeInventory()): Json {
  const paths: Record<string, Json> = {};
  for (const r of routes) {
    const rel = r.path.startsWith(PREFIX) ? r.path.slice(PREFIX.length) : r.path;
    const key = rel.replace(/:([A-Za-z]+)/g, "{$1}");
    paths[key] ??= r.path === "/health" ? { servers: [{ url: "/" }] } : {};
    paths[key]![r.method.toLowerCase()] = operation(r);
  }
  const used = new Set(routes.map((r) => ENDPOINTS[docKey(r)]?.tag));
  return {
    openapi: "3.0.3",
    info: { title: "MediQ API", version: "1.0.0", description: INTRO },
    servers: [{ url: PREFIX }],
    tags: TAG_ORDER.filter((t) => used.has(t)).map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Access token from a login endpoint.",
        },
      },
      schemas: {
        Envelope: {
          type: "object",
          required: ["success", "data", "error"],
          properties: { success: { type: "boolean" }, data: {}, error: { nullable: true } },
        },
        ErrorEnvelope: {
          type: "object",
          required: ["success", "data", "error"],
          properties: {
            success: { type: "boolean", enum: [false] },
            data: { nullable: true },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", example: "VALIDATION_ERROR" },
                message: { type: "string" },
                details: { description: "For validation errors: [{ path, message }]." },
              },
            },
          },
        },
      },
    },
  };
}
