// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An investment account can pay dozens of dividends a month, a cent or two
 * each (direct indexing holds hundreds of companies). The History shows them
 * as one line per account and month, "Dividends – September (73)", for their
 * total to the cent, on the day of the month's last one. The line comes from
 * the statement, so importing the statement again finds it, and a later
 * version of the statement replaces it like any other line (pipeline.ts). A
 * month with a single dividend keeps that dividend's own line.
 */
import type { StatementLine } from "./types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Dividends – September (73)". */
export function dividendsLabel(month: string, count: number): string {
  return `Dividends – ${MONTHS[Number(month.slice(5, 7)) - 1]} (${count})`;
}

/** The lines with each month's dividends (money in) as one; posted dates kept beside them. Every other line as it was, in order. */
export function groupDividends(lines: StatementLine[], posted: string[]): { lines: StatementLine[]; posted: string[] } {
  const isDividend = (l: StatementLine) => l.role === "dividend" && l.amountMinor > 0;
  const byMonth = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (!isDividend(l)) return;
    const m = l.date.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), i]);
  });
  const out: StatementLine[] = [];
  const outPosted: string[] = [];
  lines.forEach((l, i) => {
    const group = isDividend(l) ? byMonth.get(l.date.slice(0, 7))! : null;
    if (!group || group.length === 1) {
      out.push(l);
      outPosted.push(posted[i] ?? l.date);
      return;
    }
    // The group takes the place of its last dividend.
    if (i !== group[group.length - 1]) return;
    const members = group.map((j) => lines[j]);
    const date = members.map((x) => x.date).sort().at(-1)!;
    const currencies = new Set(members.map((x) => x.originalCurrency ?? null));
    const [only] = [...currencies];
    const original = currencies.size === 1 && only
      ? { originalAmountMinor: members.reduce((a, x) => a + (x.originalAmountMinor ?? 0), 0), originalCurrency: only }
      : {};
    out.push({ date, amountMinor: members.reduce((a, x) => a + x.amountMinor, 0), description: dividendsLabel(date.slice(0, 7), group.length), role: "dividend", ...original });
    outPosted.push(group.map((j) => posted[j] ?? lines[j].date).sort().at(-1)!);
  });
  return { lines: out, posted: outPosted };
}
