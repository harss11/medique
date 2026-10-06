"use client";

import { useRef, useState } from "react";
import { Alert, Button, Card, Field } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { MAX_OFFSET_MM, clamp, round1 } from "@/lib/slip-fields";
import type { SlipTemplate } from "@/lib/types";

export function CalibrationPanel({
  offsetX,
  offsetY,
  busy,
  onOffset,
  onTestPrint,
}: {
  offsetX: number;
  offsetY: number;
  busy: "test" | "guides" | null;
  onOffset: (x: number, y: number) => void;
  onTestPrint: (guides: boolean) => void;
}) {
  const parse = (raw: string, fallback: number) => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n)
      ? round1(clamp(n, -MAX_OFFSET_MM, MAX_OFFSET_MM))
      : fallback;
  };
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-slate-900">Printer calibration</h2>
      <p className="text-xs text-slate-500">
        Printers rarely land text exactly where it was placed. Print the test slip on your
        pre-printed paper; if the text sits too far left or high, enter the gap here. Positive moves
        right / down, negative moves left / up. Applies to every slip you print.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Shift right (mm)"
          name="offset-x"
          type="number"
          step={0.1}
          min={-MAX_OFFSET_MM}
          max={MAX_OFFSET_MM}
          value={offsetX}
          onChange={(e) => onOffset(parse(e.target.value, offsetX), offsetY)}
        />
        <Field
          label="Shift down (mm)"
          name="offset-y"
          type="number"
          step={0.1}
          min={-MAX_OFFSET_MM}
          max={MAX_OFFSET_MM}
          value={offsetY}
          onChange={(e) => onOffset(offsetX, parse(e.target.value, offsetY))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-10"
          loading={busy === "test"}
          disabled={busy !== null}
          onClick={() => onTestPrint(false)}
        >
          Test print
        </Button>
        <Button
          variant="secondary"
          className="h-10"
          loading={busy === "guides"}
          disabled={busy !== null}
          onClick={() => onTestPrint(true)}
        >
          Alignment sheet
        </Button>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
        <li>
          Print at <strong>100% / Actual size</strong>. Turn off “Fit to page” and set margins to
          None, or every position will be off.
        </li>
        <li>Choose the same paper size in the printer dialog as in this template.</li>
        <li>
          The alignment sheet adds a ruler and boxes. Print it on plain paper and hold it against
          the pre-printed slip in front of a light.
        </li>
      </ul>
    </Card>
  );
}

export function BackgroundPanel({
  template,
  onUpdated,
}: {
  template: SlipTemplate;
  onUpdated: (t: SlipTemplate) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      onUpdated(
        await api.upload<SlipTemplate>(
          "/hospital/slip-templates/" + template.id + "/background",
          "background",
          file,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      onUpdated(
        await api.delete<SlipTemplate>("/hospital/slip-templates/" + template.id + "/background"),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-slate-900">Scan of the blank slip</h2>
      <p className="text-xs text-slate-500">
        Optional. Upload a flat scan or photo of your pre-printed slip (PNG or JPG, cropped to the
        paper edges) to line the fields up against it. It is only a guide on this screen and is
        never printed.
      </p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        aria-label="Scan of the blank slip"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="h-10"
          loading={busy}
          onClick={() => input.current?.click()}
        >
          {template.backgroundImageUrl ? "Replace scan" : "Upload scan"}
        </Button>
        {template.backgroundImageUrl && (
          <Button variant="ghost" className="h-10" disabled={busy} onClick={remove}>
            Remove
          </Button>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}
