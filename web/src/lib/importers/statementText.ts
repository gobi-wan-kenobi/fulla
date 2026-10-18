// SPDX-License-Identifier: GPL-3.0-or-later
// Small readers shared by the PDF statement parsers (cardPdf.ts,
// investmentPdf.ts): money as statements print it, month-and-day dates with
// the year worked out from the statement period, and labelled values.
import type { PdfLine } from "./wealthsimplePdf";

/**
 * Money as a statement prints it, signed, in minor units (two decimals):
 * "$1,234.56", "-120.00", "- $350.00", "+ $0.00", "= $2,527.36", ".99".
 * Null for anything else (a rate such as "1.99%", a quantity with more decimals).
 */
export function money(text: string): number | null {
  const m = /^([-–−+=])?\s*([-–−])?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?\.(\d{2})(?:\s*(?:CAD|USD))?$/.exec(text.replace(/[\u00a0\u202f]/g, " ").trim());
  if (!m) return null;
  const minor = Number((m[3] ?? "0").replace(/,/g, "")) * 100 + Number(m[4]);
  if (!Number.isSafeInteger(minor)) return null;
  const negative = (m[1] && /[-–−]/.test(m[1])) || !!m[2];
  return negative ? -minor : minor;
}

export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Sep 16, 2026" or "Sept. 16, 2026" → "2026-09-16"; null otherwise. */
export function fullDate(text: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  return m && month ? `${m[3]}-${pad(month)}-${pad(Number(m[2]))}` : null;
}

/** "Aug 19" → month 8, day 19; null otherwise. */
export function monthDay(text: string): { month: number; day: number } | null {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  return m && month ? { month, day: Number(m[2]) } : null;
}

/** A month and day within a statement ending on `end`: in its year, or the year before for a date well after the end. */
export function dateIn(md: { month: number; day: number }, end: string): string {
  const year = Number(end.slice(0, 4));
  const here = `${year}-${pad(md.month)}-${pad(md.day)}`;
  const limit = new Date(Date.parse(`${end}T00:00:00Z`) + 31 * 86400000).toISOString().slice(0, 10);
  return here > limit ? `${year - 1}-${pad(md.month)}-${pad(md.day)}` : here;
}

export const lineText = (l: PdfLine) => l.cells.map((c) => c.text).join(" ");

/** The first money printed after a cell matching `label` on the same line, on the first line that has one. */
export function labelled(lines: PdfLine[], label: RegExp): number | null {
  for (const l of lines) {
    const i = l.cells.findIndex((c) => label.test(c.text));
    if (i < 0) continue;
    for (const c of l.cells.slice(i + 1)) {
      const v = money(c.text);
      if (v !== null) return v;
    }
  }
  return null;
}

/** "UNITED STATES DOLLAR" → "USD", for the currencies card statements spell out. */
const CURRENCY_NAMES: Record<string, string> = {
  "united states dollar": "USD", "us dollar": "USD", "euro": "EUR", "british pound": "GBP", "pound sterling": "GBP",
  "japanese yen": "JPY", "mexican peso": "MXN", "australian dollar": "AUD", "swiss franc": "CHF", "indian rupee": "INR",
  "hong kong dollar": "HKD", "chinese yuan": "CNY", "new zealand dollar": "NZD", "singapore dollar": "SGD",
};

/** "UNITED STATES DOLLAR 20.00 @ 1.41200" → 2000 USD; null when the line is not a conversion. */
export function foreignAmount(text: string): { amountMinor: number; currency: string } | null {
  const m = /^([A-Za-z][A-Za-z .]+?)\s+(\d{1,3}(?:,\d{3})+|\d*)\.(\d{2})\s*@\s*\d+(?:\.\d+)?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/\s+/g, " ").trim();
  const code = CURRENCY_NAMES[name] ?? (/^[A-Z]{3}$/.test(m[1].trim()) ? m[1].trim() : null);
  if (!code) return null;
  return { amountMinor: Number((m[2] || "0").replace(/,/g, "")) * 100 + Number(m[3]), currency: code };
}
