// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The budgets of a month, as the Android app keeps them (core's Budgets and
 * Analytics.budgetSpend), from the shared fulla.budgets table: one limit per
 * category, for every month (period null) or for one month (YYYY-MM), the
 * month's own winning over the default.
 *
 * What a budget used is the category's spending (expenses less refunds), its
 * subcategories included, by the Overview's rules: transfers, and anything
 * inside an investment account, are not spending. Rows on a trip that keeps
 * its own budget (in_category_budgets false) are left out, as in the app.
 */
import { monthOf } from "./ledger";
import { type Budget, type Category, type OutsideTotals, type Transaction, type Trip, nothingOutside } from "./model";

/** The budget of each category for the month; zero limits are no budget. */
export function budgetsForMonth(budgets: Budget[], month: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of budgets) if (b.period == null) out.set(b.category_id, b.amount_minor);
  for (const b of budgets) if (b.period === month) out.set(b.category_id, b.amount_minor);
  for (const [k, v] of out) if (!(v > 0)) out.delete(k);
  return out;
}

export interface BudgetStatus {
  limitMinor: number;
  usedMinor: number;
  /** Never negative; one of left and over is always 0. */
  leftMinor: number;
  overMinor: number;
  /** used over limit, 0.. (above 1 when over). */
  fraction: number;
}

export function budgetStatus(limitMinor: number, usedMinor: number): BudgetStatus {
  return {
    limitMinor, usedMinor,
    leftMinor: Math.max(limitMinor - usedMinor, 0),
    overMinor: Math.max(usedMinor - limitMinor, 0),
    fraction: limitMinor > 0 ? usedMinor / limitMinor : 0,
  };
}

/** What each budgeted category used in the month, its subcategories included. */
export function budgetUse(txs: Transaction[], categories: Category[], limits: Map<string, number>, month: string, trips: Trip[] = [], outside: OutsideTotals = nothingOutside): Map<string, number> {
  const parent = new Map(categories.map((c) => [c.id, c.parent_id]));
  const ownBudget = new Set(trips.filter((t) => !t.in_category_budgets).map((t) => t.id));
  const used = new Map([...limits.keys()].map((k) => [k, 0]));
  for (const t of txs) {
    if (monthOf(t.date) !== month || outside(t)) continue;
    if (t.trip_id && ownBudget.has(t.trip_id)) continue;
    const s = t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0;
    if (!s || !t.category_id) continue;
    if (used.has(t.category_id)) used.set(t.category_id, used.get(t.category_id)! + s);
    const p = parent.get(t.category_id);
    if (p && p !== t.category_id && used.has(p)) used.set(p, used.get(p)! + s);
  }
  return used;
}

/** The month's budgets taken together; null with no budget at all. */
export function monthBudget(limits: Map<string, number>, used: Map<string, number>): BudgetStatus | null {
  if (limits.size === 0) return null;
  let limit = 0;
  let use = 0;
  for (const [k, v] of limits) {
    limit += v;
    use += used.get(k) ?? 0;
  }
  return budgetStatus(limit, use);
}
