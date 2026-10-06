/**
 * Pure layout maths for slips. Kept free of PDF code so it can be tested, and so the web
 * editor (which draws the same boxes on screen) can mirror it exactly.
 */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;

export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;
export const ptToMm = (pt: number): number => (pt * MM_PER_INCH) / PT_PER_INCH;

/**
 * Where the text baseline sits below the top of a field's box, as a fraction of the font
 * size. The editor draws text with `line-height: 1` in this proportion, so what you see in
 * the editor lines up with what prints (a test print on the real paper settles the rest).
 */
export const BASELINE_RATIO = 0.89;

export const MIN_FIT_PT = 6;

/** The largest size, at most `startPt`, at which the text fits `boxPt` wide (never below MIN_FIT_PT). */
export function fitFontSize(
  startPt: number,
  boxPt: number,
  widthAt: (sizePt: number) => number,
  minPt: number = MIN_FIT_PT,
): number {
  let size = startPt;
  while (size > minPt && widthAt(size) > boxPt) size = Math.max(minPt, size - 0.5);
  return size;
}

/** Shortens text with an ellipsis until it fits. Works on whole characters, not UTF-16 halves. */
export function truncateToFit(text: string, boxPt: number, widthOf: (t: string) => number): string {
  if (widthOf(text) <= boxPt) return text;
  const chars = Array.from(text);
  while (chars.length > 1) {
    chars.pop();
    const candidate = `${chars.join("").trimEnd()}…`;
    if (widthOf(candidate) <= boxPt) return candidate;
  }
  return chars.join("");
}

export interface Placement {
  /** Left edge of the text, in points from the left of the page. */
  x: number;
  /** Baseline, in points from the BOTTOM of the page (PDF coordinates). */
  y: number;
}

/**
 * Converts a field's top-left position (mm, from the top-left of the paper, plus the
 * printer calibration offset) into PDF coordinates for text of a given width and size.
 */
export function placeText(input: {
  xMm: number;
  yMm: number;
  maxWidthMm: number;
  offsetXMm: number;
  offsetYMm: number;
  pageHeightPt: number;
  sizePt: number;
  textWidthPt: number;
  align: "left" | "center" | "right";
}): Placement {
  const boxX = mmToPt(input.xMm + input.offsetXMm);
  const boxW = mmToPt(input.maxWidthMm);
  const spare = Math.max(0, boxW - input.textWidthPt);
  const x =
    input.align === "left" ? boxX : input.align === "center" ? boxX + spare / 2 : boxX + spare;
  const top = input.pageHeightPt - mmToPt(input.yMm + input.offsetYMm);
  return { x, y: top - input.sizePt * BASELINE_RATIO };
}
