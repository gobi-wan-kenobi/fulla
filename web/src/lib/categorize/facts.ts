// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Facts about a statement line computed in code, for the categorizer: which
 * way the money went (from the real sign), roughly how much, which day of the
 * month, and how often the household has seen this payee. TypeSafe's guidance
 * is to keep arithmetic and dates in code and hand the model the result.
 */
import { words } from "../categorize";

export type Direction = "out" | "in";

export function amountBand(amountMinor: number, minorUnits = 2): string {
  const a = Math.abs(amountMinor) / 10 ** minorUnits;
  for (const [lim, label] of [[10, "under $10"], [30, "$10 to $30"], [100, "$30 to $100"], [300, "$100 to $300"], [1000, "$300 to $1,000"]] as const) {
    if (a < lim) return label;
  }
  return "over $1,000";
}

/** True for a round amount of $20 or more in tens: typical of transfers and payments. */
export function isRound(amountMinor: number, minorUnits = 2): boolean {
  const a = Math.abs(amountMinor) / 10 ** minorUnits;
  return a >= 20 && a % 10 === 0;
}

export function dayOfMonth(date: string): string | null {
  const d = Number(/^\d{4}-\d{2}-(\d{2})/.exec(date)?.[1]);
  if (!d) return null;
  const part = d <= 7 ? "start of month (1st-7th)" : d >= 25 ? "end of month (25th-31st)" : "middle of month";
  return `${d} (${part})`;
}

const GENERIC = new Set(["purchase", "visa", "debit", "interac", "pos", "at", "the", "bank", "online", "bill", "payment", "for", "eft",
  "internet", "pre", "authorized", "preauth", "to", "from"]);

/** The payee as two words, for counting how often the household sees it. */
export function payeeKey(description: string): string {
  const toks = words(description).split(" ").filter((t) => /^[a-z][a-z'&.]+$/.test(t) && !GENERIC.has(t));
  return toks.slice(0, 2).join(" ") || words(description);
}

export interface Seen { date: string; amountMinor: number }

/** Every payee's dates and amounts, from the household's rows and the lines being imported. */
export function history(lines: { description: string; date: string; amountMinor: number }[]): Map<string, Seen[]> {
  const out = new Map<string, Seen[]>();
  for (const l of lines) {
    const k = payeeKey(l.description);
    const list = out.get(k) ?? [];
    list.push({ date: l.date, amountMinor: Math.abs(l.amountMinor) });
    out.set(k, list);
  }
  return out;
}

/** How often a payee turns up: first time, rarely, about once a month (same or varying amount), frequent. */
export function howOftenSeen(description: string, seen: Map<string, Seen[]>): string {
  const h = seen.get(payeeKey(description)) ?? [];
  const months = [...new Set(h.map((s) => s.date.slice(0, 7)))].sort();
  if (months.length < 3) return h.length > 1 ? "rarely seen (fewer than 3 months)" : "first time seen";
  const [y0, m0] = months[0].split("-").map(Number);
  const [y1, m1] = months[months.length - 1].split("-").map(Number);
  const span = (y1 - y0) * 12 + (m1 - m0) + 1;
  const perMonth = h.length / months.length;
  const am = h.map((s) => s.amountMinor);
  const mu = am.reduce((a, b) => a + b, 0) / am.length;
  const cv = mu ? Math.sqrt(am.reduce((a, x) => a + (x - mu) ** 2, 0) / am.length) / mu : 9;
  if (months.length / span >= 0.6 && perMonth <= 1.6) {
    return "about once a month, " + (cv < 0.1 ? "same amount each time" : cv < 0.3 ? "similar amount" : "amount varies");
  }
  if (perMonth > 1.6) return "frequent (several times a month)";
  return "seen in several months, not regular";
}
