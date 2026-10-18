// SPDX-License-Identifier: GPL-3.0-or-later
// Wealthsimple self-directed investment statements (TFSA, RRSP, FHSA, RESP,
// non-registered, crypto) as PDF. What Fulla takes from one:
//  - the cash that came in or left: contributions, deposits, withdrawals and
//    transfers (transfers between the household's accounts), dividends and
//    interest (income), fees and taxes withheld (spending);
//  - the total market value at the end, as the account's balance (net worth).
// Trades and other moves inside the account (buying, selling, shares lent,
// crypto rewards paid in coins) are not money in or out: they are counted
// and left out. The cash summary is checked against every activity row's
// running balance, per currency, to the cent. An amended statement says its
// version, so a later version of the same account and period replaces the
// one before. Works on text already taken out of the PDF (pdf.ts).
import type { LineRole, StatementLine } from "./types";
import { type PdfCell, type PdfLine, type PdfStatementResult, PdfStatementError, pdfLines, type PdfPage, type BalanceMismatch } from "./wealthsimplePdf";
import { groupDividends } from "./dividends";
import { lineText, money } from "./statementText";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/;
const KINDS: [RegExp, string][] = [
  [/\bTFSA\b/, "TFSA"], [/\bFHSA\b/, "FHSA"], [/\bRRSP\b/, "RRSP"], [/\bRRIF\b/, "RRIF"], [/\bRESP\b/, "RESP"], [/\bLIRA\b/, "LIRA"],
  [/\bcrypto account\b/i, "Crypto"], [/\b(non-registered|personal|joint|individual) account\b/i, "Non-registered"],
  [/\bnon-registered\b/i, "Non-registered"], // "Order Execution Only Non-Registered Cash Account"
];

/** What each activity code is, by the codes the statement's legend uses; anything else stays inside the account. */
export const INVESTMENT_CODES: Record<string, { role: LineRole; sign: 1 | -1 }> = {
  CONT: { role: "transfer", sign: 1 }, DEP: { role: "transfer", sign: 1 }, TRFIN: { role: "transfer", sign: 1 }, TRFINTF: { role: "transfer", sign: 1 },
  EFT: { role: "transfer", sign: 1 }, WD: { role: "transfer", sign: -1 }, WDQ: { role: "transfer", sign: -1 }, TRFOUT: { role: "transfer", sign: -1 },
  TRFOUTTF: { role: "transfer", sign: -1 }, DIV: { role: "dividend", sign: 1 }, DIST: { role: "dividend", sign: 1 }, INT: { role: "interest", sign: 1 },
  FPLINT: { role: "interest", sign: 1 }, FEE: { role: "fee", sign: -1 }, NRT: { role: "fee", sign: -1 }, WHT: { role: "fee", sign: -1 },
  HST: { role: "fee", sign: -1 }, GST: { role: "fee", sign: -1 }, PST: { role: "fee", sign: -1 },
  // A fee given back ("MANAGEMENT_FEE_REIMBURSEMENT"): less spent on fees.
  REIMB: { role: "fee", sign: 1 },
  // A government grant paid into an RESP (CESG and the like): the account's, not a transfer and not the household's income.
  GRANT: { role: "grant", sign: 1 },
};

/** True when the text is a Wealthsimple investment account statement. */
export function looksLikeWealthsimpleInvestment(lines: PdfLine[]): boolean {
  const all = lines.map(lineText).join("\n");
  return /wealthsimple/i.test(all) && /total portfolio/i.test(all) && /portfolio cash/i.test(all) && /account no\.?/i.test(all) &&
    lines.some((l) => l.cells.some((c) => PERIOD.test(c.text)));
}

/** "HQ0X0EXAMPLE1CAD" → "PLE1": the last four letters and digits of the number, without the currency it ends with. */
export function accountTail(id: string): string | null {
  const s = id.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/(CAD|USD)$/, "");
  return s.length >= 4 ? s.slice(-4) : null;
}

function accountNumber(lines: PdfLine[]): string | null {
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i].cells.find((c) => /^account no\.?$/i.test(c.text));
    if (!head) continue;
    const under = lines[i + 1].cells.filter((c) => /^[A-Z0-9]{6,20}$/.test(c.text));
    under.sort((a, b) => Math.abs(a.x - head.x) - Math.abs(b.x - head.x));
    if (under[0]) return under[0].text;
  }
  return null;
}

