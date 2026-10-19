// SPDX-License-Identifier: GPL-3.0-or-later
// Goals: progress, pace, monthly target, where it could come from, and how it fits the budgets. Invented data.
import { describe, expect, it } from "vitest";
import { type Goal, basisMonths, budgetFit, discretionaryShare, goalProblem, goalProgress, suggestions } from "@/lib/goals";
import { type Account, type Category, type Config, type Transaction, outsideTotals } from "@/lib/model";
import type { BalanceSnapshot } from "@/lib/overview";
import { ALICE, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C = {
  eat: category(id(101), "Eating out", "expense"), fun: category(id(102), "Leisure", "expense"), shop: category(id(103), "Shopping", "expense"),
  clothes: category(id(104), "Clothes", "expense", { parent_id: id(103) }), food: category(id(105), "Groceries", "expense"),
  home: category(id(106), "Housing", "expense"), debt: category(id(107), "Debt payments", "expense", { fixed: true }),
  subs: category(id(108), "Subscriptions", "expense"), pay: category(id(109), "Salary", "income"),
  grant: category(id(110), "Government grants", "income", { excluded_from_income: true }), card: category(id(111), "Credit card interest", "expense"),
};
const categories: Category[] = Object.values(C);
const acct = (n: number, name: string, type: Account["type"]): Account => ({ id: id(n), name, type, opening_balance_minor: 0, opening_balance_date: null, sort: n, archived: false });
const CHQ = acct(801, "Chequing", "checking");
const TFSA = acct(802, "TFSA", "investment");
const EMPTY = acct(803, "New savings", "savings");
const config = { categories, accounts: [CHQ, TFSA, EMPTY], members: [], household: { money_mode: null },
  budgets: [{ id: "b1", category_id: C.eat.id, period: null, amount_minor: 50000 }, { id: "b2", category_id: C.food.id, period: null, amount_minor: 80000 }] } as unknown as Config;
const outside = outsideTotals(categories, config.accounts);

let n = 1;
function tx(date: string, kind: Transaction["kind"], amount: number, c: Category | null, extra: Partial<Transaction> = {}): Transaction {
  return { id: id(5000 + n++), kind, date, amount_minor: amount, category_id: c?.id ?? null, account_id: CHQ.id, to_account_id: null, paid_by_member_id: kind === "expense" ? ALICE : null,
    to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null,
    import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra };
}
const month = (m: string) => [
  tx(`${m}-01`, "income", 600000, C.pay), tx(`${m}-02`, "income", 50000, C.grant),
  tx(`${m}-03`, "expense", 180000, C.home, { recurrence: "fixed" }), tx(`${m}-04`, "expense", 30000, C.debt),
  tx(`${m}-05`, "expense", 60000, C.eat), tx(`${m}-06`, "expense", 20000, C.fun), tx(`${m}-07`, "expense", 30000, C.shop),
  tx(`${m}-08`, "expense", 10000, C.clothes), tx(`${m}-09`, "expense", 80000, C.food), tx(`${m}-10`, "expense", 2000, C.subs, { recurrence: "fixed" }),
  tx(`${m}-11`, "expense", 999, C.fun, { account_id: TFSA.id }), tx(`${m}-12`, "transfer", 100000, null, { to_account_id: TFSA.id }), tx(`${m}-13`, "expense", 4000, C.card),
];
const txs = [...month("2030-07"), ...month("2030-08"), ...month("2030-09"), tx("2030-09-20", "refund", 5000, C.eat),
  tx("2030-10-02", "expense", 99999, C.eat), tx("2030-06-25", "expense", 77777, C.eat)];
const snapshots: BalanceSnapshot[] = [{ account_id: TFSA.id, as_of: "2030-09-30", balance_minor: 4000000 }];
const TODAY = "2030-10-18";
const goal = (g: Partial<Goal>): Goal => ({ id: id(900), name: "House", target_minor: 10000000, target_date: "2031-12-31", monthly_minor: null, account_id: TFSA.id, start_minor: 2500000, start_date: "2030-01-01", archived: false, ...g });

describe("goal progress", () => {
  it("a linked account: its Balances figure is progress; behind when the pace does not reach the date", () => {
    const p = goalProgress(goal({}), config, txs, snapshots, [], TODAY);
    // The TFSA statement plus the October transfer in.
    expect(p.savedMinor).toBe(4000000);
    expect(p).toMatchObject({ source: "account", unknownBalance: false, remainingMinor: 6000000, status: "behind" });
    expect(p.fraction).toBeCloseTo(0.4);
    const monthsGone = 290 / (365.25 / 12), monthsLeft = 439 / (365.25 / 12);
    expect(p.paceMinor).toBe(Math.round(1500000 / monthsGone));
    expect(p.requiredMonthlyMinor).toBe(Math.ceil(6000000 / monthsLeft));
    expect(p.projectedDate! > "2033-01-01").toBe(true);
    // A later date is on track at the same pace.
    expect(goalProgress(goal({ target_date: "2034-12-31" }), config, txs, snapshots, [], TODAY).status).toBe("on_track");
  });

  it("contributions: start plus what was recorded; a monthly goal is on track when it keeps up", () => {
    const g = goal({ id: id(901), account_id: null, target_date: null, monthly_minor: 50000, target_minor: 1000000, start_minor: 10000, start_date: "2030-08-01" });
    const cs = ["2030-08-15", "2030-09-15", "2030-10-15", "2030-10-30"].map((d, i) => ({ id: id(950 + i), goal_id: g.id, date: d, amount_minor: 50000, note: "" }));
    const p = goalProgress(g, config, txs, snapshots, [...cs, { id: id(960), goal_id: id(999), date: "2030-09-01", amount_minor: 777777, note: "" }], TODAY);
    expect(p).toMatchObject({ source: "contributions", savedMinor: 160000, requiredMonthlyMinor: 50000, status: "on_track" });
    const slow = goalProgress(g, config, txs, snapshots, cs.slice(0, 1), TODAY);
    expect(slow.status).toBe("behind");
  });

  it("reached, just started, no balance yet, and a date already gone", () => {
    expect(goalProgress(goal({ target_minor: 3000000 }), config, txs, snapshots, [], TODAY)).toMatchObject({ status: "done", remainingMinor: 0, requiredMonthlyMinor: 0, fraction: 1 });
    expect(goalProgress(goal({ start_date: "2030-10-01", start_minor: 4000000 }), config, txs, snapshots, [], TODAY)).toMatchObject({ status: "new", paceMinor: null });
    expect(goalProgress(goal({ account_id: EMPTY.id }), config, txs, snapshots, [], TODAY)).toMatchObject({ status: "no_balance", unknownBalance: true });
    const late = goalProgress(goal({ target_date: "2030-10-20" }), config, txs, snapshots, [], TODAY);
    expect(late.requiredMonthlyMinor).toBe(6000000);
  });

  it("the editor's rules match the database's", () => {
    const ok = { name: "Car", target_minor: 100, target_date: null, monthly_minor: 10, start_date: "2030-01-01", start_minor: 0 };
    expect(goalProblem(ok)).toBeNull();
    expect(goalProblem({ ...ok, name: " " })).toMatch(/name/);
    expect(goalProblem({ ...ok, monthly_minor: null })).toMatch(/date or a monthly/);
    expect(goalProblem({ ...ok, target_date: "2029-01-01" })).toMatch(/after the start/);
    expect(goalProblem({ ...ok, start_minor: 100 })).toMatch(/above the target/);
  });
});

describe("where it could come from", () => {
  it("full months only (records reach their first week), up to three, latest first", () => {
    expect(basisMonths(txs, TODAY, outside)).toEqual({ months: ["2030-09", "2030-08", "2030-07"], full: true });
    expect(basisMonths(txs.filter((t) => t.date >= "2030-09-20"), TODAY, outside)).toEqual({ months: ["2030-10"], full: false });
    expect(basisMonths(txs.filter((t) => t.date >= "2030-08-19"), TODAY, outside)).toEqual({ months: ["2030-09"], full: true });
  });

  it("discretionary categories only, everyday spending, refunds net; never fixed, housing, debt, groceries", () => {
    const s = suggestions(txs, categories, 416000, TODAY, outside);
    expect(s.rough).toBe(false);
    expect(s.items.map((i) => [i.name, i.averageMinor, i.cutMinor, i.share])).toEqual([
      ["Eating out", Math.round((180000 - 5000) / 3), 17500, 0.3],
      ["Shopping", 40000, 10000, 0.25],
      ["Leisure", 20000, 5000, 0.25],
    ]);
    expect(s.items[0].covers).toBeCloseTo(17500 / 416000);
    expect(s.totalCutMinor).toBe(32500);
    expect(s.covers).toBeCloseTo(32500 / 416000);
    for (const c of [C.home, C.debt, C.food, C.card, C.pay]) expect(discretionaryShare(c)).toBeNull();
    expect(discretionaryShare(category("x", "Restaurants & bars", "expense"))).toBe(0.3);
    expect(discretionaryShare(category("x", "Dining", "expense", { fixed: true }))).toBeNull();
  });

  it("with one month to go on, rough", () => {
    const s = suggestions(txs.filter((t) => t.date >= "2030-08-19"), categories, 100000, TODAY, outside);
    expect(s).toMatchObject({ months: ["2030-09"], rough: true });
    expect(s.items[0]).toMatchObject({ name: "Eating out", averageMinor: 55000, cutMinor: 16500 });
    expect(suggestions([], categories, 100000, TODAY, outside)).toMatchObject({ items: [], months: [], totalCutMinor: 0 });
  });

  it("with budgets: income less budgets less unbudgeted fixed costs, against the goal", () => {
    expect(budgetFit(txs, config, 416000, TODAY, outside)).toEqual({ incomeMinor: 600000, budgetsMinor: 130000, fixedMinor: 212000, leftMinor: 258000, requiredMonthlyMinor: 416000, fits: false });
    expect(budgetFit(txs, config, 200000, TODAY, outside)?.fits).toBe(true);
    expect(budgetFit(txs, { ...config, budgets: [] }, 416000, TODAY, outside)).toBeNull();
  });
});
