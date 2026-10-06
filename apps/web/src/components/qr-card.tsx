"use client";

import { useState } from "react";
import { TicketQR } from "@/components/booking/ticket-qr";
import { Alert, Button, Card } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { downloadQrCard, printQrCard } from "@/lib/qr";

/** A QR code with Download (PNG) and Print buttons. */
export function QrCard({
  title,
  subtitle,
  value,
  caption,
  filename,
  size = 180,
}: {
  title: string;
  subtitle?: string;
  value: string;
  /** Shown under the code on the downloaded and printed card. Defaults to the link itself. */
  caption?: string;
  filename: string;
  size?: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const card = { value, title, caption: caption ?? value };

  async function download() {
    setError(null);
    try {
      await downloadQrCard(card, filename);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function print() {
    setError(null);
    try {
      if (!(await printQrCard(card))) setError("Allow pop-ups for this site to print the card.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="flex flex-col items-center gap-3 text-center">
      <div>
        <h3 className="font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="text-sm text-slate-600">{subtitle}</p>}
      </div>
      <TicketQR value={value} size={size} label={`QR code for ${title}`} />
      <p className="max-w-full text-xs break-all text-slate-500">{value}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" className="h-9 px-3" onClick={download}>
          Download PNG
        </Button>
        <Button variant="secondary" className="h-9 px-3" onClick={print}>
          Print
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}
