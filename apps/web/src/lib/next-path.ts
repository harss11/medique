/**
 * Validates a `?next=` redirect target. Only same-site relative paths are
 * allowed, so a crafted login link can't send someone to another website.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

export function loginUrl(loginPath: string, returnTo: string): string {
  const next = safeNext(returnTo);
  return next ? `${loginPath}?next=${encodeURIComponent(next)}` : loginPath;
}
