// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The budgets of a month, as the Android app keeps them (core's Budgets and
 * Analytics.budgetSpend), from the shared fulla.budgets table: one limit per
 * category, for every month (period null) or for one month (YYYY-MM), the
 * month's own winning over the default.
 *
 * Months are calendar months for now (lib/period.ts is where a payday start
 * would go). What a budget used is the category's spending (expenses less
 * refunds), its subcategories included, by the Overview's rules: transfers, and anything
 * inside an investment account, are not spending. Rows on a trip that keeps
 * its own budget (in_category_budgets false) are left out, as in the app.
 */
import { periodOf, shiftPeriod } from "./period";
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
    if (periodOf(t.date) !== month || outside(t)) continue;
    if (t.trip_id && ownBudget.has(t.trip_id)) continue;
    const s = t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0;
    if (!s || !t.category_id) continue;
    if (used.has(t.category_id)) used.set(t.category_id, used.get(t.category_id)! + s);
    const p = parent.get(t.category_id);
    if (p && p !== t.category_id && used.has(p)) used.set(p, used.get(p)! + s);
  }
  return used;
}

/**
 * The month's budgets taken together; null with no budget at all. A
 * category's budget already holds its subcategories' spending, so the total
 * takes every top-level budget, and a subcategory's budget only where its
 * parent has none: nothing is counted twice.
 */
export function monthBudget(limits: Map<string, number>, used: Map<string, number>, categories: Category[] = []): BudgetStatus | null {
  if (limits.size === 0) return null;
  const parent = new Map(categories.map((c) => [c.id, c.parent_id]));
  let limit = 0;
  let use = 0;
  for (const [k, v] of limits) {
    const p = parent.get(k);
    if (p && p !== k && limits.has(p)) continue;
    limit += v;
    use += used.get(k) ?? 0;
  }
  return budgetStatus(limit, use);
}

export type BudgetTone = "ok" | "near" | "over";
/** From 80 % used a budget is near; over once it is passed. */
export const NEAR_FRACTION = 0.8;

/** How a budget's line and words are coloured: ink, amber from 80 %, red once over. */
export function budgetTone(s: BudgetStatus): BudgetTone {
  return s.overMinor > 0 ? "over" : s.fraction >= NEAR_FRACTION ? "near" : "ok";
}

/**
 * A fixed cost's tone: paying what was expected is the plan, not a warning,
 * so it is ink up to its budget and red past it; against what is usual
 * (no budget), it is never red, only told.
 */
export function fixedTone(l: BudgetLine): BudgetTone {
  const expected = expectedMinor(l);
  return l.limitMinor !== null && expected !== null && l.usedMinor > expected ? "over" : "ok";
}

/** A category budget's tone where it is shown: a fixed-cost category's is never amber (paying it is the plan). */
export function categoryTone(s: BudgetStatus, fixed: boolean | undefined): BudgetTone {
  return fixed ? (s.overMinor > 0 ? "over" : "ok") : budgetTone(s);
}

/** A category's own budgets: its default for every month and its limit for this month, either missing. */
export function budgetsOf(budgets: Budget[], categoryId: string, month: string): { every: Budget | null; month: Budget | null } {
  return {
    every: budgets.find((b) => b.category_id === categoryId && b.period == null) ?? null,
    month: budgets.find((b) => b.category_id === categoryId && b.period === month) ?? null,
  };
}

/**
 * The budget to save (fulla_budget_upsert) for a category: for every month,
 * or for one month only; the row already there is updated, so there is one
 * per category and period. Budgets are never deleted (the database keeps
 * every row): a budget is removed by saving 0, which for one month means
 * "no budget this month" even with a default.
 */
export function budgetToSave(budgets: Budget[], categoryId: string, scope: "every" | string, amountMinor: number, newId: () => string): Budget {
  const period = scope === "every" ? null : scope;
  const existing = budgets.find((b) => b.category_id === categoryId && (b.period ?? null) === period);
  return { id: existing?.id ?? newId(), category_id: categoryId, period, amount_minor: Math.max(0, Math.round(amountMinor)) };
}

