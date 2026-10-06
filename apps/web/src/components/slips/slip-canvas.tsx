"use client";

import { Rnd } from "react-rnd";
import { FIELD_INFO, clamp, round1 } from "@/lib/slip-fields";
import type { SlipField, SlipFieldKey } from "@/lib/types";

const PT_TO_MM = 25.4 / 72;

/**
 * The paper on screen, 1 mm = `scale` px. Fields are dragged and resized with react-rnd and
 * saved back in millimetres, so the layout is independent of screen size and printer.
 * The scan of the blank form (if any) is only a backdrop for lining fields up: it is never
 * printed.
 */
export function SlipCanvas({
  paperW,
  paperH,
  scale,
  fields,
  selected,
  backgroundUrl,
  offsetXMm,
  offsetYMm,
  onSelect,
  onChange,
}: {
  paperW: number;
  paperH: number;
  scale: number;
  fields: SlipField[];
  selected: SlipFieldKey | null;
  backgroundUrl: string | null;
  offsetXMm: number;
  offsetYMm: number;
  onSelect: (key: SlipFieldKey | null) => void;
  onChange: (key: SlipFieldKey, patch: Partial<SlipField>) => void;
}) {
  const grid = scale * 0.5; // snap to half a millimetre
  return (
    <div className="overflow-auto rounded-xl border border-slate-300 bg-slate-200 p-3">
      <div
        className="relative mx-auto bg-white shadow-md"
        style={{
          width: paperW * scale,
          height: paperH * scale,
          backgroundImage: backgroundUrl
            ? "url(" + backgroundUrl + ")"
            : "linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)",
          backgroundSize: backgroundUrl ? "100% 100%" : 10 * scale + "px " + 10 * scale + "px",
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        {fields.map((f) => {
          const sizeMm = f.fontSizePt * PT_TO_MM;
          const active = selected === f.key;
          return (
            <Rnd
              key={f.key}
              bounds="parent"
              size={{ width: f.maxWidthMm * scale, height: sizeMm * 1.3 * scale }}
              position={{ x: f.xMm * scale, y: f.yMm * scale }}
              dragGrid={[grid, grid]}
              resizeGrid={[grid, grid]}
              enableResizing={{ left: true, right: true }}
              onDragStart={() => onSelect(f.key)}
              onDragStop={(_e, d) =>
                onChange(f.key, {
                  xMm: round1(clamp(d.x / scale, 0, paperW - f.maxWidthMm)),
                  yMm: round1(clamp(d.y / scale, 0, paperH)),
                })
              }
              onResizeStop={(_e, _dir, ref, _delta, pos) => {
                const width = round1(clamp(ref.offsetWidth / scale, 5, paperW));
                onChange(f.key, {
                  maxWidthMm: width,
                  xMm: round1(clamp(pos.x / scale, 0, Math.max(0, paperW - width))),
                });
              }}
              className={
                "cursor-move overflow-hidden border border-dashed " +
                (active
                  ? "z-10 border-brand-700 bg-brand-100/60"
                  : "border-slate-400 bg-sky-100/40 hover:bg-sky-100/70")
              }
            >
              <div
                title={FIELD_INFO[f.key].label}
                className="h-full leading-tight whitespace-nowrap text-slate-900 select-none"
                style={{
                  fontSize: sizeMm * scale + "px",
                  fontWeight: f.bold ? 700 : 400,
                  textAlign: f.align,
                }}
              >
                {FIELD_INFO[f.key].sample}
              </div>
            </Rnd>
          );
        })}
        {(offsetXMm !== 0 || offsetYMm !== 0) && (
          <div className="pointer-events-none absolute right-1 bottom-1 rounded bg-slate-900/70 px-2 py-0.5 text-xs text-white">
            Printer offset {offsetXMm} / {offsetYMm} mm is applied when printing
          </div>
        )}
      </div>
    </div>
  );
}