/** The CAD and USD columns of the cash summary, by their headings' right edges. */
function cashColumns(lines: PdfLine[]): { cad: PdfCell; usd: PdfCell | null } | null {
  for (const l of lines) {
    const cad = l.cells.find((c) => /^CAD Transactions/i.test(c.text));
    if (cad) return { cad, usd: l.cells.find((c) => /^USD Transactions/i.test(c.text)) ?? null };
  }
  return null;
}

function inColumn(l: PdfLine | undefined, col: PdfCell | null): number | null {
  if (!l || !col) return null;
  const right = col.x + col.width;
  let best: { d: number; v: number } | null = null;
  for (const c of l.cells) {
    const v = money(c.text);
    if (v === null) continue;
    const d = Math.abs(c.x + c.width - right);
    if (d <= Math.max(col.width, 40) && (!best || d < best.d)) best = { d, v };
  }
  return best?.v ?? null;
}

const clean = (s: string) =>
  s.replace(/\s\$[A-Z]{3}\b/g, " ").replace(/\s*\(executed at[^)]*\)?/gi, "").replace(/,?\s*received on \d{4}-\d{2}-\d{2}.*$/i, "").replace(/,?\s*record date.*$/i, "")
    .replace(/\s+/g, " ").replace(/[\s,]+$/, "").trim();

/**
 * Reads a Wealthsimple investment statement. Throws PdfStatementError
 * ("not-supported") when it is not one.
 */
