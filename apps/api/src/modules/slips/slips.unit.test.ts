import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { loadFonts, textWidth } from "../../services/pdf/fonts.js";
import {
  BASELINE_RATIO,
  fitFontSize,
  mmToPt,
  placeText,
  ptToMm,
  truncateToFit,
} from "./slip-layout.js";
import {
  SAMPLE_VALUES,
  SLIP_FIELD_KEYS,
  parseStoredFields,
  slipTemplateBodySchema,
} from "./slip-fields.js";
import { renderSlips } from "./slip-render.js";

const template = {
  name: "OPD slip",
  paperWidthMm: 148,
  paperHeightMm: 210,
  offsetXMm: 0,
  offsetYMm: 0,
  fields: [
    {
      key: "patientName",
      xMm: 30,
      yMm: 50,
      maxWidthMm: 80,
      fontSizePt: 12,
      bold: true,
      align: "left",
    },
  ],
};

describe("millimetres and points", () => {
  it("convert both ways", () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 9);
    expect(mmToPt(148)).toBeCloseTo(419.53, 1); // A5 width
    expect(ptToMm(mmToPt(37.5))).toBeCloseTo(37.5, 9);
  });
});

describe("fitting text into its box", () => {
  const width = (size: number) => size * 10; // pretend text is 10 em wide

  it("keeps the size when it fits and shrinks in half-point steps when it doesn't", () => {
    expect(fitFontSize(12, 200, width)).toBe(12);
    expect(fitFontSize(12, 100, width)).toBe(10);
    expect(fitFontSize(12, 95, width)).toBe(9.5);
  });

  it("never goes below the minimum", () => {
    expect(fitFontSize(12, 10, width)).toBe(6);
    expect(fitFontSize(12, 10, width, 8)).toBe(8);
  });

  it("truncates with an ellipsis only when shrinking was not enough", () => {
    const widthOf = (t: string) => t.length * 5;
    expect(truncateToFit("short", 100, widthOf)).toBe("short");
    expect(truncateToFit("a very long reason for the visit", 60, widthOf)).toBe("a very long…");
    expect(truncateToFit("x".repeat(50), 1, widthOf)).toBe("x");
  });

  it("does not split an emoji or a Hindi letter in half", () => {
    const widthOf = (t: string) => Array.from(t).length * 5;
    expect(truncateToFit("😀😀😀😀😀😀", 20, widthOf)).toBe("😀😀😀…");
  });
});

describe("where text lands on the page", () => {
  const base = {
    xMm: 30,
    yMm: 50,
    maxWidthMm: 80,
    offsetXMm: 0,
    offsetYMm: 0,
    pageHeightPt: mmToPt(210),
    sizePt: 12,
    textWidthPt: 100,
  };

  it("puts the box's top-left at the saved millimetre position", () => {
    const { x, y } = placeText({ ...base, align: "left" });
    expect(x).toBeCloseTo(mmToPt(30), 6);
    // PDF y counts from the bottom: top of box is 50 mm down, baseline is a little below that.
    expect(y).toBeCloseTo(mmToPt(210) - mmToPt(50) - 12 * BASELINE_RATIO, 6);
  });

  it("applies the printer's X/Y calibration offset", () => {
    const plain = placeText({ ...base, align: "left" });
    const shifted = placeText({ ...base, offsetXMm: 2, offsetYMm: -1.5, align: "left" });
    expect(shifted.x - plain.x).toBeCloseTo(mmToPt(2), 6);
    // Positive Y offset moves DOWN the page, so the PDF y (from the bottom) decreases.
    expect(shifted.y - plain.y).toBeCloseTo(mmToPt(1.5), 6);
  });

  it("aligns within the box", () => {
    const left = placeText({ ...base, align: "left" }).x;
    const box = mmToPt(80);
    expect(placeText({ ...base, align: "center" }).x).toBeCloseTo(left + (box - 100) / 2, 6);
    expect(placeText({ ...base, align: "right" }).x).toBeCloseTo(left + box - 100, 6);
  });

  it("never pushes text left of its box when the text is wider than the box", () => {
    const left = placeText({ ...base, textWidthPt: 999, align: "left" }).x;
    expect(placeText({ ...base, textWidthPt: 999, align: "right" }).x).toBeCloseTo(left, 6);
  });
});

