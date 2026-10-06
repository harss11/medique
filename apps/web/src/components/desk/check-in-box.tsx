"use client";

import { useCallback, useState } from "react";
import { Alert, Button, Card, Field } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { CheckInResult } from "@/lib/types";
import { QrScannerDialog } from "./qr-scanner";

/** Check a patient in by scanning their QR or typing the code on their ticket. */
export function CheckInBox({ onCheckedIn }: { onCheckedIn: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "info" | "error";
    text: string;
  } | null>(null);

  const submit = useCallback(
    async (value: string) => {
      const clean = value.trim();
      if (clean.length < 4) {
        setMessage({ tone: "error", text: "Enter the check-in code from the patient’s ticket." });
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        const r = await api.post<CheckInResult>("/desk/check-in", { code: clean });
        const a = r.appointment;
        setMessage({
          tone: r.alreadyCheckedIn ? "info" : "success",
          text: `${r.alreadyCheckedIn ? "Already checked in" : "Checked in"}: token ${a.tokenNumber} · ${a.patient.fullName} · ${a.doctor.name}`,
        });
        setCode("");
        onCheckedIn();
      } catch (err) {
        setMessage({ tone: "error", text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [onCheckedIn],
  );

  const scanned = useCallback(
    (value: string) => {
      setScanning(false);
      setCode(value);
      void submit(value);
    },
    [submit],
  );

  return (
    <Card className="space-y-3 p-4">
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <Field
          className="flex-1"
          label="Check in a patient"
          name="checkin-code"
          placeholder="Check-in code, e.g. K7M2-9QXF-3R"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Check in
          </Button>
          <Button type="button" variant="secondary" onClick={() => setScanning(true)}>
            Scan QR
          </Button>
        </div>
      </form>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <QrScannerDialog open={scanning} onClose={() => setScanning(false)} onCode={scanned} />
    </Card>
  );
}
