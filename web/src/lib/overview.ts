// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The month at a glance, as the Overview draws it: what came in, what went
 * out, what is left (and its share of the income), where the spending went
 * by category, and what the accounts hold. Worked out here, so the screen
 * does no arithmetic on money.
 *
 *  - Spending is expenses less refunds. Transfers and settlements move money
 *    between the household's own accounts and people: never in a total.
 *  - Debt payments are spending (fixed, as their category says).
 *  - Money that stays inside an investment account (dividends, interest,
 *    grants) and money in a category left out of income is the account's,
 *    not the household's: not in the income (it shows in net worth).
 *  - Categories roll up to their parent; a parent opens to its subcategories.
 *  - "Usually" is the average of up to three earlier months that have
 *    anything written down.
 */
import { counted, monthOf, shiftMonth } from "./ledger";
import { type Account, type Category, type OutsideIncome, type Transaction, nothingOutside, outsideIncome } from "./model";
import type { LocalRow } from "./sync";

export interface Figures {
  incomeMinor: number;
  spentMinor: number;
  /** Income less spending; negative when more went out. */
  leftMinor: number;
  /** leftMinor over income, -∞..1; null without income. */
  savingsRate: number | null;
  fixedMinor: number;
  flexibleMinor: number;
}

export interface CategorySpend {
  /** The top-level category, or null for spending without one. */
  categoryId: string | null;
  amountMinor: number;
  /** Its part of the month's spending, 0..1. */
  share: number;
  fixedMinor: number;
  flexibleMinor: number;
  /** Earlier months' average, 0 without any. */
  usualMinor: number;
  /** Its subcategories (and its own rows, under the parent's id), largest first; empty when it has none. */
  subs: { categoryId: string; amountMinor: number }[];
}

export interface Overview {
  month: string;
  /** The month is still running: what is left is "left so far", not "saved". */
  running: boolean;
  figures: Figures;
  categories: CategorySpend[];
}

/** What a row adds to spending: an expense its amount, a refund less, anything else nothing. */
function spend(t: Transaction): number {
  return t.kind === "expense" ? t.amount_minor : t.kind === "refund" ? -t.amount_minor : 0;
}

function parentOf(byId: Map<string, Category>, id: string | null): string | null {
  if (!id) return null;
  const c = byId.get(id);
  return c?.parent_id && byId.has(c.parent_id) ? c.parent_id : id;
}

export function monthFigures(txs: Transaction[], month: string, outside: OutsideIncome = nothingOutside): Figures {
  let income = 0;
  let fixed = 0;
  let flexible = 0;
  for (const t of txs) {
    if (monthOf(t.date) !== month) continue;
    if (t.kind === "income" && !outside(t)) income += t.amount_minor;
    const s = spend(t);
    if (t.recurrence === "fixed") fixed += s;
    else flexible += s;
  }
  const spent = fixed + flexible;
  const left = income - spent;
  return { incomeMinor: income, spentMinor: spent, leftMinor: left, savingsRate: income > 0 ? left / income : null, fixedMinor: fixed, flexibleMinor: flexible };
}

