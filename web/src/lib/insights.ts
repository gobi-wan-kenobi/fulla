// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Insights screen's figures for one month, ported from core's
 * Analytics.report, trends, topCategories, byMember and series, with the
 * web's exclusions (outsideTotals: anything on an investment account, grants;
 * transfers and settlements are never income or spending; refunds net):
 *
 *  - the month in figures: spent (against the month before, the same days of
 *    it while this one runs), what is left or saved of the income, the daily
 *    average of everyday (flexible) spending, how many expenses, the fixed
 *    share, days without everyday spending, budgets over;
 *  - where it went (top five categories and the rest), everyday spending by
 *    weekday, the largest expenses, what was bought again and again, the
 *    categories that moved against the usual, who paid, and month by month.
 */
import { allocate } from "./balances";
import { budgetsForMonth, budgetUse } from "./budgets";
import { cleanMerchant } from "./categorize";
import { addDays, daysBetween, weekday } from "./dates";
import { monthOf, shiftMonth } from "./ledger";
import { type Config, type OutsideTotals, type Transaction, nothingOutside } from "./model";
import { periodBounds } from "./period";

export interface Place { name: string; count: number; totalMinor: number }
export interface Slice { categoryId: string | null; amountMinor: number }
export interface Trend { categoryId: string | null; currentMinor: number; averageMinor: number; change: number }
export interface MemberSpending { memberId: string; paidMinor: number; shareMinor: number }
export interface MonthSummary { month: string; incomeMinor: number; expenseMinor: number; savingsMinor: number }

export interface Report {
  month: string;
  /** The month is still running: comparisons are with the same days of earlier months. */
  running: boolean;
  /** Days of the month gone (all for a past month, 0 for a future one), and its length. */
  days: number;
  length: number;
  spentMinor: number;
  /** The month before, the same days of it while this one runs; null when nothing was recorded in it. */
  previousSpentMinor: number | null;
  incomeMinor: number;
  savingsRate: number | null;
  count: number;
  averageMinor: number;
  /** Everyday (flexible) spending per day gone. */
  dailyMinor: number;
  fixedMinor: number;
  variableMinor: number;
  biggest: Transaction[];
  /** Everyday spending by weekday, Monday first. */
  weekdays: number[];
  places: Place[];
  budgets: number;
  budgetsOver: number;
  noSpendDays: number;
  noSpendOf: number;
  top: Slice[];
  trends: Trend[];
  byMember: MemberSpending[];
  /** Up to six months with anything recorded, the latest first, ending with this one. */
  series: MonthSummary[];
}

function spend(t: Transaction): number {
  return t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0;
}

