// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Goals: "save $100,000 by June 2031", or "$500 a month towards a car".
 *
 * Progress is the linked account's balance (the Balances figure, lib/balances
 * balancesView, so a statement's market value for an investment account), or,
 * without an account, the start amount plus what was recorded against the
 * goal (fulla.goal_contributions). From it: what is left, the monthly amount
 * the target date needs (or the goal's own monthly amount), the pace so far
 * (progress since the start, a month at a time), the finish date at that pace,
 * and whether that is on track.
 *
 * Where it could come from: the household's spending by category over its
 * last full months (up to three; a month counts once the records reach back
 * to its first week), by the Overview's rules (transfers, and anything on an
 * investment account, are not spending; refunds net). Only discretionary
 * categories are pointed at (eating out, leisure, shopping and the like), by
 * name, never a fixed category or Housing, debt payments, insurance,
 * utilities, health, groceries or transport; and only their everyday
 * (not fixed) spending. Each gets a share it could give (a quarter, more for
 * eating out), and how much of the monthly amount that covers. With one month
 * (or less) to go on, they are rough.
 *
 * With budgets, how the goal fits: the months' income, less the month's
 * budgets, less fixed spending in categories with no budget, against the
 * monthly amount the goal needs.
 */
import { balancesView } from "./balances";
import { budgetsForMonth } from "./budgets";
import { addDays, daysBetween } from "./dates";
import { monthOf, shiftMonth } from "./ledger";
import { type Category, type Config, type OutsideTotals, type Transaction, nothingOutside } from "./model";
import type { BalanceSnapshot } from "./overview";

export interface Goal {
  id: string;
  name: string;
  target_minor: number;
  target_date: string | null;
  monthly_minor: number | null;
  account_id: string | null;
  start_minor: number;
  start_date: string;
  archived: boolean;
}

export interface GoalContribution {
  id: string;
  goal_id: string;
  date: string;
  amount_minor: number;
  note: string;
}

export type GoalStatus = "done" | "on_track" | "behind" | "new" | "no_balance";

const MONTH_DAYS = 365.25 / 12;

export interface GoalProgress {
  goal: Goal;
  savedMinor: number;
  remainingMinor: number;
  fraction: number;
  /** Where the figure comes from: the linked account (as of its statement or opening balance), or contributions. */
  source: "account" | "contributions";
  /** The linked account has no statement or opening balance: its figure is not known. */
  unknownBalance: boolean;
  /** The monthly amount that reaches the target on its date; the goal's own monthly amount without one. */
  requiredMonthlyMinor: number;
  /** Progress per month since the start; null before a month has gone by. */
  paceMinor: number | null;
  /** At the current pace; null when the pace is nothing or less. */
  projectedDate: string | null;
  status: GoalStatus;
  monthsGone: number;
  monthsLeft: number | null;
}

export function goalProgress(goal: Goal, config: Config, txs: Transaction[], snapshots: BalanceSnapshot[], contributions: GoalContribution[], asOf: string): GoalProgress {
  let saved: number;
  let unknown = false;
  const linked = goal.account_id ? config.accounts.find((a) => a.id === goal.account_id) : undefined;
  if (linked) {
    const line = balancesView(config, txs.filter((t) => t.status === "active"), snapshots, asOf).accounts.find((l) => l.account.id === linked.id);
    saved = line?.balanceMinor ?? 0;
    unknown = !line?.known;
  } else {
    saved = goal.start_minor + contributions.filter((c) => c.goal_id === goal.id && c.date <= asOf).reduce((n, c) => n + c.amount_minor, 0);
  }
  const remaining = Math.max(0, goal.target_minor - saved);
  const monthsGone = Math.max(0, daysBetween(goal.start_date, asOf)) / MONTH_DAYS;
  const monthsLeft = goal.target_date ? daysBetween(asOf, goal.target_date) / MONTH_DAYS : null;
  const required = remaining === 0 ? 0
    : monthsLeft !== null ? (monthsLeft <= 1 ? remaining : Math.ceil(remaining / monthsLeft))
    : goal.monthly_minor ?? 0;
  const pace = monthsGone >= 1 ? Math.round((saved - goal.start_minor) / monthsGone) : null;
  const projectedDate = remaining === 0 ? asOf : pace && pace > 0 ? addDays(asOf, Math.ceil((remaining / pace) * MONTH_DAYS)) : null;
  let status: GoalStatus;
  if (unknown) status = "no_balance";
  else if (remaining === 0) status = "done";
  else if (pace === null) status = "new";
  else if (goal.target_date) status = projectedDate !== null && projectedDate <= goal.target_date ? "on_track" : "behind";
  else status = saved - goal.start_minor >= Math.floor((goal.monthly_minor ?? 0) * monthsGone * 0.98) ? "on_track" : "behind";
  return {
    goal, savedMinor: saved, remainingMinor: remaining, fraction: Math.max(0, Math.min(1, saved / goal.target_minor)),
    source: linked ? "account" : "contributions", unknownBalance: unknown, requiredMonthlyMinor: required,
    paceMinor: pace, projectedDate, status, monthsGone, monthsLeft,
  };
}

