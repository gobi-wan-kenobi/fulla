// SPDX-License-Identifier: GPL-3.0-or-later
// Credit card and line of credit statements from Canadian banks as PDF:
// RBC, TD and Tangerine credit cards, the Triangle Mastercard (Canadian Tire
// Bank) and a Tangerine line of credit. Each row is a transaction date
// (with or without a posting date), the details and an amount; the bank's
// panels beside the rows (rewards, rates, payment information) are left out
// by where they sit on the page. A purchase in another currency has a line
// under its row with that amount and the rate; a reference number line is
// skipped. The previous and the new balance from the summary must differ by
// the rows' total to the cent. Works on text already taken out of the PDF
// (pdf.ts); nothing here names a person or an account.
import type { DebtKind } from "../defaults";
import { lastFour, type LineRole, type StatementLine } from "./types";
import { type PdfLine, type PdfStatementResult, PdfStatementError, pdfLines, type PdfPage } from "./wealthsimplePdf";
import { MONTHS, dateIn, labelled, lineText, money, monthDay } from "./statementText";

interface Layout {
  institution: string;
  is: (all: string) => boolean;
  label: string;
  type: "credit_card" | "line_of_credit";
  /** Cells right of this x belong to the panels beside the rows. */
  clipX: number;
  /** "MON DD" dates (with the year from the period) or "DD-Mon-YYYY". */
  dates: "month-day" | "day-month-year";
  /** A description over several lines: under its row, or around it (the row's line sits in their middle). */
  wrap: "below" | "around";
  previous: RegExp;
  closing: RegExp;
}

const LAYOUTS: Layout[] = [
  {
    institution: "RBC", label: "RBC Mastercard", type: "credit_card", clipX: 380, dates: "month-day", wrap: "below",
    is: (all) => /rbc royal bank/i.test(all) && /statement from .+ to /i.test(all) && /previous account balance/i.test(all),
    previous: /^previous account balance$/i, closing: /^new balance$/i,
  },
  {
    institution: "TD", label: "TD Visa", type: "credit_card", clipX: 355, dates: "month-day", wrap: "below",
    is: (all) => /td canada trust|\btd aeroplan\b|easyweb/i.test(all) && /statement period:/i.test(all) && /previous statement balance/i.test(all),
    previous: /^previous statement balance$/i, closing: /^(total )?new balance$/i,
  },
  {
    institution: "Tangerine", label: "Tangerine Mastercard", type: "credit_card", clipX: 333, dates: "day-month-year", wrap: "around",
    is: (all) => /tangerine/i.test(all) && /money-back/i.test(all) && /statement period/i.test(all) && !/line of credit/i.test(all.slice(0, 2000)),
    previous: /^previous balance$/i, closing: /^new balance$/i,
  },
  {
    institution: "Canadian Tire Bank", label: "Triangle Mastercard", type: "credit_card", clipX: 375, dates: "month-day", wrap: "below",
    is: (all) => /triangle/i.test(all) && /canadian tire/i.test(all) && /balance from your last statement/i.test(all),
    previous: /^balance from your last statement$/i, closing: /^your new balance$/i,
  },
  {
    institution: "Tangerine", label: "Tangerine Line of Credit", type: "line_of_credit", clipX: 360, dates: "day-month-year", wrap: "below",
    is: (all) => /tangerine/i.test(all) && /line of credit/i.test(all) && /opening balance/i.test(all) && /closing balance/i.test(all),
    previous: /^previous balance$/i, closing: /^new balance\*?$/i,
  },
];