/** The config with one budget saved in it, as the database will answer: for showing it at once. */
export function withBudget(budgets: Budget[], b: Budget): Budget[] {
  return budgets.some((x) => x.id === b.id) ? budgets.map((x) => (x.id === b.id ? b : x)) : [...budgets, b];
}

export interface BudgetLine {
  category: Category;
  /** The month's limit, from this month's own or the default; null without one (or 0). */
  limitMinor: number | null;
  /** Where the limit comes from. */
  source: "month" | "every" | null;
  everyMinor: number | null;
  monthMinor: number | null;
  /** Spending in the category this month (subcategories in, for a top-level one), by the budgets' rules. */
  usedMinor: number;
  status: BudgetStatus | null;
  /** The average of up to three earlier months with any spending; 0 without any. */
  usualMinor: number;
  subs: BudgetLine[];
}

export interface BudgetsView {
  month: string;
  total: BudgetStatus | null;
  /** Fixed-cost categories (fixed, 0023): expected (the budget, else what is usual) against what was paid. */
  fixed: BudgetLine[];
  /** Everyday categories with a budget, or a subcategory with one. */
  everyday: BudgetLine[];
  /** Everyday categories with no budget at all yet. */
  unbudgeted: BudgetLine[];
}

/** The Budgets screen: every spending category's budget for the month and what used it. */
export function budgetsView(txs: Transaction[], categories: Category[], budgets: Budget[], month: string, trips: Trip[] = [], outside: OutsideTotals = nothingOutside, earlier: (n: number) => string = (n) => shiftPeriod(month, -n)): BudgetsView {
  const spending = categories.filter((c) => !c.archived && c.applies_to !== "income").sort((a, b) => a.sort - b.sort);
  const ids = new Set(spending.map((c) => c.id));
  const all = new Map(spending.map((c) => [c.id, 1]));
  const limits = budgetsForMonth(budgets, month);
  const used = budgetUse(txs, categories, all, month, trips, outside);
  const before = [1, 2, 3].map((n) => budgetUse(txs, categories, all, earlier(n), trips, outside)).filter((m) => [...m.values()].some((v) => v !== 0));
  const line = (c: Category, subs: BudgetLine[]): BudgetLine => {
    const own = budgetsOf(budgets, c.id, month);
    const limit = limits.get(c.id) ?? null;
    const u = used.get(c.id) ?? 0;
    return {
      category: c,
      limitMinor: limit,
      source: limit === null ? null : own.month ? "month" : "every",
      everyMinor: own.every?.amount_minor ?? null,
      monthMinor: own.month?.amount_minor ?? null,
      usedMinor: u,
      status: limit !== null ? budgetStatus(limit, u) : null,
      usualMinor: before.length ? Math.round(before.reduce((a, m) => a + (m.get(c.id) ?? 0), 0) / before.length) : 0,
      subs,
    };
  };
  const tops = spending.filter((c) => !c.parent_id || !ids.has(c.parent_id));
  const lines = tops.map((t) => line(t, spending.filter((s) => s.parent_id === t.id).map((s) => line(s, []))));
  const hasAny = (l: BudgetLine) => l.limitMinor !== null || l.subs.some((s) => s.limitMinor !== null);
  return {
    month,
    total: monthBudget(limits, used, categories),
    fixed: lines.filter((l) => l.category.fixed),
    everyday: lines.filter((l) => !l.category.fixed && hasAny(l)),
    unbudgeted: lines.filter((l) => !l.category.fixed && !hasAny(l)),
  };
}

/** What a fixed cost was expected to be: its budget, else what it usually is; null with neither. */
export function expectedMinor(l: BudgetLine): number | null {
  return l.limitMinor ?? (l.usualMinor > 0 ? l.usualMinor : null);
}