export function readWealthsimpleInvestment(pages: PdfPage[]): PdfStatementResult {
  const lines = pdfLines(pages);
  if (!looksLikeWealthsimpleInvestment(lines)) throw new PdfStatementError("not-supported");
  const all = lines.map(lineText).join("\n");
  const periodCell = lines.flatMap((l) => l.cells).find((c) => PERIOD.test(c.text));
  const [, start, end] = PERIOD.exec(periodCell!.text)!;
  // The heading names the account ("... TFSA Account", "Crypto Account"); the legal text names other kinds too.
  const heading = lines.slice(0, 60).map(lineText).find((t) => /^(?:order execution only\s+)?[\w-]+(?:\s[\w-]+)?\s+account$/i.test(t.trim()) && !/^order execution only account$/i.test(t.trim())) ?? "";
  const kind = KINDS.find(([re]) => re.test(heading))?.[1] ?? (/this is a non-registered account/i.test(all) ? "Non-registered" : "Investment");
  const version = Number(/amended\s*-\s*version:?\s*(\d+)/i.exec(all)?.[1] ?? 1);
  const rate = Number(/\$\s*1\s*USD\s*=\s*\$\s*([\d.]+)\s*CAD/i.exec(all)?.[1] ?? NaN);
  const marketValue = (() => {
    for (const l of lines) {
      const i = l.cells.findIndex((c) => /^total portfolio$/i.test(c.text));
      if (i >= 0) for (const c of l.cells.slice(i + 1)) { const v = money(c.text); if (v !== null) return v; }
    }
    return null;
  })();

  // The cash summary, per currency.
  const cols = cashColumns(lines);
  const summaryLine = (re: RegExp) => lines.find((l) => re.test(l.cells[0]?.text ?? ""));
  // A statement in one currency has no CAD and USD columns: the summary's amount is the first one after its label.
  const single = cols ? null : (/all figures in \$(CAD|USD)/i.exec(all)?.[1]?.toUpperCase() ?? "CAD") as "CAD" | "USD";
  const firstMoney = (l: PdfLine | undefined) => {
    for (const c of l?.cells.slice(1) ?? []) { const v = money(c.text); if (v !== null) return v; }
    return null;
  };
  const summary = (cur: "CAD" | "USD") => {
    const col = cur === "CAD" ? cols?.cad ?? null : cols?.usd ?? null;
    const at = (re: RegExp) => (cols ? inColumn(summaryLine(re), col) : cur === single ? firstMoney(summaryLine(re)) : null);
    return {
      last: at(/^last statement cash balance$/i), paidIn: at(/^total cash paid in$/i),
      paidOut: at(/^total cash paid out$/i), closing: at(/^closing cash balance$/i),
    };
  };

  // Activity rows: date, code, description, then debit, credit and balance (money) when the row moved cash.
  interface Row { date: string; code: string; description: string[]; debit: number | null; credit: number | null; balance: number | null; cur: "CAD" | "USD"; descX: number; last: PdfLine }
  const rows: Row[] = [];
  let cur: "CAD" | "USD" | null = null;
  let open: Row | null = null;
  for (const l of lines) {
    const t = lineText(l);
    const head = /^(CAD|USD) Activity\b/i.exec(t);
    if (head) { cur = head[1].toUpperCase() as "CAD" | "USD"; open = null; continue; }
    // One currency: "Activity - Current period", on every page the activity runs over.
    if (single && /^activity\s*-\s*current period$/i.test(t.trim())) { cur = single; open = null; continue; }
    if (!cur) continue;
    // The date and the code, as two cells or run together into one.
    const joined = /^(\d{4}-\d{2}-\d{2})\s+([A-Z]{2,12})$/.exec(l.cells[0]?.text ?? "");
    const c = joined ? [{ ...l.cells[0], text: joined[1] }, { ...l.cells[0], text: joined[2] }, ...l.cells.slice(1)] : l.cells;
    if (c.length >= 3 && ISO.test(c[0].text) && /^[A-Z]{2,12}$/.test(c[1].text)) {
      const tail = c.slice(-3).map((x) => money(x.text));
      const moved = tail.every((v) => v !== null);
      const desc = c.slice(2, moved ? c.length - 3 : c.length).map((x) => x.text);
      open = { date: c[0].text, code: c[1].text, description: desc, debit: moved ? tail[0] : null, credit: moved ? tail[1] : null, balance: moved ? tail[2] : null, cur, descX: c[2].x, last: l };
      rows.push(open);
      continue;
    }
    if (open && l.page === open.last.page && open.last.y - l.y <= Math.max(l.height, 1) * 2.6 && c.every((x) => x.x >= open!.descX - 4 && money(x.text) === null)) {
      open.description.push(...c.map((x) => x.text));
      open.last = l;
      continue;
    }
    open = null;
  }

  // Every row's running balance, per currency, from the last statement's cash to this one's.
  const mismatches: BalanceMismatch[] = [];
  let ok = true;
  for (const c of ["CAD", "USD"] as const) {
    const s = summary(c);
    const moved = rows.filter((r) => r.cur === c && r.balance !== null);
    if (s.last === null || s.closing === null) { if (moved.length > 0) ok = false; continue; }
    let bal = s.last;
    for (const r of moved) {
      const expected = bal - (r.debit ?? 0) + (r.credit ?? 0);
      if (expected !== r.balance) mismatches.push({ index: rows.indexOf(r), expectedMinor: expected, statedMinor: r.balance! });
      bal = r.balance!;
    }
    if (bal !== s.closing) ok = false;
    if (s.paidIn !== null && s.paidOut !== null && s.last + s.paidIn - s.paidOut !== s.closing) ok = false;
  }

  const out: StatementLine[] = [];
  const posted: string[] = [];
  let ignored = 0;
  for (const r of rows) {
    const what = INVESTMENT_CODES[r.code];
    const amount = r.balance === null ? 0 : (r.credit ?? 0) - (r.debit ?? 0);
    if (!what || amount === 0) { ignored++; continue; }
    const usd = r.cur === "USD";
    if (usd && !Number.isFinite(rate)) { ignored++; continue; }
    const cad = usd ? Math.round(amount * rate) : amount;
    out.push({
      date: r.date, amountMinor: cad, description: clean(r.description.join(" ")) || r.code, role: what.role,
      ...(usd ? { originalAmountMinor: Math.abs(amount), originalCurrency: "USD" } : {}),
    });
    posted.push(r.date);
  }
  const grouped = groupDividends(out, posted);
  const tail = accountNumber(lines);
  const label = `Wealthsimple ${kind}`;
  return {
    lines: grouped.lines, posted: grouped.posted,
    balance: {
      openingMinor: summary("CAD").last, closingMinor: summary("CAD").closing, balancesMinor: [], mismatches,
      closingMatches: ok, ok: ok && mismatches.length === 0,
    },
    currency: "CAD",
    period: `${start} to ${end}`,
    kind: "investment",
    format: `${label} statement${version > 1 ? ` (amended, version ${version})` : ""}`,
    ignored,
    statement: {
      institution: "Wealthsimple", type: "investment", last4: tail ? accountTail(tail) : null,
      closingBalanceMinor: marketValue, closingDate: end, label, periodStart: start, version,
    },
  };
}
