import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
// fontkit's Indic (Devanagari) shaper was compiled for browsers and expects this global.
import "regenerator-runtime/runtime.js";
import type { PDFDocument, PDFFont, PDFPage, RGB } from "pdf-lib";

/**
 * PDF text that can show ₹ and Indian-language names.
 *
 * pdf-lib's built-in fonts can't draw ₹ or Devanagari (and throw on characters they
 * don't know), so we embed Noto Sans (Latin, Greek, Cyrillic, currency symbols) and
 * Noto Sans Devanagari (SIL Open Font License, see assets/fonts/OFL.txt). Text is split
 * into runs by script and each run uses the right font; Devanagari conjuncts are
 * shaped by fontkit. A character neither font has is drawn as "?" instead of failing.
 */

const DEVANAGARI = /\p{Script=Devanagari}/u;

export interface PdfFonts {
  latin: PDFFont;
  latinBold: PDFFont;
  devanagari: PDFFont;
  devanagariBold: PDFFont;
}

const FILES = {
  latin: "NotoSans-Regular.ttf",
  latinBold: "NotoSans-Bold.ttf",
  devanagari: "NotoSansDevanagari-Regular.ttf",
  devanagariBold: "NotoSansDevanagari-Bold.ttf",
} as const;

/** assets/ lives next to package.json; find it from the source tree, the build output, or the working directory. */
function fontPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../assets/fonts", file), // src/services/pdf
    join(here, "../assets/fonts", file), // dist/
    join(process.cwd(), "assets/fonts", file),
    join(process.cwd(), "apps/api/assets/fonts", file),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Font file ${file} not found (looked in ${candidates.join(", ")})`);
  return found;
}

const bytesCache = new Map<string, Buffer>();
function fontBytes(file: string): Buffer {
  let bytes = bytesCache.get(file);
  if (!bytes) {
    bytes = readFileSync(fontPath(file));
    bytesCache.set(file, bytes);
  }
  return bytes;
}

interface FontkitFont {
  numGlyphs: number;
  getGlyph(id: number): unknown;
}
interface PdfLibEmbedder {
  font: FontkitFont;
  glyphCache: { populate: () => unknown };
}

/**
 * pdf-lib writes the PDF's glyph-width table only for glyphs reachable from a Unicode
 * character. Shaped Hindi text uses glyphs that are not (conjuncts, vowel-sign forms), so
 * viewers would give them a default width and space the text wrongly. This makes the
 * table cover every glyph in the font. It relies on pdf-lib internals (pinned in
 * package.json) and fails loudly, not silently, if they ever change.
 */
function includeAllGlyphWidths(font: PDFFont): PDFFont {
  const embedder = (font as unknown as { embedder?: Partial<PdfLibEmbedder> }).embedder;
  if (
    !embedder?.font ||
    typeof embedder.font.numGlyphs !== "number" ||
    typeof embedder.glyphCache?.populate !== "function"
  ) {
    throw new Error(
      "pdf-lib internals changed: cannot extend the glyph width table (see services/pdf/fonts.ts)",
    );
  }
  const { font: fontkitFont, glyphCache } = embedder as PdfLibEmbedder;
  glyphCache.populate = () =>
    Array.from({ length: fontkitFont.numGlyphs }, (_, id) => fontkitFont.getGlyph(id));
  return font;
}

/**
 * Embeds the fonts a document needs. `text` is everything the document will draw: the
 * Hindi fonts are only embedded when it contains Devanagari, which keeps ordinary
 * (English) PDFs small.
 *
 * Fonts are embedded whole (they are pre-trimmed to the characters we support, ~100 KB
 * each), not through pdf-lib's runtime subsetting: that drops glyphs when the same font
 * is used for several strings in one page.
 */
export async function loadFonts(
  doc: PDFDocument,
  options: { text?: string } = {},
): Promise<PdfFonts> {
  doc.registerFontkit(fontkit);
  const embed = async (file: string) =>
    includeAllGlyphWidths(await doc.embedFont(fontBytes(file), { subset: false }));
  const [latin, latinBold] = await Promise.all([embed(FILES.latin), embed(FILES.latinBold)]);
  const needsHindi = options.text === undefined || DEVANAGARI.test(options.text);
  if (!needsHindi) return { latin, latinBold, devanagari: latin, devanagariBold: latinBold };
  const [devanagari, devanagariBold] = await Promise.all([
    embed(FILES.devanagari),
    embed(FILES.devanagariBold),
  ]);
  return { latin, latinBold, devanagari, devanagariBold };
}

const characterSets = new WeakMap<PDFFont, Set<number>>();
function supports(font: PDFFont, codePoint: number): boolean {
  let set = characterSets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    characterSets.set(font, set);
  }
  return set.has(codePoint);
}

const COMMON = /[\p{Script=Common}\p{Script=Inherited}]/u;

export interface Run {
  font: PDFFont;
  text: string;
}

/** Splits text into runs that each use one font; unsupported characters become "?". */
export function toRuns(text: string, fonts: PdfFonts, bold = false): Run[] {
  const latin = bold ? fonts.latinBold : fonts.latin;
  const devanagari = bold ? fonts.devanagariBold : fonts.devanagari;
  const runs: Run[] = [];
  let current: PDFFont = latin;
  for (const ch of text.normalize("NFC")) {
    if (/[\r\n\t]/.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    // Spaces and punctuation stay with whatever script came before them.
    const wanted = DEVANAGARI.test(ch) ? devanagari : COMMON.test(ch) ? current : latin;
    let font = wanted;
    let out = ch;
    if (!supports(font, cp)) {
      const other = font === latin ? devanagari : latin;
      if (supports(other, cp)) font = other;
      else {
        font = latin;
        out = "?";
      }
    }
    current = font;
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += out;
    else runs.push({ font, text: out });
  }
  return runs;
}

export function textWidth(text: string, size: number, fonts: PdfFonts, bold = false): number {
  return toRuns(text, fonts, bold).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
}

/** Draws text at (x, y) and returns its width. `align: "right"` treats x as the right edge. */
export function drawText(
  page: PDFPage,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    fonts: PdfFonts;
    bold?: boolean;
    color?: RGB;
    align?: "left" | "right";
  },
): number {
  const { x, y, size, fonts, bold = false, color, align = "left" } = options;
  const width = textWidth(text, size, fonts, bold);
  let cursor = align === "right" ? x - width : x;
  for (const run of toRuns(text, fonts, bold)) {
    page.drawText(run.text, { x: cursor, y, size, font: run.font, color });
    cursor += run.font.widthOfTextAtSize(run.text, size);
  }
  return width;
}

/** Breaks text into lines no wider than `maxWidth` (at word boundaries when possible). */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  fonts: PdfFonts,
  bold = false,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && textWidth(candidate, size, fonts, bold) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
