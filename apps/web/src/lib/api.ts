import type { Session } from "./types";

/**
 * Thin client for the MediQ REST API. All business logic lives in the API;
 * this file only handles transport and the session:
 *
 * - The access token is kept in memory only (never localStorage).
 * - The refresh token is an httpOnly cookie set by the API; JavaScript never sees it.
 * - On a 401 the client refreshes once (single-flight) and retries the request.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
}

type SessionListener = (session: Session | null) => void;

let accessToken: string | null = null;
let refreshInFlight: Promise<Session | null> | null = null;
let listener: SessionListener | null = null;

/** Error codes that mean "the access token is no good, try refreshing". */
const REFRESHABLE = new Set(["TOKEN_EXPIRED", "INVALID_TOKEN", "UNAUTHORIZED", "SESSION_REVOKED"]);

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Attach the access token and refresh on 401. Default true. */
  auth?: boolean;
  /** The success response is a file (PDF), not the JSON envelope. */
  blob?: boolean;
  /** Extra request headers (for example the secret key of a blood request). */
  headers?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const headers: Record<string, string> = {
    Accept: "application/json",
    // Required by the API for cookie-authenticated calls (CSRF defence).
    "X-Requested-With": "XMLHttpRequest",
  };
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  // For FormData the browser sets the multipart boundary itself.
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  Object.assign(headers, opts.headers);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Can't reach the server. Check your connection and try again.",
    );
  }

  if (opts.blob && res.ok) return (await res.blob()) as T;

  const json = (await res.json().catch(() => null)) as Envelope<T> | null;

  if (res.status === 401 && auth && retry && REFRESHABLE.has(json?.error?.code ?? "")) {
    const session = await refreshSession();
    if (session) return request<T>(path, opts, false);
  }

  if (!res.ok || !json?.success) {
    throw new ApiError(
      res.status,
      json?.error?.code ?? "UNKNOWN_ERROR",
      json?.error?.message ?? "Something went wrong. Please try again.",
      json?.error?.details,
    );
  }
  return json.data as T;
}

export const api = {
  get: <T>(path: string, opts?: Pick<RequestOptions, "auth" | "headers">) => request<T>(path, opts),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "POST", body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  /** Fetches a file (e.g. a PDF receipt) with the signed-in session. */
  download: (path: string) => request<Blob>(path, { blob: true }),
  /** multipart/form-data upload of a single file */
  upload: <T>(path: string, field: string, file: File) => {
    const form = new FormData();
    form.append(field, file);
    return request<T>(path, { method: "POST", body: form });
  },
};

/** Turns an API validation error into a { field: message } map for forms. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as Array<{ path?: string; message?: string }>) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

/** Stores a session returned by login/refresh and notifies the AuthProvider. */
export function applySession(session: Session | null): void {
  accessToken = session?.accessToken ?? null;
  listener?.(session);
}

export function setSessionListener(fn: SessionListener | null): void {
  listener = fn;
}

/** Uses the refresh cookie to get a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<Session | null> {
  refreshInFlight ??= request<Session>("/auth/refresh", { method: "POST", auth: false }, false)
    .then((session) => {
      applySession(session);
      return session;
    })
    .catch(() => {
      applySession(null);
      return null;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}
