// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trends: one category's spending (or all of it) month by month over a range
 * of days, its average and its change against the period of the same length
 * just before. Worked out here, so the screen does no arithmetic on money.
 *
 * Spending is counted as the Overview counts it: expenses less refunds (a
 * refund nets against its own category), transfers and settlements never,
 * nothing inside an investment account, nothing in a category left out
 * (outsideTotals). A parent category takes its subcategories with it.
 *
 * Months are calendar months; the first and last are partial when the range
 * starts or ends inside them. The average is per month of the range's actual
 * length (its days over 365.25 / 12), so partial months do not drag it down,
 * counted from where the household's records start when that is inside the
 * range: a month before anything was written down is not recorded, not zero.
 * The change is only given against a previous period the records cover
 * entirely; anything less would compare with a part of it.
 */
import { counted } from "./ledger";
import { type Category, type OutsideTotals, type Transaction, nothingOutside } from "./model";
import type { LocalRow } from "./sync";

export type RangeKind = "90d" | "6m" | "1y" | "custom";
export interface Range { from: string; to: string }

const DAY = 86400000;
const toDate = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(toDate(d) + n * DAY);
/** Days from..to, both included. */
export const daysIn = (r: Range) => Math.round((toDate(r.to) - toDate(r.from)) / DAY) + 1;

function minusMonths(d: string, n: number): string {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1 - n;
  const day = +d.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m, Math.min(day, last)));
}

/** The range ending today: the last 90 days, 6 months or year, today included. Custom is taken as given, earlier date first. */
export function rangeFor(kind: RangeKind, today: string, custom?: Range): Range {
  if (kind === "90d") return { from: addDays(today, -89), to: today };
  if (kind === "6m") return { from: addDays(minusMonths(today, 6), 1), to: today };
  if (kind === "1y") return { from: addDays(minusMonths(today, 12), 1), to: today };
  const r = custom ?? { from: today, to: today };
  return r.from <= r.to ? r : { from: r.to, to: r.from };
}

/** The period of the same length just before. */
export function previousRange(r: Range): Range {
  const n = daysIn(r);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

/** Which rows a choice takes: null is all spending; a parent takes its subcategories. */
export function inChoice(categories: Category[], choice: string | null): (categoryId: string | null) => boolean {
  if (choice === null) return () => true;
  const parent = new Map(categories.map((c) => [c.id, c.parent_id]));
  return (id) => !!id && (id === choice || parent.get(id) === choice);
}

const spend = (t: Transaction) => (t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0);

export interface TrendMonth {
  month: string;
  amountMinor: number;
  /** The range covers only part of the month. */
  partial: boolean;
  /** The days of the month inside the range. */
  days: number;
  /** Anything was written down by the end of the month (in the household, any category). */
  recorded: boolean;
}

export interface Trend {
  range: Range;
  previous: Range;
  months: TrendMonth[];
  totalMinor: number;
  /** Per month of the range's length (from where the records start, if later); 0 without spending. */
  averageMinor: number;
  /** Spending rows in the range (refunds included). */
  count: number;
  previousTotalMinor: number;
  /** Whether anything was written down in the previous period at all (any row of the household, not only this category). */
  previousHasData: boolean;
  /** How much of the previous period the household's records cover: none, part (they start inside it), or all. */
  previousCoverage: "none" | "partial" | "full";
  /** total − previous total; null unless the records cover the whole previous period. */
  changeMinor: number | null;
  /** The change as a share of the previous total; null when there is nothing to compare with (not fully recorded, or a previous total of 0 or less). */
  changeRatio: number | null;
  /** The first day anything is written down in the household; null with nothing at all. */
  dataFrom: string | null;
  /** Months of the range with any spending in this choice. */
  monthsWithData: number;
}

export function trend(rows: LocalRow[], categories: Category[], choice: string | null, range: Range, outside: OutsideTotals = nothingOutside): Trend {
  const txs = counted(rows);
  const take = inChoice(categories, choice);
  const previous = previousRange(range);
  const months: TrendMonth[] = [];
  for (let m = range.from.slice(0, 7); m <= range.to.slice(0, 7);) {
    const [y, mo] = m.split("-").map(Number);
    const first = `${m}-01`;
    const last = iso(Date.UTC(y, mo, 0));
    const from = range.from > first ? range.from : first;
    const to = range.to < last ? range.to : last;
    months.push({ month: m, amountMinor: 0, partial: from !== first || to !== last, days: daysIn({ from, to }), recorded: false });
    m = iso(Date.UTC(y, mo, 1)).slice(0, 7);
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const seen = new Set<string>();
  let total = 0;
  let prevTotal = 0;
  let count = 0;
  let prevHasData = false;
  let dataFrom: string | null = null;
  for (const t of txs) {
    if (dataFrom === null || t.date < dataFrom) dataFrom = t.date;
    if (t.date >= previous.from && t.date <= previous.to) prevHasData = true;
    if (t.kind !== "expense" && t.kind !== "refund") continue;
    const s = spend(t);
    if (outside(t) || !take(t.category_id)) continue;
    if (t.date >= range.from && t.date <= range.to) {
      total += s;
      count++;
      const m = byMonth.get(t.date.slice(0, 7))!;
      m.amountMinor += s;
      seen.add(m.month);
    } else if (t.date >= previous.from && t.date <= previous.to) prevTotal += s;
  }
  for (const m of months) m.recorded = dataFrom !== null && dataFrom.slice(0, 7) <= m.month;
  const counts = dataFrom !== null && dataFrom > range.from && dataFrom <= range.to ? { from: dataFrom, to: range.to } : range;
  const perMonth = daysIn(counts) / (365.25 / 12);
  const coverage: Trend["previousCoverage"] = !prevHasData ? "none" : dataFrom! > previous.from ? "partial" : "full";
  return {
    range, previous, months, totalMinor: total,
    averageMinor: count ? Math.round(total / perMonth) : 0,
    count,
    previousTotalMinor: prevTotal,
    previousHasData: prevHasData,
    previousCoverage: coverage,
    changeMinor: coverage === "full" ? total - prevTotal : null,
    changeRatio: coverage === "full" && prevTotal > 0 ? (total - prevTotal) / prevTotal : null,
    dataFrom,
    monthsWithData: seen.size,
  };
}

/** How the change reads: "+12 %", "−3 %", "0 %"; null when there is no ratio. */
export function changePercent(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  const p = Math.round(ratio * 100);
  return p > 0 ? `+${p} %` : p < 0 ? `−${-p} %` : "0 %";
}

/** The chart's extent: the tallest bar or the average, and below zero only when refunds outweighed a month's spending. */
export function chartScale(t: Trend): { max: number; min: number } {
  const values = t.months.map((m) => m.amountMinor).concat([t.averageMinor]);
  return { max: Math.max(0, ...values), min: Math.min(0, ...values) };
}
