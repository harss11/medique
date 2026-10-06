"use client";

import { useState } from "react";
import type { Credentials } from "@/lib/types";
import { Modal } from "./modal";
import { Alert, Button, Checkbox } from "./ui";

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">{label}</div>
        <div className="truncate font-mono text-base font-semibold text-slate-900 select-all">
          {value}
        </div>
      </div>
      <Button
        variant="secondary"
        className="h-9 shrink-0 px-3"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard may be unavailable (http, permissions); the text is selectable.
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * Shows a login ID and temporary password exactly once. The password is not
 * stored anywhere readable, so the user must confirm they saved it before closing.
 */
export function CredentialsModal({
  credentials,
  title = "Login created",
  onClose,
}: {
  credentials: Credentials | null;
  title?: string;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(false);
  if (!credentials) return null;

  return (
    <Modal open title={title} onClose={onClose} locked>
      <div className="space-y-4">
        <Alert tone="info">
          Share these with the account holder securely. The temporary password is shown{" "}
          <strong>only once</strong>; they must change it at first login.
        </Alert>
        <CopyRow label="Login ID" value={credentials.loginId} />
        <CopyRow label="Temporary password" value={credentials.temporaryPassword} />
        <Checkbox label="I have saved these credentials" checked={saved} onChange={setSaved} />
        <div className="flex justify-end">
          <Button
            disabled={!saved}
            onClick={() => {
              setSaved(false);
              onClose();
            }}
          >
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
