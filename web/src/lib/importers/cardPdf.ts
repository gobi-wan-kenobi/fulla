// SPDX-License-Identifier: GPL-3.0-or-later
// Credit card statements as PDF (American Express Canada and Capital One
// Canada layouts). Each row is a transaction date, a posting date, the
// details and an amount, in sections (payments, new transactions, other
// charges such as interest and fees); a purchase in another currency has a
// line under it with that amount and the rate. The summary on the first page
// gives the previous and the new balance, and the rows must add up to the
// difference to the cent. Works on text already taken out of the PDF (pdf.ts).
import { lastFour, type LineRole, type StatementLine } from "./types";
import { type PdfLine, type PdfStatementResult, PdfStatementError, pdfLines, type PdfPage } from "./wealthsimplePdf";
import { dateIn, foreignAmount, fullDate, labelled, lineText, money, monthDay } from "./statementText";

interface Issuer {
  institution: string;
  /** True when the text is this issuer's card statement. */
  is: (all: string) => boolean;
  /** The product, for the new account's name. */
  label: (lines: PdfLine[]) => string;
}

const ISSUERS: Issuer[] = [
  {
    institution: "American Express",
    is: (all) => /american express|amex bank of canada/i.test(all) && /statement of account/i.test(all) && /new balance/i.test(all),
    label: (lines) => {
      const product = lines.slice(0, 40).map(lineText).find((t) => /american express/i.test(t) && /\bcard\b/i.test(t)) ?? "";
      const name = product.replace(/[®*™]/g, "").replace(/american express/i, " ").replace(/\bcard\b.*$/i, " ").replace(/\s+/g, " ").trim();
      return `American Express${name ? ` ${name}` : ""}`.slice(0, 33);
    },
  },
  {
    institution: "Capital One",
    is: (all) => /capital one/i.test(all) && /statement period/i.test(all) && /new balance/i.test(all),
    label: (lines) => (lines.some((l) => /capital one\s*visa/i.test(lineText(l))) ? "Capital One Visa" : "Capital One Mastercard"),
  },
];

const PAYMENT = /\b(payment|paiement)\b/i;
const INTEREST = /\binterest\b|\bint[ée]r[êe]ts?\b/i;
const FEE = /\bfees?\b|\bfrais\b/i;
const NAMED_FEE = /^(annual|membership|monthly|late|overlimit|over-limit|foreign transaction|cash advance|returned payment|nsf)\b.*\bfee/i;

/** The issuer's card statement, or null when the text is none of the layouts Fulla reads. */
export function cardIssuer(lines: PdfLine[]): Issuer | null {
  const all = lines.map(lineText).join("\n");
  return ISSUERS.find((i) => i.is(all)) ?? null;
}

/** The statement's first and last day: "Statement Period: Aug 21, 2026 - Sep 20, 2026", or an opening and a closing date side by side. */
function period(lines: PdfLine[]): { start: string | null; end: string | null } {
  for (const l of lines) {
    const m = /(\w{3}\w*\.? \d{1,2}, \d{4})\s*[-–]\s*(\w{3}\w*\.? \d{1,2}, \d{4})/.exec(lineText(l));
    if (m && fullDate(m[1]) && fullDate(m[2])) return { start: fullDate(m[1]), end: fullDate(m[2]) };
  }
  for (const l of lines) {
    const dates = l.cells.map((c) => fullDate(c.text)).filter((d): d is string => !!d);
    if (dates.length >= 2 && dates[0] < dates[1]) return { start: dates[0], end: dates[1] };
  }
  return { start: null, end: null };
}

/** The card number's last four digits: "XXXX XXXXX0 12345" → "2345", "ending in 0042" → "0042". */
function cardLastFour(lines: PdfLine[]): string | null {
  for (const l of lines) {
    const m = /ending in\s*(\d{4})\b/i.exec(lineText(l));
    if (m) return m[1];
  }
  for (const l of lines) for (const c of l.cells) if (/^[X•*]{4}[X•*\d\s-]*\d{4,}$/i.test(c.text.trim())) return lastFour(c.text);
  return null;
}

