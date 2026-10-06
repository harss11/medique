import { PDFDocument, rgb } from "pdf-lib";
import { drawText, loadFonts, textWidth } from "../../services/pdf/fonts.js";
import { fitFontSize, mmToPt, placeText, truncateToFit } from "./slip-layout.js";
import type { SlipField, SlipValues } from "./slip-fields.js";

export interface SlipLayout {
  paperWidthMm: number;
  paperHeightMm: number;
  offsetXMm: number;
  offsetYMm: number;
  fields: SlipField[];
}

export interface RenderOptions {
  /**
   * Alignment sheet for plain paper: field boxes, a ruler and the calibration origin.
   * Never used for real slips, which print the data only (the paper is pre-printed).
   */
  guides?: boolean;
}

const INK = rgb(0, 0, 0);
const GUIDE = rgb(0.55, 0.62, 0.7);
const GUIDE_FAINT = rgb(0.82, 0.86, 0.9);

/**
 * One PDF page per slip, sized exactly to the paper, with ONLY the data drawn, at the saved
 * millimetre positions plus the calibration offset. No background, no logo, no borders: the
 * hospital's pre-printed paper supplies those. Print at 100% ("Actual size"), not "fit to page".
 */
export async function renderSlips(
  layout: SlipLayout,
  rows: SlipValues[],
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(options.guides ? "Slip alignment sheet" : "Doctor slips");
  doc.setCreator("MediQ");
  const sample = rows.flatMap((r) => Object.values(r)).join(" ");
  const fonts = await loadFonts(doc, { text: sample });

  const pageW = mmToPt(layout.paperWidthMm);
  const pageH = mmToPt(layout.paperHeightMm);

  for (const values of rows.length ? rows : [{} as SlipValues]) {
    const page = doc.addPage([pageW, pageH]);
    if (options.guides) drawGuides(page, layout, pageW, pageH);

    for (const field of layout.fields) {
      const value = values[field.key]?.trim();
      if (!value) continue;
      const boxPt = mmToPt(field.maxWidthMm);
      const size = fitFontSize(field.fontSizePt, boxPt, (s) =>
        textWidth(value, s, fonts, field.bold),
      );
      const text = truncateToFit(value, boxPt, (t) => textWidth(t, size, fonts, field.bold));
      const { x, y } = placeText({
        xMm: field.xMm,
        yMm: field.yMm,
        maxWidthMm: field.maxWidthMm,
        offsetXMm: layout.offsetXMm,
        offsetYMm: layout.offsetYMm,
        pageHeightPt: pageH,
        sizePt: size,
        textWidthPt: textWidth(text, size, fonts, field.bold),
        align: field.align,
      });
      drawText(page, text, { x, y, size, fonts, bold: field.bold, color: INK });
    }
  }
  return doc.save();
}

function drawGuides(
  page: ReturnType<PDFDocument["addPage"]>,
  layout: SlipLayout,
  pageW: number,
  pageH: number,
) {
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color = GUIDE_FAINT,
    thickness = 0.4,
  ) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });

  // Paper edge, so a shifted printout is obvious.
  page.drawRectangle({
    x: 0.5,
    y: 0.5,
    width: pageW - 1,
    height: pageH - 1,
    borderColor: GUIDE,
    borderWidth: 0.5,
  });

  // Ruler: a tick every millimetre, longer every 5 and numbered every 10, along the top and left.
  for (let mm = 0; mm <= layout.paperWidthMm; mm++) {
    const x = mmToPt(mm);
    const len = mm % 10 === 0 ? 8 : mm % 5 === 0 ? 5 : 2.5;
    line(x, pageH, x, pageH - len, GUIDE, 0.4);
    if (mm % 10 === 0 && mm > 0)
      page.drawText(String(mm), { x: x + 1.5, y: pageH - 16, size: 5, color: GUIDE });
  }
  for (let mm = 0; mm <= layout.paperHeightMm; mm++) {
    const y = pageH - mmToPt(mm);
    const len = mm % 10 === 0 ? 8 : mm % 5 === 0 ? 5 : 2.5;
    line(0, y, len, y, GUIDE, 0.4);
    if (mm % 10 === 0 && mm > 0)
      page.drawText(String(mm), { x: 10, y: y - 6, size: 5, color: GUIDE });
  }

  // The calibration origin: where (0, 0) lands after the X/Y offset is applied.
  const ox = mmToPt(layout.offsetXMm);
  const oy = pageH - mmToPt(layout.offsetYMm);
  line(ox - 10, oy, ox + 10, oy, GUIDE, 0.6);
  line(ox, oy - 10, ox, oy + 10, GUIDE, 0.6);

  // A box and a label for every field.
  for (const f of layout.fields) {
    const x = mmToPt(f.xMm + layout.offsetXMm);
    const top = pageH - mmToPt(f.yMm + layout.offsetYMm);
    const h = f.fontSizePt * 1.2;
    page.drawRectangle({
      x,
      y: top - h,
      width: mmToPt(f.maxWidthMm),
      height: h,
      borderColor: GUIDE,
      borderWidth: 0.4,
    });
    page.drawText(f.key, { x: x + 1, y: top + 1.5, size: 4.5, color: GUIDE });
  }
}