/** Spending by top-level category, largest first; categories that netted to nothing are left out. */
export function byCategory(txs: Transaction[], categories: Category[], month: string): CategorySpend[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const totals = (m: string) => {
    const out = new Map<string | null, { amount: number; fixed: number; flexible: number; subs: Map<string, number> }>();
    for (const t of txs) {
      if (monthOf(t.date) !== m) continue;
      const s = spend(t);
      if (!s) continue;
      const key = parentOf(byId, t.category_id);
      const row = out.get(key) ?? { amount: 0, fixed: 0, flexible: 0, subs: new Map<string, number>() };
      row.amount += s;
      if (t.recurrence === "fixed") row.fixed += s;
      else row.flexible += s;
      if (key && t.category_id) row.subs.set(t.category_id, (row.subs.get(t.category_id) ?? 0) + s);
      out.set(key, row);
    }
    return out;
  };
  const now = totals(month);
  const earlier = [1, 2, 3].map((n) => totals(shiftMonth(month, -n))).filter((m) => m.size > 0);
  const whole = [...now.values()].reduce((a, r) => a + Math.max(0, r.amount), 0);
  return [...now.entries()]
    .filter(([, r]) => r.amount !== 0)
    .map(([id, r]) => {
      const subs = [...r.subs.entries()].filter(([, v]) => v !== 0).map(([categoryId, amountMinor]) => ({ categoryId, amountMinor }));
      // A parent whose rows all sit on it directly has nothing to open.
      const split = subs.length > 1 || (subs.length === 1 && subs[0].categoryId !== id);
      return {
        categoryId: id,
        amountMinor: r.amount,
        share: whole > 0 ? Math.max(0, r.amount) / whole : 0,
        fixedMinor: r.fixed,
        flexibleMinor: r.flexible,
        usualMinor: earlier.length ? Math.round(earlier.reduce((a, m) => a + (m.get(id)?.amount ?? 0), 0) / earlier.length) : 0,
        subs: split ? subs.sort((a, b) => b.amountMinor - a.amountMinor) : [],
      };
    })
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

/** Whole percentages that add up to 100 (largest remainder), in the order given. */
export function wholePercents(shares: number[]): number[] {
  const total = shares.reduce((a, s) => a + s, 0);
  if (total <= 0) return shares.map(() => 0);
  const raw = shares.map((s) => (s / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, n) => a + n, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

export function overview(rows: LocalRow[], categories: Category[], month: string, todayDate: string, accounts: Pick<Account, "id" | "type">[] = []): Overview {
  const txs = counted(rows);
  return {
    month,
    running: month === monthOf(todayDate),
    figures: monthFigures(txs, month, outsideIncome(categories, accounts)),
    categories: byCategory(txs, categories, month),
  };
}

export interface BalanceSnapshot {
  account_id: string;
  as_of: string;
  balance_minor: number;
}

/**
 * What each account holds on asOf: its latest statement balance on or
 * before that day plus everything after it, else its opening balance plus
 * everything from its opening date. Transfers move money between accounts;
 * settlements do not touch them.
 */
export function accountBalances(txs: Transaction[], accounts: Account[], snapshots: BalanceSnapshot[], asOf: string): Map<string, number> {
  const start = new Map<string, { balance: number; after: string | null; from: string | null }>();
  for (const a of accounts) start.set(a.id, { balance: a.opening_balance_minor ?? 0, after: null, from: a.opening_balance_date ?? null });
  for (const s of snapshots) {
    const cur = start.get(s.account_id);
    if (!cur || s.as_of > asOf) continue;
    if (cur.after === null || s.as_of > cur.after) start.set(s.account_id, { balance: s.balance_minor, after: s.as_of, from: null });
  }
  const out = new Map([...start.entries()].map(([id, s]) => [id, s.balance]));
  const add = (id: string | null, amount: number, date: string) => {
    const s = id ? start.get(id) : undefined;
    if (!s || !id) return;
    if (s.after !== null ? date <= s.after : s.from !== null && date < s.from) return;
    out.set(id, out.get(id)! + amount);
  };
  for (const t of txs) {
    if (t.date > asOf) continue;
    if (t.kind === "income" || t.kind === "refund") add(t.account_id, t.amount_minor, t.date);
    else if (t.kind === "expense") add(t.account_id, -t.amount_minor, t.date);
    else if (t.kind === "transfer") {
      add(t.account_id, -t.amount_minor, t.date);
      add(t.to_account_id, t.amount_minor, t.date);
    }
  }
  return out;
}

/**
 * The household's accounts together, once Fulla knows where at least one
 * started (an opening balance or a statement balance); null before, since a
 * total of flows alone would only be the months' sums again.
 */
export function holdings(rows: LocalRow[], accounts: Account[], snapshots: BalanceSnapshot[], asOf: string): { totalMinor: number; known: number } | null {
  const open = accounts.filter((a) => !a.archived);
  const known = open.filter((a) => (a.opening_balance_minor ?? 0) !== 0 || a.opening_balance_date || snapshots.some((s) => s.account_id === a.id && s.as_of <= asOf));
  if (known.length === 0) return null;
  const b = accountBalances(counted(rows), known, snapshots, asOf);
  return { totalMinor: [...b.values()].reduce((a, n) => a + n, 0), known: known.length };
}