type Section = "payments" | "purchases" | "other" | null;
function sectionOf(text: string, current: Section): Section {
  const t = text.toLowerCase();
  if (/(^|\s|:)(new )?payments?\b|payments, credits/.test(t)) return "payments";
  if (/other account transactions|other charges|^fees\b|interest charged?$/.test(t)) return "other";
  if (/new transactions|(^|:\s*)transactions$|purchases and adjustments/.test(t)) return "purchases";
  return current;
}

/**
 * Reads a credit card statement. Amounts become money in and out of the card:
 * a purchase is money out (negative), a payment or a credit is money in. The
 * new balance is kept as what the card is owed, negative. Throws
 * PdfStatementError("not-supported") when the text is not a layout Fulla reads.
 */
export function readCardStatement(pages: PdfPage[]): PdfStatementResult {
  const lines = pdfLines(pages);
  const issuer = cardIssuer(lines);
  if (!issuer) throw new PdfStatementError("not-supported");
  const { start, end } = period(lines);
  if (!end) throw new PdfStatementError("not-supported");

  interface Row { date: string; posted: string; description: string; amount: number; section: Section; fx: { amountMinor: number; currency: string } | null; last: PdfLine; descX: number }
  const rows: Row[] = [];
  let section: Section = null;
  let open: Row | null = null;
  for (const l of lines) {
    const c = l.cells;
    const first = c[0] ? monthDay(c[0].text) : null;
    const second = c[1] ? monthDay(c[1].text) : null;
    const amount = c.length >= 3 ? money(c[c.length - 1].text) : null;
    if (first && amount !== null) {
      const descCells = c.slice(second ? 2 : 1, c.length - 1);
      if (descCells.length > 0) {
        open = {
          date: dateIn(first, end), posted: dateIn(second ?? first, end), description: descCells.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim(),
          amount, section, fx: null, last: l, descX: descCells[0].x,
        };
        rows.push(open);
        continue;
      }
    }
    const text = lineText(l);
    // The amount in another currency, just under its row.
    if (open && l.page === open.last.page && open.last.y - l.y <= Math.max(l.height, open.last.height, 1) * 2.5 && l.cells[0].x >= open.descX - 4) {
      const fx = foreignAmount(text);
      if (fx) {
        open.fx = fx;
        open.last = l;
        continue;
      }
      if (/^reference\b/i.test(text)) {
        open.last = l;
        continue;
      }
    }
    open = null;
    if (!/^total\b/i.test(text) && !l.cells.some((x) => money(x.text) !== null)) section = sectionOf(text, section);
  }

  const previous = labelled(lines, /^previous (statement )?balance$/i);
  const closing = labelled(lines, /^(equals )?new balance$/i);
  if (previous === null || closing === null) throw new PdfStatementError("not-supported");
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const reconciles = previous + total === closing;

  const roleOf = (r: Row): LineRole | null => {
    if (r.amount < 0) return PAYMENT.test(r.description) || (r.section === "payments" && !/refund|credit|return/i.test(r.description)) ? "card-payment" : "credit";
    if (r.section !== "purchases" && INTEREST.test(r.description)) return "card-interest";
    if ((r.section === "other" && FEE.test(r.description)) || NAMED_FEE.test(r.description)) return "fee";
    return null;
  };

  const out: StatementLine[] = rows.map((r) => ({
    date: r.date, amountMinor: -r.amount, description: r.description, role: roleOf(r),
    ...(r.fx ? { originalAmountMinor: r.fx.amountMinor, originalCurrency: r.fx.currency } : {}),
  }));
  if (out.length === 0 && previous === closing) throw new PdfStatementError("no-rows");
  return {
    lines: out,
    posted: rows.map((r) => r.posted),
    balance: {
      openingMinor: previous, closingMinor: closing, balancesMinor: [], mismatches: [], closingMatches: reconciles, ok: reconciles,
    },
    currency: "CAD",
    period: start ? `${start} to ${end}` : end,
    kind: "card",
    format: `${issuer.label(lines)} statement`,
    ignored: 0,
    statement: {
      institution: issuer.institution, type: "credit_card", last4: cardLastFour(lines),
      closingBalanceMinor: -closing, closingDate: end, label: issuer.label(lines), periodStart: start, version: 1,
    },
  };
}