/** A row's merchant, readable: the statement text cleaned, in title case. */
export function merchantName(note: string): string {
  return cleanMerchant(note).replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function report(txs: Transaction[], config: Pick<Config, "categories" | "budgets" | "trips" | "members" | "household">, month: string, today: string, outside: OutsideTotals = nothingOutside, unit = 100, top = 5): Report {
  const counts = (t: Transaction) => t.status === "active" && (t.kind === "expense" || t.kind === "income" || t.kind === "refund") && !outside(t);
  const all = txs.filter(counts);
  const inMonth = (m: string) => all.filter((t) => monthOf(t.date) === m);
  const byId = new Map(config.categories.map((c) => [c.id, c]));
  const roll = (id: string | null) => {
    const c = id ? byId.get(id) : undefined;
    return c?.parent_id && byId.has(c.parent_id) ? c.parent_id : id;
  };
  const { from, to } = periodBounds(month);
  const length = daysBetween(from, to) + 1;
  const running = today >= from && today <= to;
  const days = today < from ? 0 : today > to ? length : daysBetween(from, today) + 1;
  const done = today < from ? 0 : today > to ? length : daysBetween(from, today);

  const rows = inMonth(month);
  const out = rows.filter((t) => t.kind !== "income");
  const expenses = out.filter((t) => t.kind === "expense");
  const spent = out.reduce((n, t) => n + spend(t), 0);
  const income = rows.filter((t) => t.kind === "income").reduce((n, t) => n + t.amount_minor, 0);
  const variable = out.filter((t) => t.recurrence !== "fixed").reduce((n, t) => n + spend(t), 0);
  const fixed = spent - variable;

  const prevMonth = shiftMonth(month, -1);
  const prev = inMonth(prevMonth).filter((t) => t.kind !== "income");
  const prevCut = running ? addDays(periodBounds(prevMonth).from, days - 1) : null;

  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (const t of out) if (t.recurrence !== "fixed") weekdays[weekday(t.date) - 1] += spend(t);

  const placeMap = new Map<string, Transaction[]>();
  for (const t of expenses) {
    const k = cleanMerchant(t.note || "");
    if (!k) continue;
    placeMap.set(k, [...(placeMap.get(k) ?? []), t]);
  }
  const places = [...placeMap.entries()].filter(([, v]) => v.length >= 2)
    .map(([k, v]) => ({ name: merchantName(k), count: v.length, totalMinor: v.reduce((n, t) => n + t.amount_minor, 0) }))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name)).slice(0, top);

  const limits = budgetsForMonth(config.budgets ?? [], month);
  const used = budgetUse(all, config.categories, limits, month, config.trips ?? [], outside);
  const budgetsOver = [...limits.entries()].filter(([k, v]) => (used.get(k) ?? 0) > v).length;

  const spentDays = new Set(out.filter((t) => t.kind === "expense" && t.recurrence !== "fixed").map((t) => t.date));
  let noSpend = 0;
  for (let i = 0; i < done; i++) if (!spentDays.has(addDays(from, i))) noSpend++;

  const totals = (m: string, cutDays: number | null) => {
    const cut = cutDays !== null ? addDays(periodBounds(m).from, cutDays - 1) : null;
    const map = new Map<string | null, number>();
    for (const t of inMonth(m)) {
      if (t.kind === "income" || (cut && t.date > cut)) continue;
      const k = roll(t.category_id);
      map.set(k, (map.get(k) ?? 0) + spend(t));
    }
    return map;
  };
  const now = totals(month, null);
  const ranked = [...now.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const topSlices: Slice[] = ranked.slice(0, top).map(([categoryId, amountMinor]) => ({ categoryId, amountMinor }));
  const rest = ranked.slice(top).reduce((n, [, v]) => n + v, 0);
  if (rest > 0) topSlices.push({ categoryId: null, amountMinor: rest });

  const usual = [1, 2, 3].map((n) => shiftMonth(month, -n)).filter((m) => inMonth(m).length > 0);
  const cutNow = running ? days : null;
  const nowCut = totals(month, cutNow);
  const before = usual.map((m) => totals(m, cutNow));
  const trends: Trend[] = usual.length === 0 ? [] : [...nowCut.entries()].filter(([, v]) => v !== 0).map(([categoryId, current]) => {
    const average = Math.round(before.reduce((n, m) => n + (m.get(categoryId) ?? 0), 0) / before.length);
    return { categoryId, currentMinor: current, averageMinor: average, change: average === 0 ? 1 : (current - average) / average };
  }).filter((t) => t.averageMinor > 0 && Math.abs(t.currentMinor - t.averageMinor) >= 10 * unit && Math.abs(t.change) >= 0.2)
    .sort((a, b) => Math.abs(b.currentMinor - b.averageMinor) - Math.abs(a.currentMinor - a.averageMinor));

  const paid = new Map<string, number>();
  const share = new Map<string, number>();
  for (const t of out) {
    const sign = t.kind === "refund" ? -1 : 1;
    if (t.paid_by_member_id) paid.set(t.paid_by_member_id, (paid.get(t.paid_by_member_id) ?? 0) + sign * t.amount_minor);
    const parts = t.split ? allocate(t.amount_minor, t.split) : t.paid_by_member_id ? { [t.paid_by_member_id]: t.amount_minor } : {};
    for (const [id, p] of Object.entries(parts)) share.set(id, (share.get(id) ?? 0) + sign * p);
  }
  const byMember = config.members.map((m) => ({ memberId: m.id, paidMinor: paid.get(m.id) ?? 0, shareMinor: share.get(m.id) ?? 0 }))
    .filter((m) => m.paidMinor !== 0 || m.shareMinor !== 0);

  const series: MonthSummary[] = [];
  for (let n = 0; n < 12 && series.length < 6; n++) {
    const m = shiftMonth(month, -n);
    const r = inMonth(m);
    if (r.length === 0) continue;
    const inc = r.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount_minor, 0);
    const exp = r.reduce((s, t) => s + spend(t), 0);
    series.push({ month: m, incomeMinor: inc, expenseMinor: exp, savingsMinor: inc - exp });
  }

  return {
    month, running, days, length, spentMinor: spent,
    previousSpentMinor: prev.length === 0 ? null : prev.filter((t) => !prevCut || t.date <= prevCut).reduce((n, t) => n + spend(t), 0),
    incomeMinor: income, savingsRate: income > 0 ? (income - spent) / income : null,
    count: expenses.length, averageMinor: expenses.length ? Math.round(expenses.reduce((n, t) => n + t.amount_minor, 0) / expenses.length) : 0,
    dailyMinor: days > 0 ? Math.round(variable / days) : 0, fixedMinor: fixed, variableMinor: variable,
    biggest: [...expenses].sort((a, b) => b.amount_minor - a.amount_minor || (a.id < b.id ? -1 : 1)).slice(0, top),
    weekdays, places, budgets: limits.size, budgetsOver, noSpendDays: noSpend, noSpendOf: done,
    top: topSlices, trends, byMember, series,
  };
}