/** The layout of a bank card or line of credit statement Fulla reads, or null. */
export function bankCardLayout(lines: PdfLine[]): Layout | null {
  const all = lines.map(lineText).join("\n");
  return LAYOUTS.find((l) => l.is(all)) ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const monthOf = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

/** "20-May-2030" → "2030-05-20". */
function dayMonthYear(text: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  const month = m ? monthOf(m[2]) : 0;
  return m && month ? `${m[3]}-${pad(month)}-${pad(Number(m[1]))}` : null;
}

/**
 * The period, from "STATEMENT FROM JAN 13, 2030 TO FEB 12, 2030", "Statement
 * period: March 24, 2030 to April 22, 2030", "Dec 21 to Jan 20, 2030" (the
 * first day's year worked out) or "Aug 1, 2030 to Aug 31, 2030".
 */
function period(lines: PdfLine[]): { start: string | null; end: string | null } {
  const DAY = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/;
  const RANGE = new RegExp(`${DAY.source}\\s+(?:to|TO|-|–)\\s+${DAY.source}`);
  for (const l of lines) {
    const t = lineText(l);
    if (!/statement|period/i.test(t)) continue;
    const m = RANGE.exec(t);
    if (!m || !m[6]) continue;
    const m1 = monthOf(m[1]), m2 = monthOf(m[4]);
    if (!m1 || !m2) continue;
    const endYear = Number(m[6]);
    const startYear = m[3] ? Number(m[3]) : m1 > m2 ? endYear - 1 : endYear;
    return { start: `${startYear}-${pad(m1)}-${pad(Number(m[2]))}`, end: `${endYear}-${pad(m2)}-${pad(Number(m[5]))}` };
  }
  return { start: null, end: null };
}

/** A card number as statements mask it ("5100 12** **** 0042", "4500 12XX XXXX 0077"), or a plain account number: its last four. */
function accountLastFour(lines: PdfLine[]): string | null {
  for (const l of lines) {
    const m = /\b\d{4}\s?[\dXx*•]{2}[Xx*•]{2}\s?[Xx*•]{4}\s?(\d{4})\b/.exec(lineText(l));
    if (m) return m[1];
  }
  for (const l of lines) {
    const i = l.cells.findIndex((c) => /^account number$/i.test(c.text.trim()));
    if (i >= 0 && l.cells[i + 1] && /^\d{6,}$/.test(l.cells[i + 1].text.trim())) return lastFour(l.cells[i + 1].text);
  }
  return null;
}

/** "Foreign Currency - USD 1,000.00 Exchange rate - 1.405000" or "64.00 USD @ 1.406250" → 100000 USD. */
function foreign(text: string): { amountMinor: number; currency: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  let m = /^foreign currency\s*-\s*([A-Z]{3})\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\s+exchange rate/i.exec(t);
  if (m) return { currency: m[1].toUpperCase(), amountMinor: Number(m[2].replace(/,/g, "")) * 100 + Number(m[3]) };
  m = /^(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\s+([A-Z]{3})\s*@\s*\d+(?:\.\d+)?$/.exec(t);
  if (m) return { currency: m[3], amountMinor: Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]) };
  return null;
}

const PAYMENT = /\b(payment|paiement|pmt|telepayments?|royal bank of canada|bank of canada)\b/i;
const INTEREST = /\binterest\b|\bint[ée]r[êe]ts?\b/i;
const FEE = /\b(annual|membership|late|overlimit|over-limit|foreign transaction|cash advance|returned payment|nsf)\b.*\bfee\b|^fees?\b/i;
const NOT_A_ROW = /^(total|sub-?total|previous|new balance|opening balance|closing balance|transaction|date|description|amount|page \d)/i;

interface Row { date: string; posted: string; parts: { y: number; text: string }[]; amount: number; fx: { amountMinor: number; currency: string } | null; page: number; y: number; descX: number; amountX: number }