// ── where it could come from ─────────────────────────────────────────────────

/** Discretionary categories, by name: the share of everyday spending each could give. */
const DISCRETIONARY: [RegExp, number][] = [
  [/eating out|dining|restaurant|take ?out|takeaway|coffee|caf[eé]|bars?\b|alcohol|food delivery/i, 0.3],
  [/leisure|entertainment|\bfun\b|hobb|going out|games?|streaming/i, 0.25],
  [/shopping|clothes|clothing|apparel|electronics|home goods/i, 0.25],
  [/subscriptions?/i, 0.2],
  [/travel|holiday|vacation/i, 0.2],
  [/gifts?|personal care|beauty/i, 0.15],
];
/** Never pointed at, whatever else the name says. */
const ESSENTIAL = /housing|rent|mortgage|debt|loan|credit|insurance|utilit|health|medical|pharmacy|groceries|transport|fuel|gas\b|childcare|daycare|school|education|tax|fees?\b/i;

export function discretionaryShare(c: Category): number | null {
  if (c.applies_to === "income" || c.fixed || ESSENTIAL.test(c.name)) return null;
  for (const [re, share] of DISCRETIONARY) if (re.test(c.name)) return share;
  return null;
}

export interface Suggestion {
  categoryId: string;
  name: string;
  /** Everyday spending a month, over the months used. */
  averageMinor: number;
  cutMinor: number;
  share: number;
  /** Of the goal's monthly amount; null when it needs nothing. */
  covers: number | null;
}

export interface Suggestions {
  months: string[];
  rough: boolean;
  items: Suggestion[];
  totalCutMinor: number;
  covers: number | null;
}

/** The months to go on: up to three full months before asOf's, latest first; else the latest month with anything. */
export function basisMonths(txs: Transaction[], asOf: string, outside: OutsideTotals = nothingOutside): { months: string[]; full: boolean } {
  const rows = txs.filter((t) => t.status === "active" && !outside(t) && (t.kind === "expense" || t.kind === "income" || t.kind === "refund") && t.date <= asOf);
  if (rows.length === 0) return { months: [], full: false };
  const first = rows.reduce((m, t) => (t.date < m ? t.date : m), rows[0].date);
  const current = monthOf(asOf);
  const full: string[] = [];
  for (let i = 1; i <= 24 && full.length < 3; i++) {
    const m = shiftMonth(current, -i);
    if (`${m}-07` < first) break;
    if (rows.some((t) => monthOf(t.date) === m)) full.push(m);
  }
  if (full.length) return { months: full, full: true };
  const latest = rows.reduce((m, t) => (t.date > m ? t.date : m), rows[0].date);
  return { months: [monthOf(latest)], full: false };
}

function topLevel(categories: Category[]): (id: string | null) => string | null {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (id) => {
    const c = id ? byId.get(id) : undefined;
    return c?.parent_id && byId.has(c.parent_id) ? c.parent_id : id;
  };
}

