// SPDX-License-Identifier: GPL-3.0-or-later
// Wealthsimple chequing monthly statements, as PDF. The text is laid out in
// columns (DATE, POSTED DATE, DESCRIPTION, AMOUNT (CAD), BALANCE (CAD)), one
// row per transaction, a long description wrapping onto lines of its own under
// the description column, a page footer, the column header again on every
// page, and the opening and closing balances in a summary on the first page.
// This file only reads text already taken out of the PDF (pdf.ts does that),
// so it is plain code with no PDF library, and every rule here has a test.
import type { Currency } from "../money";
import { lastFour, type StatementAccountInfo, type StatementLine } from "./types";

/** One run of text on a PDF page: x and y in points from the bottom left, as PDF.js gives them. */
export interface PdfCell {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPage {
  cells: PdfCell[];
}

/** A visual line: cells at the same height, left to right, touching runs joined. */
export interface PdfLine {
  page: number;
  y: number;
  height: number;
  cells: PdfCell[];
}

/** Why a PDF cannot be read, for the import screen to say in words. */
export type PdfProblem = "no-text" | "not-wealthsimple" | "not-chequing" | "no-rows" | "unreadable" | "password";

export class PdfStatementError extends Error {
  constructor(public readonly problem: PdfProblem) {
    super(problem);
    this.name = "PdfStatementError";
  }
}

/** A row whose running balance is not the one before plus its amount. */
export interface BalanceMismatch {
  /** Index into lines. */
  index: number;
  /** What the previous balance plus this amount gives, in minor units. */
  expectedMinor: number;
  /** What the statement prints. */
  statedMinor: number;
}

export interface BalanceCheck {
  openingMinor: number | null;
  closingMinor: number | null;
  /** Every row's running balance, in minor units, as printed. */
  balancesMinor: number[];
  mismatches: BalanceMismatch[];
  /** The last running balance against the closing balance in the summary; null when there is no summary. */
  closingMatches: boolean | null;
  /** True when every row and the closing balance agree. */
  ok: boolean;
}

export interface PdfStatementResult {
  lines: StatementLine[];
  /** The posted date of each line (the date column is when it happened). */
  posted: string[];
  balance: BalanceCheck;
  currency: string;
  period: string | null;
  /** The account the statement is for: Wealthsimple, chequing, the number's last four digits, the closing balance and day. */
  statement: StatementAccountInfo;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A dollar amount as the statement prints it: an en dash (or a hyphen or minus sign) for money out.
const MONEY = /^([–\-−])?\s*\+?\s*\$\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/;
const BALANCE_LABEL = /^[A-Z]{3}\s+\d{1,2}\s+BALANCE$/i;

/** Statement money text → signed minor units, without a float. Null when it is not money. */
export function parseStatementMoney(text: string, currency: Currency): number | null {
  const m = MONEY.exec(text.replace(/[\u00a0\u202f]/g, " ").trim());
  if (!m) return null;
  if (currency.minorUnits !== 2) return null;
  const whole = Number(m[2].replace(/,/g, ""));
  const minor = whole * 100 + Number(m[3]);
  if (!Number.isSafeInteger(minor)) return null;
  return m[1] ? -minor : minor;
}

const clean = (s: string) => s.replace(/[\s\u00a0\u202f]+/g, " ").trim();

/**
 * Cells into visual lines, top of the page first. Runs closer than a fifth of
 * the font size join without a space (PDF.js splits a word where the font
 * changes); farther ones join with one.
 */
export function pdfLines(pages: PdfPage[]): PdfLine[] {
  const out: PdfLine[] = [];
  pages.forEach((page, p) => {
    const cells = page.cells.filter((c) => c.text.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: PdfCell[][] = [];
    for (const c of cells) {
      const row = rows.find((r) => Math.abs(r[0].y - c.y) <= Math.max(1, Math.min(r[0].height, c.height) * 0.3));
      if (row) row.push(c);
      else rows.push([c]);
    }
    for (const r of rows) {
      r.sort((a, b) => a.x - b.x);
      const merged: PdfCell[] = [];
      for (const c of r) {
        const last = merged[merged.length - 1];
        const gap = last ? c.x - (last.x + last.width) : Infinity;
        const size = Math.max(1, Math.min(last?.height || c.height, c.height || 1));
        // Same word, or the next word of the same phrase (a space is about a quarter of the size);
        // a column gap is several times the font size.
        if (last && gap < size * 0.6) {
          const glue = gap > size * 0.15 && !last.text.endsWith(" ") && !c.text.startsWith(" ") ? " " : "";
          merged[merged.length - 1] = { ...last, text: last.text + glue + c.text, width: c.x + c.width - last.x };
        } else merged.push({ ...c });
      }
      out.push({ page: p, y: r[0].y, height: Math.max(...r.map((c) => c.height || 0)), cells: merged.map((c) => ({ ...c, text: clean(c.text) })) });
    }
  });
  return out;
}

const textOf = (lines: PdfLine[]) => lines.map((l) => l.cells.map((c) => c.text).join(" ")).join("\n");

function isHeader(l: PdfLine): boolean {
  const t = l.cells.map((c) => c.text.toUpperCase());
  return t.includes("DATE") && t.includes("DESCRIPTION") && t.some((s) => s.startsWith("AMOUNT")) && t.some((s) => s.startsWith("BALANCE"));
}

/** True when the text looks like a Wealthsimple chequing statement. */
export function looksLikeWealthsimpleChequing(lines: PdfLine[]): PdfProblem | null {
  const all = textOf(lines);
  if (all.trim().length === 0) return "no-text";
  if (!/wealthsimple/i.test(all)) return "not-wealthsimple";
  if (!/chequing/i.test(all) || !lines.some(isHeader)) return "not-chequing";
  return null;
}

/** The opening and closing balances from the summary: "SEP 1 BALANCE" over "$1,234.56". */
function summaryBalances(lines: PdfLine[], currency: Currency): { opening: number | null; closing: number | null } {
  const firstPage = lines.filter((l) => l.page === lines[0]?.page);
  const labels: PdfCell[] = [];
  for (const l of firstPage) for (const c of l.cells) if (BALANCE_LABEL.test(c.text)) labels.push(c);
  labels.sort((a, b) => a.x - b.x);
  const valueUnder = (label: PdfCell): number | null => {
    let best: { d: number; v: number } | null = null;
    for (const l of firstPage) {
      if (l.y >= label.y) continue;
      const dy = label.y - l.y;
      if (dy > label.height * 6) continue;
      for (const c of l.cells) {
        const v = parseStatementMoney(c.text, currency);
        if (v === null || Math.abs(c.x - label.x) > Math.max(label.width, 20)) continue;
        if (!best || dy < best.d) best = { d: dy, v };
      }
    }
    return best?.v ?? null;
  };
  return { opening: labels[0] ? valueUnder(labels[0]) : null, closing: labels.length > 1 ? valueUnder(labels[labels.length - 1]) : null };
}

/**
 * Reads the statement's rows and checks every running balance: the opening
 * balance plus the first amount is the first balance, each balance plus the
 * next amount is the next, and the last is the closing balance. Throws
 * PdfStatementError when the PDF is not a Wealthsimple chequing statement.
 */
export function readWealthsimpleChequing(pages: PdfPage[], currency: Currency): PdfStatementResult {
  const lines = pdfLines(pages);
  const problem = looksLikeWealthsimpleChequing(lines);
  if (problem) throw new PdfStatementError(problem);

  interface Row { date: string; posted: string; description: string[]; amount: number; balance: number; descX: number; amountX: number; last: PdfLine }
  const rows: Row[] = [];
  let open: Row | null = null;
  for (const l of lines) {
    const c = l.cells;
    if (c.length >= 4 && DATE.test(c[0].text)) {
      const twoDates = c.length >= 5 && DATE.test(c[1].text);
      const amount = parseStatementMoney(c[c.length - 2].text, currency);
      const balance = parseStatementMoney(c[c.length - 1].text, currency);
      const desc = c.slice(twoDates ? 2 : 1, c.length - 2);
      if (amount !== null && balance !== null && desc.length > 0) {
        open = {
          date: c[0].text, posted: twoDates ? c[1].text : c[0].text, description: desc.map((d) => d.text), amount, balance,
          descX: desc[0].x, amountX: c[c.length - 2].x, last: l,
        };
        rows.push(open);
        continue;
      }
    }
    // A wrapped description: on the same page, just under the row (or its last wrapped line),
    // starting at the description column and ending before the amount.
    if (open && l.page === open.last.page) {
      const size = Math.max(l.height, open.last.height, 1);
      const gap = open.last.y - l.y;
      const inColumn = c.every((x) => x.x >= open!.descX - size * 0.5 && x.x + x.width <= open!.amountX + size * 0.5);
      if (gap > 0 && gap <= size * 2.2 && inColumn) {
        open.description.push(...c.map((x) => x.text));
        open.last = l;
        continue;
      }
    }
    open = null;
  }
  if (rows.length === 0) throw new PdfStatementError("no-rows");

  const { opening, closing } = summaryBalances(lines, currency);
  const mismatches: BalanceMismatch[] = [];
  rows.forEach((r, i) => {
    const before = i === 0 ? opening : rows[i - 1].balance;
    if (before === null) return;
    const expected = before + r.amount;
    if (expected !== r.balance) mismatches.push({ index: i, expectedMinor: expected, statedMinor: r.balance });
  });
  const closingMatches = closing === null ? null : rows[rows.length - 1].balance === closing;
  const period = lines.flatMap((l) => l.cells).map((c) => c.text).find((t) => /^[A-Z][a-z]{2} \d{1,2} - [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(t)) ?? null;

  return {
    lines: rows.map((r) => ({ date: r.date, amountMinor: r.amount, description: clean(r.description.join(" ")) })),
    posted: rows.map((r) => r.posted),
    balance: {
      openingMinor: opening, closingMinor: closing, balancesMinor: rows.map((r) => r.balance), mismatches, closingMatches,
      ok: mismatches.length === 0 && closingMatches !== false,
    },
    currency: "CAD",
    period,
    statement: {
      institution: "Wealthsimple",
      type: "checking",
      last4: accountLastFour(lines),
      closingBalanceMinor: closing ?? rows[rows.length - 1].balance,
      closingDate: periodEnd(period) ?? [...rows.map((r) => r.posted)].sort().pop() ?? null,
    },
  };
}

/** "Account number: 000012345" anywhere on the statement → "2345". Only four digits leave this function. */
function accountLastFour(lines: PdfLine[]): string | null {
  const cells = lines.flatMap((l) => l.cells.map((c) => c.text));
  for (let i = 0; i < cells.length; i++) {
    const m = /account\s*(?:number|no\.?|#)\s*:?\s*([\d\s-]*)$/i.exec(cells[i]);
    if (!m) continue;
    const here = lastFour(m[1]);
    if (here) return here;
    const next = /^[\d\s-]+$/.test(cells[i + 1] ?? "") ? lastFour(cells[i + 1]) : null;
    if (next) return next;
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Sep 1 - Sep 30, 2026" → "2026-09-30"; a period across New Year ends in the year it names. */
export function periodEnd(period: string | null): string | null {
  const m = /-\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(period ?? "");
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
