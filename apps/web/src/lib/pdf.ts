import { errorMessage } from "./api";

/**
 * Opens a PDF in a new tab (the browser's viewer offers print and save). If pop-ups are
 * blocked it downloads the file instead. Returns an error message, or null on success.
 */
export function showPdf(blob: Blob, filename: string): string | null {
  try {
    const url = URL.createObjectURL(blob);
    if (!window.open(url, "_blank")) {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}
