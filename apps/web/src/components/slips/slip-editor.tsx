"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { showPdf } from "@/lib/pdf";
import { defaultField, fitField } from "@/lib/slip-fields";
import type { SlipField, SlipFieldKey, SlipTemplate } from "@/lib/types";
import { SlipCanvas } from "./slip-canvas";
import { FieldPicker, FieldProperties, PaperPanel } from "./slip-panels";
import { BackgroundPanel, CalibrationPanel } from "./slip-tools";

function bodyOf(t: {
  name: string;
  paperWidthMm: number;
  paperHeightMm: number;
  offsetXMm: number;
  offsetYMm: number;
  fields: SlipField[];
}) {
  return {
    name: t.name.trim(),
    paperWidthMm: t.paperWidthMm,
    paperHeightMm: t.paperHeightMm,
    offsetXMm: t.offsetXMm,
    offsetYMm: t.offsetYMm,
    fields: t.fields,
  };
}

/** Drag-and-drop editor for one slip template. Positions are saved in millimetres. */
export function SlipEditor({ initial }: { initial: SlipTemplate }) {
  const [template, setTemplate] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [paper, setPaper] = useState({ w: initial.paperWidthMm, h: initial.paperHeightMm });
  const [offset, setOffset] = useState({ x: initial.offsetXMm, y: initial.offsetYMm });
  const [fields, setFields] = useState<SlipField[]>(initial.fields);
  const [selected, setSelected] = useState<SlipFieldKey | null>(initial.fields[0]?.key ?? null);
  const [scale, setScale] = useState(3);
  const [saved, setSaved] = useState(JSON.stringify(bodyOf(initial)));
  const [busy, setBusy] = useState<"save" | "default" | "test" | "guides" | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const body = bodyOf({
    name,
    paperWidthMm: paper.w,
    paperHeightMm: paper.h,
    offsetXMm: offset.x,
    offsetYMm: offset.y,
    fields,
  });
  const dirty = JSON.stringify(body) !== saved;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const field = fields.find((f) => f.key === selected) ?? null;

  function changeField(key: SlipFieldKey, patch: Partial<SlipField>) {
    setFields((all) =>
      all.map((f) => (f.key === key ? fitField({ ...f, ...patch }, paper.w, paper.h) : f)),
    );
  }
  function toggle(key: SlipFieldKey, on: boolean) {
    if (on) {
      setFields((all) =>
        all.some((f) => f.key === key) ? all : [...all, defaultField(key, all.length, paper.w)],
      );
      setSelected(key);
    } else {
      setFields((all) => all.filter((f) => f.key !== key));
      setSelected((s) => (s === key ? null : s));
    }
  }
  function changePaper(w: number, h: number) {
    setPaper({ w, h });
    setFields((all) => all.map((f) => fitField(f, w, h)));
  }

  async function save() {
    setBusy("save");
    setMessage(null);
    try {
      const updated = await api.patch<SlipTemplate>(
        "/hospital/slip-templates/" + template.id,
        body,
      );
      setTemplate(updated);
      setSaved(JSON.stringify(bodyOf(updated)));
      setMessage({ tone: "success", text: "Saved." });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function makeDefault() {
    setBusy("default");
    setMessage(null);
    try {
      setTemplate(
        await api.post<SlipTemplate>("/hospital/slip-templates/" + template.id + "/default"),
      );
      setMessage({ tone: "success", text: "This is now the template reception prints with." });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function testPrint(guides: boolean) {
    setBusy(guides ? "guides" : "test");
    setMessage(null);
    try {
      // Uses what is on screen, saved or not, so a layout can be tried before saving it.
      const blob = await api.post<Blob>(
        "/hospital/slip-templates/test-print",
        { template: body, guides },
        { blob: true },
      );
      const problem = showPdf(blob, guides ? "alignment-sheet.pdf" : "test-slip.pdf");
      if (problem) setMessage({ tone: "error", text: problem });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={busy === "save"} disabled={!dirty || busy !== null} onClick={save}>
            Save changes
          </Button>
          {template.isDefault ? (
            <Badge tone="green">Default template</Badge>
          ) : (
            <Button
              variant="secondary"
              loading={busy === "default"}
              disabled={busy !== null || dirty}
              onClick={makeDefault}
            >
              Make default
            </Button>
          )}
          {dirty && <span className="text-sm text-amber-700">Unsaved changes</span>}
          <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
            Zoom
            <input
              type="range"
              min={1.5}
              max={6}
              step={0.5}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              aria-label="Zoom"
            />
          </label>
        </div>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <SlipCanvas
          paperW={paper.w}
          paperH={paper.h}
          scale={scale}
          fields={fields}
          selected={selected}
          backgroundUrl={template.backgroundImageUrl}
          offsetXMm={offset.x}
          offsetYMm={offset.y}
          onSelect={setSelected}
          onChange={changeField}
        />
        <p className="text-xs text-slate-500">
          Drag a field to move it; drag its left or right edge to change the box width. The text
          shown is sample data. Real patient details are printed in its place.
        </p>
      </div>

      <div className="space-y-4">
        <PaperPanel
          name={name}
          paperW={paper.w}
          paperH={paper.h}
          onName={setName}
          onPaper={changePaper}
        />
        <FieldPicker fields={fields} selected={selected} onToggle={toggle} onSelect={setSelected} />
        {field && (
          <FieldProperties
            field={field}
            paperW={paper.w}
            paperH={paper.h}
            onChange={(patch) => changeField(field.key, patch)}
            onRemove={() => toggle(field.key, false)}
          />
        )}
        <CalibrationPanel
          offsetX={offset.x}
          offsetY={offset.y}
          busy={busy === "test" || busy === "guides" ? busy : null}
          onOffset={(x, y) => setOffset({ x, y })}
          onTestPrint={testPrint}
        />
        <BackgroundPanel template={template} onUpdated={setTemplate} />
        <Card className="p-4 text-xs text-slate-500">
          Reception prints with the default template unless they pick another on the Today screen.
        </Card>
      </div>
    </div>
  );
}
