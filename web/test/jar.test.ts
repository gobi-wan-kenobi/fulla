// SPDX-License-Identifier: GPL-3.0-or-later
// The Overview's jar and budget bar, ported from the Android app's Hero,
// Liquid, HeroJar and Budgets. Every amount and name here is invented.
import { describe, expect, it } from "vitest";
import { budgetStatus, budgetsForMonth, budgetUse, monthBudget } from "@/lib/budgets";
import { LIQUID_MS, emulsion, figureTop, hero, jarFrame, jarPaths, settle, surface, trapezoidMean } from "@/lib/jar";
import type { Account, Budget, Category, Transaction } from "@/lib/model";
import { overview } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { ALICE, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the jar's numbers", () => {
  it("put income and spending on a field twice the income, so the gap is the savings to scale", () => {
    const h = hero(400000, 100000);
    expect(h.incomeFraction).toBe(0.5);
    expect(h.expenseFraction).toBe(0.125);
    expect(h.gapFraction).toBeCloseTo(0.375, 12); // 300000 of 800000
    expect(h.savingsMinor).toBe(300000);
  });

  it("stretch the field only for spending beyond twice the income, and overlap by the deficit", () => {
    const over = hero(100000, 150000);
    expect(over.incomeFraction).toBe(0.5);
    expect(over.expenseFraction).toBe(0.75);
    expect(over.gapFraction).toBe(-0.25);
    const far = hero(100000, 500000);
    expect(far.expenseFraction).toBe(1);
    expect(far.incomeFraction).toBe(0.2);
    expect(hero(0, 0)).toMatchObject({ incomeFraction: 0, expenseFraction: 0, savingsMinor: 0 });
    expect(hero(0, 4200).expenseFraction).toBe(1);
  });
});

describe("the liquid", () => {
  it("never changes how much there is: every surface has a mean of zero, meniscus included", () => {
    for (const [amp, phase, waves, men] of [[0.02, 0.3, 1.4, -0.01], [0.05, 1.9, 1.1, 0.02], [0, 0, 1, 0.03]]) {
      expect(Math.abs(trapezoidMean(surface(96, amp, phase, waves, men)))).toBeLessThan(1e-12);
    }
    expect(() => surface(1, 0.1, 0, 1)).toThrow();
  });

  it("sloshes and comes to rest at the end of the 420 ms", () => {
    expect(settle(0)).toBe(1);
    expect(settle(1)).toBe(0);
    expect(Math.abs(settle(0.5))).toBeLessThan(0.2);
  });

  it("rests at its levels: income hangs from the lid, spending sits on the floor, the gap between", () => {
    const h = hero(400000, 100000);
    const j = jarFrame(384, 300, h.incomeFraction, h.expenseFraction, 1, LIQUID_MS);
    const inside = 300 - 12;
    expect(j.incomeLevel).toBeCloseTo(6 + inside * 0.5, 9);
    expect(j.expenseLevel).toBeCloseTo(294 - inside * 0.125, 9);
    expect(j.mixed).toBe(false);
    expect(j.incomeSurface).toHaveLength(96);
    expect(j.incomeSurface[0].x).toBe(12);
    expect(j.incomeSurface[95].x).toBe(372);
    // The figure sits in the gap, in ink.
    expect(figureTop(j, false)).toBeCloseTo((j.incomeLevel + j.expenseLevel) / 2 - 30, 9);
    const p = jarPaths(j);
    expect(p.band).toBeNull();
    expect(p.income.startsWith("M12 6 L372 6")).toBe(true);
    expect(p.expense.startsWith("M12 294")).toBe(true);
  });

  it("starts empty and rises", () => {
    const j = jarFrame(384, 300, 0.5, 0.25, 0, 0);
    expect(j.incomeLevel).toBeCloseTo(6 + 8, 9); // only the slosh
    expect(j.expenseLevel).toBeCloseTo(294 - 8, 9);
  });

  it("mixes when spending passes income, the band is the deficit, and the figure moves to the lid", () => {
    const h = hero(100000, 150000);
    const j = jarFrame(384, 300, h.incomeFraction, h.expenseFraction, 1, LIQUID_MS);
    expect(j.mixed).toBe(true);
    expect(j.incomeLevel - j.expenseLevel).toBeCloseTo(288 * 0.25, 9);
    expect(jarPaths(j).band).not.toBeNull();
    expect(figureTop(j, true)).toBe(6 + 16);
    expect(emulsion()).toEqual(emulsion()); // the same deficit always looks the same
    expect(emulsion()).toHaveLength(64);
  });
});

