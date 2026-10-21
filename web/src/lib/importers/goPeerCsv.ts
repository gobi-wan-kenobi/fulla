// SPDX-License-Identifier: GPL-3.0-or-later
// goPeer's loan activity export as CSV: Date (YYYY/MM/DD), Type, Description,
// Stage, Amount. Every move is listed twice, when it starts (INITIATED) and
// when it is done (COMPLETED); only completed ones are money that moved. A
// loan payment is money from the bank into the loan (a transfer: what is
// owed goes down); the disbursement is the loan paid out to the bank (a
// transfer the other way); the activation only opens the loan. The export
// says nothing of interest or of the balance: the loan's balance is not set
// from it, and nothing can be checked against one.
import type { PdfStatementResult } from "./wealthsimplePdf";
import { parseCsv } from "./csv";
import type { StatementLine } from "./types";

const HEADER = ["date", "type", "description", "stage", "amount"];

function rowsOf(text: string): string[][] | null {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""), ",").filter((r) => r.some((c) => c.trim()));
  const head = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!head || head.length !== HEADER.length || head.some((h, i) => h !== HEADER[i])) return null;
  return rows.slice(1);
}

/** "$200.00", "-$5000.00" → minor units; null otherwise. */
function cents(text: string): number | null {
  const m = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const minor = Number(m[2].replace(/,/g, "")) * 100 + Number(m[3] ?? "0");
  return m[1] ? -minor : minor;
}

/** True when the text is goPeer's loan activity export. */
export function looksLikeGoPeerCsv(text: string): boolean {
  const rows = rowsOf(text);
  return !!rows && rows.length > 0 && rows.every((r) => r.length === HEADER.length && /^\d{4}\/\d{2}\/\d{2}$/.test(r[0].trim())) &&
    rows.some((r) => /^loan (payment|disbursement|activation)$/i.test(r[1].trim()));
}

/** Reads the export; null when it is not one. Lines are oldest first; `from` keeps only those on or after a day. */
export function readGoPeerCsv(text: string, opts: { from?: string } = {}): PdfStatementResult | null {
  if (!looksLikeGoPeerCsv(text)) return null;
  const lines: StatementLine[] = [];
  let ignored = 0;
  for (const r of rowsOf(text)!) {
    const date = r[0].trim().replace(/\//g, "-");
    const type = r[1].trim().toLowerCase();
    const amount = cents(r[4]);
    if (r[3].trim().toUpperCase() !== "COMPLETED" || amount === null || amount === 0 || (opts.from && date < opts.from)) { ignored++; continue; }
    if (type === "loan payment") lines.push({ date, amountMinor: Math.abs(amount), description: "goPeer loan payment", role: "transfer" });
    else if (type === "loan disbursement") lines.push({ date, amountMinor: -Math.abs(amount), description: "goPeer loan disbursement", role: "transfer" });
    else ignored++;
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  const dates = lines.map((l) => l.date);
  return {
    lines, posted: dates,
    balance: { openingMinor: null, closingMinor: null, balancesMinor: [], mismatches: [], closingMatches: null, ok: true },
    currency: "CAD",
    period: dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : null,
    kind: "card",
    format: "goPeer loan activity (CSV)",
    ignored,
    statement: { institution: "goPeer", type: "loan", last4: null, closingBalanceMinor: null, closingDate: null, label: "goPeer loan", periodStart: dates[0] ?? null, version: 1 },
  };
}
