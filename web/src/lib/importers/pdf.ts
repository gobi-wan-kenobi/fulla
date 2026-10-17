// SPDX-License-Identifier: GPL-3.0-or-later
// Text out of a PDF statement, here in the browser with PDF.js (Mozilla,
// Apache-2.0). The file is never uploaded: PDF.js and its worker are served
// from Fulla's own site and run on the phone. Scripts in the PDF never run
// (no eval, no scripting), and only text positions are read, never images.
import type { PdfPage } from "./wealthsimplePdf";
import { PdfStatementError } from "./wealthsimplePdf";

/** True when the bytes are a PDF ("%PDF-" in the first kilobyte, as readers accept). */
export function isPdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

/** The parts of PDF.js this file uses, so tests can hand in the Node build. */
export interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfJsDocument>; destroy?: () => Promise<void> };
}
interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  destroy(): Promise<void>;
}

/** Most pages Fulla reads from one statement: a monthly statement is a handful. */
export const MAX_PDF_PAGES = 60;

export async function extractPdfPages(bytes: Uint8Array, pdfjs: PdfJs): Promise<PdfPage[]> {
  let doc: PdfJsDocument;
  try {
    // PDF.js may take the buffer over; give it a copy so the caller's bytes stay usable.
    doc = await pdfjs.getDocument({
      data: bytes.slice(), isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false,
      stopAtErrors: false, verbosity: 0,
    }).promise;
  } catch (e) {
    const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
    throw new PdfStatementError(name === "PasswordException" ? "password" : "unreadable");
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new PdfStatementError("not-chequing");
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const cells = [];
      for (const it of content.items) {
        const item = it as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
        if (typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
        const t = item.transform as number[];
        cells.push({
          text: item.str, x: t[4], y: t[5], width: typeof item.width === "number" ? item.width : 0,
          height: typeof item.height === "number" && item.height > 0 ? item.height : Math.abs(t[3]) || 0,
        });
      }
      pages.push({ cells });
    }
    return pages;
  } catch (e) {
    if (e instanceof PdfStatementError) throw e;
    throw new PdfStatementError("unreadable");
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
