// SPDX-License-Identifier: GPL-3.0-or-later
// Copies PDF.js's worker into public/pdfjs, named by its version, so the
// browser loads it from Fulla's own site (pdfBrowser.ts) and a new version
// never meets a stale cached worker.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "pdfjs");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.startsWith("pdf.worker.")) rmSync(join(out, f));
copyFileSync(join(pkgDir, "legacy", "build", "pdf.worker.min.mjs"), join(out, `pdf.worker.${version}.min.mjs`));
console.log(`pdf.js worker ${version} → public/pdfjs`);
