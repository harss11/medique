"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Renders `value` as a QR code, generated in the browser (nothing is sent anywhere). */
export function TicketQR({
  value,
  size = 220,
  label = "Check-in QR code",
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src) {
    return (
      <div
        className="rounded-xl bg-slate-100"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not an optimisable asset
    <img
      src={src}
      width={size}
      height={size}
      alt={label}
      className="rounded-xl border border-slate-200 bg-white"
    />
  );
}
