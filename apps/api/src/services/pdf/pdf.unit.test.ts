import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { formatMoneyPdf, receiptNumber } from "../../modules/receipts/receipt.service.js";
import { drawText, loadFonts, textWidth, toRuns, wrapText } from "./fonts.js";

async function setup() {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);
  return { doc, fonts, page: doc.addPage([400, 400]) };
}

describe("PDF text", () => {
  it("uses the Devanagari font for Hindi and the Latin font for the rest", async () => {
    const { fonts } = await setup();
    const runs = toRuns("Rahul राहुल शर्मा, MD", fonts);
    // Spaces and punctuation stay with the script before them.
    expect(runs.map((r) => r.text)).toEqual(["Rahul ", "राहुल शर्मा, ", "MD"]);
    expect(runs[0]!.font).toBe(fonts.latin);
    expect(runs[1]!.font).toBe(fonts.devanagari);
    expect(runs[2]!.font).toBe(fonts.latin);
    expect(toRuns("राहुल", fonts, true)[0]!.font).toBe(fonts.devanagariBold);
  });

  it("draws the rupee sign and accented names without error", async () => {
    const { fonts } = await setup();
    expect(
      toRuns("₹1,250.00 José Müller", fonts)
        .map((r) => r.text)
        .join(""),
    ).toBe("₹1,250.00 José Müller");
  });

  it("replaces characters no font has with '?' instead of failing", async () => {
    const { fonts, page, doc } = await setup();
    const runs = toRuns("Hi 😀 你好", fonts);
    expect(runs.map((r) => r.text).join("")).toBe("Hi ? ??");
    drawText(page, "Hi 😀 你好 राहुल", { x: 10, y: 10, size: 12, fonts }); // must not throw
    expect((await doc.save()).length).toBeGreaterThan(1000);
  });

  it("measures and wraps text", async () => {
    const { fonts } = await setup();
    const one = textWidth("MediQ", 12, fonts);
    expect(one).toBeGreaterThan(20);
    expect(textWidth("MediQ", 12, fonts, true)).toBeGreaterThan(one); // bold is wider
    const lines = wrapText("one two three four five six seven eight", 60, 12, fonts);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("one two three four five six seven eight");
    for (const l of lines) expect(textWidth(l, 12, fonts)).toBeLessThanOrEqual(60 + 20); // a single long word may exceed
  });

  it("produces a valid PDF file", async () => {
    const { doc, page, fonts } = await setup();
    drawText(page, "Receipt ₹500 राहुल", { x: 20, y: 300, size: 14, fonts, bold: true });
    const bytes = await doc.save();
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});

describe("receipt helpers", () => {
  it("formats money for the receipt", () => {
    expect(formatMoneyPdf(50_000, "INR")).toBe("₹500.00");
    expect(formatMoneyPdf(123_456_78, "INR")).toBe("₹1,23,456.78"); // Indian digit grouping
    expect(formatMoneyPdf(500, "USD")).toBe("USD 5.00");
  });

  it("builds a readable receipt number from the payment id", () => {
    expect(
      receiptNumber("01a10bc5-4787-74ed-a4b1-4a1e1f6f1292", new Date("2026-10-05T10:00:00Z")),
    ).toBe("MQ-202610-1F6F1292");
  });
});