/** Reads the statement. Throws PdfStatementError("not-supported") when it is none of these layouts. */
export function readBankCardStatement(pages: PdfPage[]): PdfStatementResult {
  const lines = pdfLines(pages);
  const layout = bankCardLayout(lines);
  if (!layout) throw new PdfStatementError("not-supported");
  const { start, end } = period(lines);
  if (!end) throw new PdfStatementError("not-supported");

  const rows: Row[] = [];
  const loose: { page: number; y: number; x: number; text: string }[] = [];
  let open: Row | null = null;
  let itemised = false;
  for (const l of lines) {
    // A store's own list of what a purchase was made of (Triangle's "Details of your … store purchases") repeats rows already counted.
    if (/^details of your .+ store purchases$/i.test(lineText(l).trim())) itemised = true;
    if (itemised) continue;
    const cells = l.cells.filter((c) => c.x < layout.clipX).map((c) => ({ ...c, text: c.text.trim() }));
    if (cells.length === 0) continue;
    // The dates, as their own cells or run into the next one ("JAN 25 PAYMENT - THANK YOU").
    let date: string | null = null;
    let posted: string | null = null;
    let rest = cells;
    if (layout.dates === "month-day") {
      const md = monthDay(cells[0].text);
      if (md && cells[0].x < 80) {
        date = dateIn(md, end);
        rest = cells.slice(1);
        const second = rest[0] ? /^([A-Za-z]{3}\s+\d{1,2})(?:\s+(.*))?$/.exec(rest[0].text) : null;
        const md2 = second ? monthDay(second[1]) : null;
        if (second && md2) {
          posted = dateIn(md2, end);
          rest = second[2] ? [{ ...rest[0], text: second[2] }, ...rest.slice(1)] : rest.slice(1);
        }
      }
    } else {
      // "20-May-2030", or both dates and the description run into one cell.
      const lead = /^(\d{1,2}-[A-Za-z]{3}-\d{4})(?:\s+(\d{1,2}-[A-Za-z]{3}-\d{4}))?(?:\s+(.*))?$/.exec(cells[0].text);
      const d = lead ? dayMonthYear(lead[1]) : null;
      if (lead && d && cells[0].x < 80) {
        date = d;
        rest = lead[3] ? [{ ...cells[0], text: lead[3] }, ...cells.slice(1)] : cells.slice(1);
        const d2 = lead[2] ? dayMonthYear(lead[2]) : rest[0] ? dayMonthYear(rest[0].text) : null;
        if (d2) { posted = d2; if (!lead[2]) rest = rest.slice(1); }
      }
    }
    const last = rest[rest.length - 1];
    const amount = last ? money(last.text) : null;
    if (date && amount !== null) {
      const desc = rest.slice(0, -1).filter((c) => !/^[–-]$/.test(c.text));
      open = {
        date, posted: posted ?? date, parts: desc.length ? [{ y: l.y, text: desc.map((c) => c.text).join(" ") }] : [], amount, fx: null,
        page: l.page, y: l.y, descX: desc[0]?.x ?? last.x - 200, amountX: last.x,
      };
      rows.push(open);
      continue;
    }
    const text = cells.map((c) => c.text).join(" ");
    // Under a row: the amount in another currency, a reference number, more of the description.
    const fx = foreign(text);
    if (open && fx && l.page === open.page && open.y - l.y <= 30) { open.fx = fx; continue; }
    if (/^\d{10,}$/.test(text.replace(/\s/g, "")) || /^-\s*\d{6,}$/.test(text)) continue;
    if (cells.some((c) => money(c.text) !== null) || NOT_A_ROW.test(text)) { open = null; continue; }
    if (layout.wrap === "around") { loose.push({ page: l.page, y: l.y, x: cells[0].x, text }); continue; }
    if (open && l.page === open.page && cells[0].x >= open.descX - 4 && cells[0].x < open.amountX && open.y - l.y <= Math.max(l.height, 8) * 1.8) {
      open.parts.push({ y: l.y, text });
      open.y = l.y;
      continue;
    }
    open = null;
  }
  // A description around its row: each piece goes to the nearest row on its page.
  if (layout.wrap === "around") {
    for (const p of loose) {
      let best: Row | null = null;
      for (const r of rows) if (r.page === p.page && p.x >= r.descX - 4 && p.x < r.amountX && Math.abs(r.y - p.y) <= 16 && (!best || Math.abs(r.y - p.y) < Math.abs(best.y - p.y))) best = r;
      if (best) best.parts.push({ y: p.y, text: p.text });
    }
  }

  const previous = labelled(lines, layout.previous);
  const closing = labelled(lines, layout.closing);
  if (previous === null || closing === null) throw new PdfStatementError("not-supported");

  const debt = layout.type === "line_of_credit";
  const kind: DebtKind | undefined = debt ? "line_of_credit" : undefined;
  // A line of credit prints every amount without a sign: a payment lowers what is owed, an advance and interest raise it.
  const owedChange = (r: Row, description: string) => {
    if (!debt) return r.amount;
    if (/^(opening|closing) balance$/i.test(description)) return 0;
    return /\b(payment|credit|reversal)\b/i.test(description) ? -Math.abs(r.amount) : Math.abs(r.amount);
  };
  const described = rows.map((r) => ({ r, description: [...r.parts].sort((a, b) => b.y - a.y).map((p) => p.text).join(" ").replace(/\s+/g, " ").replace(/\s+-$/, "").trim() }))
    .filter(({ r, description }) => owedChange(r, description) !== 0);
  const total = described.reduce((s, { r, description }) => s + owedChange(r, description), 0);
  const reconciles = previous + total === closing;

  const roleOf = (owed: number, description: string): LineRole | null => {
    if (debt) {
      if (INTEREST.test(description) && owed > 0) return "card-interest";
      return "transfer";
    }
    if (owed < 0) return PAYMENT.test(description) ? "card-payment" : "credit";
    if (INTEREST.test(description) && !/\binterest rate change\b/i.test(description)) return "card-interest";
    if (FEE.test(description)) return "fee";
    return null;
  };
  /** Where a line of credit's money came from or went: "Payment from Example Chequing Account - 1234" → "Example Chequing". */
  const counterpartOf = (description: string): string | null => {
    const m = /\b(?:from|to)\s+(.+?)\s+account\b/i.exec(description);
    return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 40) : null;
  };

  const out: StatementLine[] = described.map(({ r, description }) => {
    const owed = owedChange(r, description);
    const role = roleOf(owed, description);
    const counterpart = debt && role === "transfer" ? counterpartOf(description) : null;
    return {
      date: r.date, amountMinor: -owed, description: description || (role === "card-interest" ? "Interest" : "Transaction"), role,
      ...(kind && role === "card-interest" ? { debtKind: kind } : {}),
      ...(counterpart ? { counterpart } : {}),
      ...(r.fx ? { originalAmountMinor: r.fx.amountMinor, originalCurrency: r.fx.currency } : {}),
    };
  });
  if (out.length === 0 && previous !== closing) throw new PdfStatementError("no-rows");
  return {
    lines: out,
    posted: described.map(({ r }) => r.posted),
    balance: { openingMinor: previous, closingMinor: closing, balancesMinor: [], mismatches: [], closingMatches: reconciles, ok: reconciles },
    currency: "CAD",
    period: start ? `${start} to ${end}` : end,
    kind: "card",
    format: `${layout.label} statement`,
    ignored: 0,
    statement: {
      institution: layout.institution, type: layout.type, last4: accountLastFour(lines),
      closingBalanceMinor: -closing, closingDate: end, label: layout.label, periodStart: start, version: 1,
    },
  };
}
