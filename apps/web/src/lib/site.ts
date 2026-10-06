/**
 * The public address of the web app, used inside QR codes and printed cards. Set
 * NEXT_PUBLIC_SITE_URL in production so codes always carry the real domain; in development
 * the address the page is opened on is used.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return typeof window === "undefined" ? "" : window.location.origin;
}

export const hospitalPageUrl = (slug: string) => `${siteUrl()}/h/${slug}`;
export const queuePageUrl = (qrToken: string, myToken?: number | null) =>
  `${siteUrl()}/q/${qrToken}${myToken ? `?token=${myToken}` : ""}`;