export function suggestions(txs: Transaction[], categories: Category[], requiredMonthlyMinor: number, asOf: string, outside: OutsideTotals = nothingOutside, max = 5): Suggestions {
  const { months, full } = basisMonths(txs, asOf, outside);
  const roll = topLevel(categories);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const spent = new Map<string, number>();
  for (const t of txs) {
    if (t.status !== "active" || outside(t) || !months.includes(monthOf(t.date)) || t.recurrence === "fixed") continue;
    const s = t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0;
    if (!s || !t.category_id) continue;
    // A subcategory counts under its parent, unless it is itself something not to cut (a fixed child).
    if (byId.get(t.category_id)?.fixed) continue;
    const k = roll(t.category_id)!;
    spent.set(k, (spent.get(k) ?? 0) + s);
  }
  const items: Suggestion[] = [];
  for (const [id, total] of spent) {
    const c = byId.get(id);
    const share = c ? discretionaryShare(c) : null;
    if (!c || share === null) continue;
    const average = Math.round(total / Math.max(1, months.length));
    const cut = Math.round((average * share) / 100) * 100;
    if (cut <= 0) continue;
    items.push({ categoryId: id, name: c.name, averageMinor: average, cutMinor: cut, share, covers: requiredMonthlyMinor > 0 ? cut / requiredMonthlyMinor : null });
  }
  items.sort((a, b) => b.cutMinor - a.cutMinor || a.name.localeCompare(b.name));
  const top = items.slice(0, max);
  const total = top.reduce((n, s) => n + s.cutMinor, 0);
  return { months, rough: !full || months.length < 2, items: top, totalCutMinor: total, covers: requiredMonthlyMinor > 0 ? total / requiredMonthlyMinor : null };
}

export interface BudgetFit {
  incomeMinor: number;
  budgetsMinor: number;
  fixedMinor: number;
  leftMinor: number;
  requiredMonthlyMinor: number;
  fits: boolean;
}

/** With budgets this month: income (a month, over the basis months) less budgets less unbudgeted fixed spending, against the goal. */
export function budgetFit(txs: Transaction[], config: Pick<Config, "categories" | "budgets">, requiredMonthlyMinor: number, asOf: string, outside: OutsideTotals = nothingOutside): BudgetFit | null {
  const limits = budgetsForMonth(config.budgets ?? [], monthOf(asOf));
  if (limits.size === 0) return null;
  const roll = topLevel(config.categories);
  const byId = new Map(config.categories.map((c) => [c.id, c]));
  // Budgets: top-level ones, and a subcategory's only where its parent has none.
  let budgets = 0;
  for (const [id, v] of limits) {
    const p = byId.get(id)?.parent_id;
    if (!p || !limits.has(p)) budgets += v;
  }
  const { months } = basisMonths(txs, asOf, outside);
  const n = Math.max(1, months.length);
  let income = 0;
  let fixed = 0;
  for (const t of txs) {
    if (t.status !== "active" || outside(t) || !months.includes(monthOf(t.date))) continue;
    if (t.kind === "income") income += t.amount_minor;
    const budgeted = (t.category_id && limits.has(t.category_id)) || (roll(t.category_id) && limits.has(roll(t.category_id)!));
    const isFixed = t.recurrence === "fixed" || (t.category_id ? !!byId.get(t.category_id)?.fixed || !!byId.get(roll(t.category_id)!)?.fixed : false);
    if (!budgeted && isFixed) fixed += t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0;
  }
  const incomeMinor = Math.round(income / n);
  const fixedMinor = Math.round(fixed / n);
  const left = incomeMinor - budgets - fixedMinor;
  return { incomeMinor, budgetsMinor: budgets, fixedMinor, leftMinor: left, requiredMonthlyMinor, fits: left >= requiredMonthlyMinor };
}

/** What is wrong with a goal before it is saved, or null (the same rules as fulla_goal_upsert). */
export function goalProblem(g: Pick<Goal, "name" | "target_minor" | "target_date" | "monthly_minor" | "start_date" | "start_minor">): string | null {
  if (!g.name.trim() || g.name.trim().length > 60) return "Give it a name (up to 60 characters)";
  if (!(g.target_minor > 0)) return "Set how much to save";
  if (!g.target_date && !(g.monthly_minor && g.monthly_minor > 0)) return "Set a target date or a monthly amount";
  if (g.monthly_minor !== null && !(g.monthly_minor > 0)) return "The monthly amount must be more than zero";
  if (g.target_date && g.target_date <= g.start_date) return "The target date must be after the start";
  if (g.start_minor >= g.target_minor) return "It starts at or above the target already";
  return null;
}
