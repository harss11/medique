import type { z } from "zod";

export interface EndpointDoc {
  tag: string;
  summary: string;
  /** What it does, in particular rules a client developer needs to know. */
  description?: string;
  /** Request body, from the same Zod schema the endpoint validates with. */
  body?: z.ZodType;
  /** Query string, from the schema the endpoint validates with. */
  query?: z.ZodType;
  /** Multipart upload: the name of the file field. */
  upload?: string;
  /** The success response is a PDF file, not the JSON envelope. */
  pdf?: boolean;
  /** Request headers the endpoint needs besides Authorization. */
  headers?: Array<{ name: string; description: string; required: boolean }>;
}

export const d = (
  tag: string,
  summary: string,
  extra: Omit<EndpointDoc, "tag" | "summary"> = {},
): EndpointDoc => ({ tag, summary, ...extra });

/** Keys are "METHOD /path" relative to /api/v1 (and "GET /health"). */
export type EndpointRegistry = Record<string, EndpointDoc>;
