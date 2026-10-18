// SPDX-License-Identifier: GPL-3.0-or-later
// Wealthsimple's activity export of an investment account (TFSA, RESP,
// non-registered, …) as CSV: "date","transaction","description","amount",
// "balance","currency", one row per move of the account's cash, the
// transaction column holding the same codes as the PDF statement's activity
// (BUY, DIV, DEP, FEE, GRANT, …). Read the way investmentPdf.ts reads the
// statement: money in and out, dividends, interest and grants (income), fees
// and taxes withheld (spending); trades and other moves inside the account
// counted and left out; every running balance checked to the cent. The export
// names no account and no market value: the account is picked on import and
// no balance is saved for net worth.
import type { PdfStatementResult, BalanceMismatch } from "./wealthsimplePdf";
import { parseCsv } from "./csv";
import { groupDividends } from "./dividends";
import { INVESTMENT_CODES } from "./investmentPdf";
import type { StatementLine } from "./types";

const HEADER = ["date", "transaction", "description", "amount", "balance", "currency"];
/** Codes only an investment account's activity has (a chequing export has none of them). */
const TRADES = new Set(["BUY", "SELL", "DIV", "DIST", "NRT", "GRANT", "CONT", "STKDIS", "STKREORG", "REIMB", "FPLINT", "WHT"]);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "-32.68", "129.0", "100" → minor units; null for anything else. */
function cents(text: string): number | null {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return m[1] ? -minor : minor;
}

function rowsOf(text: string): string[][] | null {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""), ",");
  const head = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!head || head.length !== HEADER.length || head.some((h, i) => h !== HEADER[i])) return null;
  return rows.slice(1);
}

/** True when the text is a Wealthsimple investment account's activity export. */
export function looksLikeWealthsimpleActivityCsv(text: string): boolean {
  const rows = rowsOf(text);
  if (!rows || rows.length === 0) return false;
  return rows.every((r) => r.length === HEADER.length && ISO.test(r[0].trim())) && rows.some((r) => TRADES.has(r[1].trim().toUpperCase()));
}

const clean = (s: string) =>
  s.replace(/\s*\(executed at[^)]*\)?/gi, "").replace(/,?\s*received on \d{4}-\d{2}-\d{2}.*$/i, "").replace(/,?\s*record date.*$/i, "")
    .replace(/,?\s*FX Rate:.*$/i, "").replace(/\s+/g, " ").replace(/[\s,]+$/, "").trim();

/** Reads the export; null when it is not one (looksLikeWealthsimpleActivityCsv). */
export function readWealthsimpleActivityCsv(text: string, householdCurrency = "CAD"): PdfStatementResult | null {
  if (!looksLikeWealthsimpleActivityCsv(text)) return null;
  const rows = rowsOf(text)!.map((r) => ({
    date: r[0].trim(), code: r[1].trim().toUpperCase(), description: r[2].trim(), amount: cents(r[3]), balance: cents(r[4]), currency: r[5].trim().toUpperCase(),
  }));
  const currency = rows[0].currency || householdCurrency;

  // Every row's running balance, in the order the export lists them, per currency.
  const mismatches: BalanceMismatch[] = [];
  const balancesMinor: number[] = [];
  let ok = rows.every((r) => r.amount !== null && r.balance !== null);
  const last = new Map<string, number>();
  let opening: number | null = null;
  let closing: number | null = null;
  rows.forEach((r, i) => {
    if (r.amount === null || r.balance === null) return;
    const before = last.get(r.currency) ?? r.balance - r.amount;
    if (r.currency === currency && opening === null) opening = before;
    const expected = before + r.amount;
    if (expected !== r.balance) { mismatches.push({ index: i, expectedMinor: expected, statedMinor: r.balance }); ok = false; }
    last.set(r.currency, r.balance);
    if (r.currency === currency) { closing = r.balance; balancesMinor.push(r.balance); }
  });

  const lines: StatementLine[] = [];
  const posted: string[] = [];
  let ignored = 0;
  for (const r of rows) {
    const what = INVESTMENT_CODES[r.code];
    // Another currency's cash has no rate in the export: left out, like a trade.
    if (!what || !r.amount || r.currency !== currency) { ignored++; continue; }
    lines.push({ date: r.date, amountMinor: r.amount, description: clean(r.description) || r.code, role: what.role });
    posted.push(r.date);
  }
  const grouped = groupDividends(lines, posted);
  const dates = rows.map((r) => r.date).sort();
  const start = dates[0];
  const end = dates[dates.length - 1];
  const label = rows.some((r) => r.code === "GRANT") ? "Wealthsimple RESP" : "Wealthsimple investment";
  return {
    lines: grouped.lines, posted: grouped.posted,
    balance: { openingMinor: opening, closingMinor: closing, balancesMinor, mismatches, closingMatches: null, ok },
    currency,
    period: `${start} to ${end}`,
    kind: "investment",
    format: `${label} activity (CSV)`,
    ignored,
    statement: { institution: "Wealthsimple", type: "investment", last4: null, closingBalanceMinor: null, closingDate: end, label, periodStart: start, version: 1 },
  };
}
