"use client";

import { Button, Card, Checkbox, Field, Select } from "@/components/ui";
import { FIELD_INFO, PAPER_PRESETS, SLIP_FIELD_LIST, clamp, round1 } from "@/lib/slip-fields";
import type { SlipField, SlipFieldKey } from "@/lib/types";

/** Parses a number box; empty or invalid keeps the previous value. */
function num(raw: string, fallback: number): number {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : fallback;
}

export function PaperPanel({
  name,
  paperW,
  paperH,
  onName,
  onPaper,
}: {
  name: string;
  paperW: number;
  paperH: number;
  onName: (v: string) => void;
  onPaper: (w: number, h: number) => void;
}) {
  const preset = PAPER_PRESETS.find((p) => p.w === paperW && p.h === paperH)?.id ?? "custom";
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-slate-900">Paper</h2>
      <Field
        label="Template name"
        name="tpl-name"
        maxLength={60}
        value={name}
        onChange={(e) => onName(e.target.value)}
      />
      <Select
        label="Paper size"
        value={preset}
        onChange={(e) => {
          const p = PAPER_PRESETS.find((x) => x.id === e.target.value);
          if (p) onPaper(p.w, p.h);
        }}
      >
        {PAPER_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom size</option>
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Width (mm)"
          name="paper-w"
          type="number"
          min={40}
          max={500}
          step={0.5}
          value={paperW}
          onChange={(e) => onPaper(clamp(num(e.target.value, paperW), 40, 500), paperH)}
        />
        <Field
          label="Height (mm)"
          name="paper-h"
          type="number"
          min={40}
          max={500}
          step={0.5}
          value={paperH}
          onChange={(e) => onPaper(paperW, clamp(num(e.target.value, paperH), 40, 500))}
        />
      </div>
    </Card>
  );
}

export function FieldPicker({
  fields,
  selected,
  onToggle,
  onSelect,
}: {
  fields: SlipField[];
  selected: SlipFieldKey | null;
  onToggle: (key: SlipFieldKey, on: boolean) => void;
  onSelect: (key: SlipFieldKey) => void;
}) {
  const used = new Set(fields.map((f) => f.key));
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-slate-900">What to print</h2>
      <p className="text-xs text-slate-500">
        Tick the details your pre-printed slip needs, then drag each one to its place.
      </p>
      <ul className="space-y-1">
        {SLIP_FIELD_LIST.map((f) => (
          <li
            key={f.key}
            className={
              "flex items-center justify-between gap-2 rounded-lg px-2 py-1 " +
              (selected === f.key ? "bg-brand-50" : "")
            }
          >
            <Checkbox
              label={f.label}
              checked={used.has(f.key)}
              onChange={(on) => onToggle(f.key, on)}
            />
            {used.has(f.key) && (
              <button
                type="button"
                className="text-xs font-medium text-brand-800 hover:underline"
                onClick={() => onSelect(f.key)}
              >
                Edit
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function FieldProperties({
  field,
  paperW,
  paperH,
  onChange,
  onRemove,
}: {
  field: SlipField;
  paperW: number;
  paperH: number;
  onChange: (patch: Partial<SlipField>) => void;
  onRemove: () => void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-slate-900">{FIELD_INFO[field.key].label}</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="From left (mm)"
          name="f-x"
          type="number"
          step={0.1}
          value={field.xMm}
          onChange={(e) =>
            onChange({ xMm: round1(clamp(num(e.target.value, field.xMm), 0, paperW)) })
          }
        />
        <Field
          label="From top (mm)"
          name="f-y"
          type="number"
          step={0.1}
          value={field.yMm}
          onChange={(e) =>
            onChange({ yMm: round1(clamp(num(e.target.value, field.yMm), 0, paperH)) })
          }
        />
        <Field
          label="Box width (mm)"
          name="f-w"
          type="number"
          step={0.5}
          value={field.maxWidthMm}
          onChange={(e) =>
            onChange({
              maxWidthMm: round1(clamp(num(e.target.value, field.maxWidthMm), 5, paperW)),
            })
          }
        />
        <Field
          label="Font size (pt)"
          name="f-size"
          type="number"
          step={0.5}
          value={field.fontSizePt}
          onChange={(e) =>
            onChange({ fontSizePt: clamp(num(e.target.value, field.fontSizePt), 5, 48) })
          }
        />
      </div>
      <Select
        label="Alignment in the box"
        value={field.align}
        onChange={(e) => onChange({ align: e.target.value as SlipField["align"] })}
      >
        <option value="left">Left</option>
        <option value="center">Centre</option>
        <option value="right">Right</option>
      </Select>
      <Checkbox label="Bold" checked={field.bold} onChange={(bold) => onChange({ bold })} />
      <p className="text-xs text-slate-500">
        Long text shrinks to fit the box (down to 6 pt) and is then shortened with “…”.
      </p>
      <Button variant="ghost" className="h-9 px-3 text-red-700 hover:bg-red-50" onClick={onRemove}>
        Remove from slip
      </Button>
    </Card>
  );
}
