"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "./api";

interface Options {
  /** Send the signed-in session (default). Public endpoints that use their own key set this to false. */
  auth?: boolean;
  /** Extra request headers, for example the secret key of a blood request. */
  headers?: Record<string, string>;
}

/**
 * Loads `path` from the API and re-loads when it changes. Pass null to skip.
 * Deliberately tiny: pages call `reload()` after a mutation. While a new path
 * loads, the previous data stays visible (no flicker when paging).
 */
export function useApi<T>(path: string | null, options?: Options) {
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<T | null>(null);
  // Which request the latest result belongs to; `loading` is derived from it.
  const [result, setResult] = useState<{
    key: string;
    error: string | null;
    code: string | null;
  } | null>(null);
  const auth = options?.auth ?? true;
  const headerKey = JSON.stringify(options?.headers ?? null);
  const key = path === null ? null : `${path}#${version}#${headerKey}`;

  useEffect(() => {
    if (path === null || key === null) return;
    let cancelled = false;
    const headers = (JSON.parse(headerKey) as Record<string, string> | null) ?? undefined;
    api
      .get<T>(path, { auth, headers })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setResult({ key, error: null, code: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            key,
            error: errorMessage(err),
            code: err instanceof ApiError ? err.code : null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, key, auth, headerKey]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const loading = key !== null && result?.key !== key;
  const error = result?.key === key ? result.error : null;
  const errorCode = result?.key === key ? result.code : null;
  return { data, error, errorCode, loading, reload, setData };
}
