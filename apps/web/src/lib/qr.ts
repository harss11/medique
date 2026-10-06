import QRCode from "qrcode";

export interface QrCardOptions {
  /** What the QR code contains (a URL or a check-in code). */
  value: string;
  /** Large heading, e.g. the hospital or doctor name. */
  title: string;
  /** Smaller line(s) under the code, e.g. "Scan to book" or the link itself. */
  caption?: string;
}

const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The code as a PNG data URL. Generated in the browser: nothing is sent anywhere. */
export function qrDataUrl(value: string, width = 640): Promise<string> {
  return QRCode.toDataURL(value, { margin: 2, width, errorCorrectionLevel: "M" });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not draw the QR code"));
    img.src = src;
  });
}

/** Breaks `text` into lines no wider than `maxWidth` on the given canvas context. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Saves the code as a printable PNG with its title and caption underneath. */
export async function downloadQrCard(opts: QrCardOptions, filename: string): Promise<void> {
  const qr = await loadImage(await qrDataUrl(opts.value, 720));
  const canvas = document.createElement("canvas");
  const width = 900;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the QR card");

  const margin = 90;
  ctx.font = "bold 44px system-ui, sans-serif";
  const titleLines = wrapLines(ctx, opts.title, width - margin * 2);
  ctx.font = "30px system-ui, sans-serif";
  const captionLines = opts.caption ? wrapLines(ctx, opts.caption, width - margin * 2) : [];
  const height =
    margin + titleLines.length * 56 + 20 + 720 + 30 + captionLines.length * 40 + margin;
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let y = margin;
  ctx.font = "bold 44px system-ui, sans-serif";
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, y);
    y += 56;
  }
  y += 20;
  ctx.drawImage(qr, (width - 720) / 2, y, 720, 720);
  y += 720 + 30;
  ctx.fillStyle = "#475569";
  ctx.font = "30px system-ui, sans-serif";
  for (const line of captionLines) {
    ctx.fillText(line, width / 2, y);
    y += 40;
  }

  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = filename;
  link.click();
}

/** Opens a clean, print-ready page with the code and its title. Returns false if blocked. */
export async function printQrCard(opts: QrCardOptions): Promise<boolean> {
  const win = window.open("", "_blank");
  if (!win) return false;
  const src = await qrDataUrl(opts.value, 900);
  win.document
    .write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>
<style>
  body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:24mm 12mm;color:#0f172a}
  h1{font-size:28pt;margin:0 0 8mm}
  img{width:120mm;height:120mm}
  p{font-size:13pt;color:#475569;margin:6mm 0 0;word-break:break-all}
  @page{margin:10mm}
</style></head><body>
<h1>${escapeHtml(opts.title)}</h1>
<img src="${src}" alt="QR code">
${opts.caption ? `<p>${escapeHtml(opts.caption)}</p>` : ""}
<script>window.onload=function(){setTimeout(function(){window.print()},200)}</script>
</body></html>`);
  win.document.close();
  return true;
}