const GROCERIES = category(id(921), "Groceries", "expense");
const SNACKS = category(id(922), "Snacks", "expense", { parent_id: GROCERIES.id });
const LEISURE = category(id(923), "Leisure", "expense");
const FEES = category(id(924), "Fees", "expense");
const SALARY = category(id(925), "Salary", "income");
const CATS: Category[] = [GROCERIES, SNACKS, LEISURE, FEES, SALARY];
const acct = (n: number, type: Account["type"]): Account => ({ id: id(n), name: `Example ${type}`, type, opening_balance_minor: 0, sort: n, archived: false });
const CHEQUING = acct(501, "checking");
const BROKER = acct(502, "investment");
const budget = (n: number, categoryId: string, amount: number, period: string | null = null): Budget => ({ id: id(n), category_id: categoryId, period, amount_minor: amount });
function tx(n: number, kind: Transaction["kind"], amount: number, categoryId: string, accountId = CHEQUING.id, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: id(n), kind, date: "2030-05-10", amount_minor: amount, category_id: categoryId, account_id: accountId, to_account_id: null,
    paid_by_member_id: kind === "income" ? null : ALICE, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}
const rows = (txs: Transaction[]): LocalRow[] => txs.map((t) => ({ tx: t, state: "synced", base: null }));

describe("the budget bar", () => {
  it("takes the month's own budget over the default, and drops zero limits", () => {
    const limits = budgetsForMonth([budget(1, GROCERIES.id, 50000), budget(2, GROCERIES.id, 60000, "2030-05"), budget(3, LEISURE.id, 0), budget(4, FEES.id, 900, "2030-06")], "2030-05");
    expect([...limits]).toEqual([[GROCERIES.id, 60000]]);
  });

  it("is left or over, never a negative left", () => {
    expect(budgetStatus(1000, 400)).toEqual({ limitMinor: 1000, usedMinor: 400, leftMinor: 600, overMinor: 0, fraction: 0.4 });
    expect(budgetStatus(1000, 1300)).toMatchObject({ leftMinor: 0, overMinor: 300, fraction: 1.3 });
    expect(monthBudget(new Map(), new Map())).toBeNull();
  });

  it("counts the categories' spending by the Overview's rules: subcategories in, refunds netted, investment accounts, transfers and own-budget trips out", () => {
    const txs = [
      tx(1, "income", 300000, SALARY.id),
      tx(2, "expense", 20000, GROCERIES.id),
      tx(3, "expense", 3000, SNACKS.id),
      tx(4, "refund", 1000, GROCERIES.id),
      tx(5, "expense", 9000, LEISURE.id),
      tx(6, "expense", 4000, LEISURE.id, CHEQUING.id, { trip_id: id(801) }), // a trip with its own budget
      tx(7, "expense", 2500, LEISURE.id, CHEQUING.id, { trip_id: id(802) }), // a trip that counts in the category budgets
      tx(8, "expense", 700, FEES.id, BROKER.id), // inside an investment account
      { ...tx(9, "transfer", 50000, GROCERIES.id), category_id: null, to_account_id: BROKER.id },
    ];
    const budgets = [budget(1, GROCERIES.id, 20000), budget(2, LEISURE.id, 15000), budget(3, FEES.id, 500)];
    const trips = [{ id: id(801), in_category_budgets: false }, { id: id(802), in_category_budgets: true }];
    const limits = budgetsForMonth(budgets, "2030-05");
    const used = budgetUse(txs, CATS, limits, "2030-05", trips, (t) => t.account_id === BROKER.id);
    expect([...used]).toEqual([[GROCERIES.id, 22000], [LEISURE.id, 11500], [FEES.id, 0]]);

    const v = overview(rows(txs), CATS, "2030-05", "2030-05-15", [CHEQUING, BROKER], { budgets, trips });
    expect(v.budget).toEqual({ limitMinor: 35500, usedMinor: 33500, leftMinor: 2000, overMinor: 0, fraction: 33500 / 35500 });
    const groceries = v.categories.find((c) => c.categoryId === GROCERIES.id)!;
    expect(groceries.amountMinor).toBe(22000);
    expect(groceries.budget).toMatchObject({ limitMinor: 20000, overMinor: 2000 });
    expect(v.categories.find((c) => c.categoryId === LEISURE.id)).toMatchObject({ amountMinor: 15500, budget: { usedMinor: 11500, leftMinor: 3500 } });
    expect(v.categories.find((c) => c.categoryId === FEES.id)).toBeUndefined(); // nothing spent outside the brokerage
    // The jar has the same figures.
    expect(v.hero).toMatchObject({ incomeMinor: 300000, expenseMinor: v.figures.spentMinor, savingsMinor: v.figures.leftMinor });
    expect(v.figures.spentMinor).toBe(20000 + 3000 - 1000 + 9000 + 4000 + 2500);
  });

  it("is null without any budget, and a category without one has none", () => {
    const v = overview(rows([tx(1, "expense", 500, GROCERIES.id)]), CATS, "2030-05", "2030-05-15", [CHEQUING]);
    expect(v.budget).toBeNull();
    expect(v.categories[0].budget).toBeNull();
  });
});
