import type { NextConfig } from "next";

const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1").origin;
  } catch {
    return "";
  }
})();

/**
 * What the pages are allowed to load. Sent as Report-Only first: violations show in the
 * browser console (and, with Sentry, can be reviewed) without breaking Razorpay checkout or
 * the maps while the pilot proves the list is complete. Once a pilot week has produced no
 * violations, rename the header to `Content-Security-Policy` to enforce it.
 * 'unsafe-inline' scripts are needed by Next.js without a per-request nonce.
 */
const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://maps.googleapis.com https://maps.gstatic.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://res.cloudinary.com https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin} https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io https://lumberjack.razorpay.com https://maps.googleapis.com`,
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Enforced: nobody may put MediQ in a frame (clickjacking).
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
          // Browsers ignore this over plain http (local development) and obey it on https.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          // Camera for check-in QR scanning and location for the emergency finder.
          { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=()" },
        ],
      },
      {
        // The service worker must never be served stale.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