describe("slip template validation", () => {
  it("accepts a good template and rounds positions to 0.1 mm", () => {
    const parsed = slipTemplateBodySchema.parse({
      ...template,
      fields: [{ ...template.fields[0], xMm: 30.04, yMm: 50.06 }],
    });
    expect(parsed.fields[0]).toMatchObject({ xMm: 30, yMm: 50.1, bold: true });
    expect(parsed.offsetXMm).toBe(0);
  });

  it("rejects fields outside the paper, duplicates, unknown keys and silly sizes", () => {
    const bad = (patch: object) =>
      slipTemplateBodySchema.safeParse({ ...template, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ fields: [{ ...template.fields[0], xMm: 200 }] })).toBe(false);
    expect(bad({ fields: [{ ...template.fields[0], yMm: 300 }] })).toBe(false);
    expect(bad({ fields: [{ ...template.fields[0], xMm: 100, maxWidthMm: 80 }] })).toBe(false); // runs off the right edge
    expect(bad({ fields: [template.fields[0], template.fields[0]] })).toBe(false);
    expect(bad({ fields: [{ ...template.fields[0], key: "passwordHash" }] })).toBe(false);
    expect(bad({ fields: [{ ...template.fields[0], fontSizePt: 200 }] })).toBe(false);
    expect(bad({ paperWidthMm: 5 })).toBe(false);
    expect(bad({ offsetXMm: 50 })).toBe(false);
    expect(bad({ name: " " })).toBe(false);
  });

  it("ignores damaged stored fields instead of crashing a print run", () => {
    expect(parseStoredFields("garbage")).toEqual([]);
    expect(parseStoredFields([{ key: "nope" }])).toEqual([]);
    expect(parseStoredFields([template.fields[0]])).toHaveLength(1);
  });

  it("offers a sample for every field", () => {
    for (const key of SLIP_FIELD_KEYS) expect(SAMPLE_VALUES[key]).toBeTruthy();
  });
});

/** The drawing instructions of a PDF's first page, as text (text-show operators, lines, rectangles). */
async function pageOps(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => doc.context.lookup(ref))
      : contents
        ? [contents]
        : [];
  return streams
    .map((st) => Buffer.from(decodePDFRawStream(st as PDFRawStream).decode()).toString("latin1"))
    .join("\n");
}
// PDF operators are whole words separated by spaces or line breaks.
const hasText = (ops: string) => /(^|\s)(Tj|TJ)(\s|$)/.test(ops);
const hasShapes = (ops: string) => /(^|\s)(re|l|S|f)(\s|$)/.test(ops);

describe("slip PDF", () => {
  const layout = { ...template, fields: slipTemplateBodySchema.parse(template).fields };

  it("makes one page per slip, sized exactly to the paper", async () => {
    const bytes = await renderSlips(layout, [
      { patientName: "A" },
      { patientName: "B" },
      { patientName: "C" },
    ]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(mmToPt(148), 2);
    expect(height).toBeCloseTo(mmToPt(210), 2);
  });

  it("prints data only: text at the saved positions, no lines or boxes, and a blank page when there is no data", async () => {
    const printed = await pageOps(await renderSlips(layout, [{ patientName: "Rahul Sharma" }]));
    expect(hasText(printed)).toBe(true);
    expect(hasShapes(printed)).toBe(false); // the paper is pre-printed: nothing else is drawn

    const blank = await pageOps(await renderSlips(layout, [{}]));
    expect(hasText(blank)).toBe(false);
    expect(hasShapes(blank)).toBe(false);
  });

  it("an alignment sheet adds a ruler and field boxes; a data-only print does not", async () => {
    const guides = await pageOps(
      await renderSlips(layout, [{ patientName: "Rahul" }], { guides: true }),
    );
    expect(hasShapes(guides)).toBe(true);
    expect(hasText(guides)).toBe(true);
  });

  it("handles Hindi names, very long text and an empty batch without throwing", async () => {
    await expect(renderSlips(layout, [{ patientName: "राहुल शर्मा" }])).resolves.toBeInstanceOf(
      Uint8Array,
    );
    await expect(renderSlips(layout, [{ patientName: "Z".repeat(500) }])).resolves.toBeInstanceOf(
      Uint8Array,
    );
    const doc = await PDFDocument.load(await renderSlips(layout, []));
    expect(doc.getPageCount()).toBe(1); // a blank sheet rather than an invalid, page-less PDF
  });

  it("shrinks long text to fit its box", async () => {
    const doc = await PDFDocument.create();
    const fonts = await loadFonts(doc);
    const long = "Shri Ramchandra Venkatasubramaniam Iyer";
    const natural = textWidth(long, 12, fonts, true);
    expect(natural).toBeGreaterThan(mmToPt(80)); // does not fit at 12 pt, so the renderer must shrink it
  });
});
