// SPDX-License-Identifier: GPL-3.0-or-later
// Loads PDF.js only when a PDF is picked, with its worker from Fulla's own
// site (scripts/copy-pdf-worker.mjs puts it in public/pdfjs at build time),
// never from a CDN: the statement stays on the phone.
import type { PdfJs } from "./pdf";

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = `/pdfjs/pdf.worker.${m.version}.min.mjs`;
    return m as unknown as PdfJs;
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}
