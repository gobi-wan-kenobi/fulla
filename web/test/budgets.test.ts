// SPDX-License-Identifier: GPL-3.0-or-later
// The Budgets screen: limits for every month or one, subcategories inside
// their category, totals that never count twice, fixed costs expected against
// paid, and the bar's colours. Every amount and name here is invented.
import { describe, expect, it } from "vitest";
import { budgetStatus, budgetToSave, budgetTone, budgetsForMonth, budgetsView, categoryTone, expectedMinor, fixedTone, monthBudget, withBudget } from "@/lib/budgets";
import { type Account, type Budget, type Category, type Transaction, outsideTotals } from "@/lib/model";
import { overview } from "@/lib/overview";
import { periodBounds, periodOf, shiftPeriod } from "@/lib/period";
import type { LocalRow } from "@/lib/sync";
import { ALICE, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOUSING = category(id(941), "Housing", "expense", { fixed: true, sort: 1 });
const RENT = category(id(942), "Rent", "expense", { parent_id: HOUSING.id, fixed: true, sort: 2 });
const FOOD = category(id(943), "Food", "expense", { sort: 3 });
const SNACKS = category(id(944), "Snacks", "expense", { parent_id: FOOD.id, sort: 4 });
const LEISURE = category(id(945), "Leisure", "expense", { sort: 5 });
const GIFTS = category(id(946), "Gifts", "expense", { sort: 6 });
const FEES = category(id(947), "Fees", "expense", { sort: 7 });
const SALARY = category(id(948), "Salary", "income", { sort: 8 });
const OLD = category(id(949), "Old", "expense", { archived: true, sort: 9 });
const CATS: Category[] = [HOUSING, RENT, FOOD, SNACKS, LEISURE, GIFTS, FEES, SALARY, OLD];
const acct = (n: number, type: Account["type"]): Account => ({ id: id(n), name: `Example ${type}`, type, opening_balance_minor: 0, sort: n, archived: false });
const CHEQUING = acct(701, "checking");
const BROKER = acct(702, "investment");
const OUT = outsideTotals(CATS, [CHEQUING, BROKER]);
const b = (n: number, categoryId: string, amount: number, period: string | null = null): Budget => ({ id: id(n), category_id: categoryId, period, amount_minor: amount });

let n = 1;
function tx(date: string, kind: Transaction["kind"], amount: number, categoryId: string | null, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: id(1000 + n++), kind, date, amount_minor: amount, category_id: categoryId, account_id: CHEQUING.id, to_account_id: null,
    paid_by_member_id: kind === "income" ? null : ALICE, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}

const TXS = [
  // Earlier months, for what is usual.
  tx("2030-03-01", "expense", 150000, RENT.id), tx("2030-04-01", "expense", 150000, RENT.id), tx("2030-04-12", "expense", 6000, GIFTS.id),
  // May.
  tx("2030-05-01", "income", 400000, SALARY.id),
  tx("2030-05-01", "expense", 150000, RENT.id),
  tx("2030-05-03", "expense", 30000, FOOD.id),
  tx("2030-05-04", "expense", 12000, SNACKS.id),
  tx("2030-05-05", "refund", 2000, FOOD.id), // nets against Food
  tx("2030-05-06", "expense", 16500, LEISURE.id),
  tx("2030-05-07", "expense", 9000, LEISURE.id, { trip_id: id(801) }), // a trip with its own budget
  tx("2030-05-08", "expense", 1200, FEES.id, { account_id: BROKER.id }), // inside an investment account
  { ...tx("2030-05-09", "transfer", 80000, null), to_account_id: BROKER.id },
];
const TRIPS = [{ id: id(801), in_category_budgets: false }];
const BUDGETS = [
  b(1, FOOD.id, 40000), // every month
  b(2, SNACKS.id, 10000), // a smaller limit inside Food
  b(3, LEISURE.id, 20000), // every month…
  b(4, LEISURE.id, 18000, "2030-05"), // …but less in May
  b(5, HOUSING.id, 150000),
  b(6, GIFTS.id, 5000), // removed for May only:
  b(7, GIFTS.id, 0, "2030-05"),
];

describe("a month's budgets", () => {
  it("take the month's own over every month's, and a 0 means no budget that month", () => {
    const may = budgetsForMonth(BUDGETS, "2030-05");
    expect(may.get(LEISURE.id)).toBe(18000);
    expect(may.has(GIFTS.id)).toBe(false);
    expect(budgetsForMonth(BUDGETS, "2030-06").get(GIFTS.id)).toBe(5000);
  });

  it("add up without counting a subcategory inside a budgeted parent twice", () => {
    const limits = new Map([[FOOD.id, 40000], [SNACKS.id, 10000], [RENT.id, 150000], [LEISURE.id, 20000]]);
    const used = new Map([[FOOD.id, 40000], [SNACKS.id, 12000], [RENT.id, 150000], [LEISURE.id, 16500]]);
    // Food holds Snacks; Rent counts because Housing has no budget here.
    expect(monthBudget(limits, used, CATS)).toMatchObject({ limitMinor: 40000 + 150000 + 20000, usedMinor: 40000 + 150000 + 16500 });
    limits.set(HOUSING.id, 160000);
    used.set(HOUSING.id, 150000);
    expect(monthBudget(limits, used, CATS)).toMatchObject({ limitMinor: 40000 + 160000 + 20000, usedMinor: 40000 + 150000 + 16500 });
  });

  it("are ink below 80 %, amber from 80 %, red once over", () => {
    expect(budgetTone(budgetStatus(10000, 7999))).toBe("ok");
    expect(budgetTone(budgetStatus(10000, 8000))).toBe("near");
    expect(budgetTone(budgetStatus(10000, 10000))).toBe("near");
    expect(budgetTone(budgetStatus(10000, 10001))).toBe("over");
    expect(budgetTone(budgetStatus(10000, -500))).toBe("ok");
  });
});

describe("saving a budget", () => {
  const ids = () => id(9999);
  it("updates the category's row for that period, or makes a new one", () => {
    expect(budgetToSave(BUDGETS, LEISURE.id, "every", 25000, ids)).toEqual(b(3, LEISURE.id, 25000));
    expect(budgetToSave(BUDGETS, LEISURE.id, "2030-05", 15000, ids)).toEqual(b(4, LEISURE.id, 15000, "2030-05"));
    expect(budgetToSave(BUDGETS, LEISURE.id, "2030-06", 15000, ids)).toEqual(b(9999, LEISURE.id, 15000, "2030-06"));
    expect(budgetToSave(BUDGETS, FEES.id, "every", 1234.4, ids)).toEqual(b(9999, FEES.id, 1234));
  });

  it("removes by saving 0, since rows are never deleted", () => {
    const removed = withBudget(BUDGETS, budgetToSave(BUDGETS, FOOD.id, "every", 0, ids));
    expect(removed).toHaveLength(BUDGETS.length);
    expect(budgetsForMonth(removed, "2030-05").has(FOOD.id)).toBe(false);
    expect(withBudget(BUDGETS, b(9999, FEES.id, 700))).toHaveLength(BUDGETS.length + 1);
  });
});

describe("the Budgets screen", () => {
  const v = budgetsView(TXS, CATS, BUDGETS, "2030-05", TRIPS, OUT);

  it("groups fixed costs, everyday budgets and categories without one; archived and income ones are not there", () => {
    expect(v.fixed.map((l) => l.category.name)).toEqual(["Housing"]);
    expect(v.everyday.map((l) => l.category.name)).toEqual(["Food", "Leisure"]);
    expect(v.unbudgeted.map((l) => l.category.name)).toEqual(["Gifts", "Fees"]);
  });

  it("counts a category with its subcategories, refunds netted, by the Overview's rules", () => {
    const food = v.everyday[0];
    expect(food).toMatchObject({ limitMinor: 40000, source: "every", usedMinor: 30000 + 12000 - 2000 });
    expect(food.status).toMatchObject({ leftMinor: 0, overMinor: 0, fraction: 1 });
    expect(budgetTone(food.status!)).toBe("near");
    const snacks = food.subs[0];
    expect(snacks).toMatchObject({ limitMinor: 10000, usedMinor: 12000 });
    expect(budgetTone(snacks.status!)).toBe("over");
    // Leisure: May's own 180, the trip with its own budget out.
    expect(v.everyday[1]).toMatchObject({ limitMinor: 18000, source: "month", everyMinor: 20000, monthMinor: 18000, usedMinor: 16500 });
    // Fees inside the brokerage are not spending.
    expect(v.unbudgeted[1].usedMinor).toBe(0);
    // Gifts: no budget in May (0 for the month), though there is one every month.
    expect(v.unbudgeted[0]).toMatchObject({ limitMinor: null, everyMinor: 5000, monthMinor: 0, usualMinor: 3000 });
  });

  it("shows a fixed cost's expected amount (its budget, else what is usual) against what was paid", () => {
    const housing = v.fixed[0];
    expect(housing).toMatchObject({ limitMinor: 150000, usedMinor: 150000 });
    expect(expectedMinor(housing)).toBe(150000);
    const noBudget = budgetsView(TXS, CATS, [], "2030-05", TRIPS, OUT).fixed[0];
    expect(noBudget.limitMinor).toBeNull();
    expect(noBudget.usualMinor).toBe(150000); // March and April
    expect(expectedMinor(noBudget)).toBe(150000);
    expect(expectedMinor(budgetsView([], CATS, [], "2030-05").fixed[0])).toBeNull();
  });

  it("totals the month without counting twice, and the Overview's bar agrees", () => {
    // Food (with Snacks inside) + Leisure + Housing; Gifts none in May.
    expect(v.total).toMatchObject({ limitMinor: 40000 + 18000 + 150000, usedMinor: 40000 + 16500 + 150000 });
    const rows: LocalRow[] = TXS.map((t) => ({ tx: t, state: "synced", base: null }));
    const o = overview(rows, CATS, "2030-05", "2030-05-20", [CHEQUING, BROKER], { budgets: BUDGETS, trips: TRIPS });
    expect(o.budget).toEqual(v.total);
  });

  it("is empty with no budget at all", () => {
    const none = budgetsView(TXS, CATS, [], "2030-05", TRIPS, OUT);
    expect(none.total).toBeNull();
    expect(none.everyday).toEqual([]);
  });
});

describe("the period", () => {
  it("is the calendar month for now, in one place", () => {
    expect(periodOf("2030-02-14")).toBe("2030-02");
    expect(periodBounds("2030-02")).toEqual({ from: "2030-02-01", to: "2030-02-28" });
    expect(periodBounds("2032-02").to).toBe("2032-02-29");
    expect(shiftPeriod("2030-01", -1)).toBe("2029-12");
  });
});

describe("a fixed cost's colour", () => {
  it("is ink when paid as expected, red only past its budget, never red against what is usual", () => {
    const housing = budgetsView(TXS, CATS, BUDGETS, "2030-05", TRIPS, OUT).fixed[0];
    expect(fixedTone(housing)).toBe("ok");
    expect(fixedTone({ ...housing, usedMinor: 150001 })).toBe("over");
    const usual = budgetsView(TXS, CATS, [], "2030-05", TRIPS, OUT).fixed[0];
    expect(fixedTone({ ...usual, usedMinor: 999999 })).toBe("ok");
  });
});

describe("a category budget's colour where it is shown", () => {
  it("is amber from 80 % for everyday spending, never for a fixed cost paid as planned", () => {
    expect(categoryTone(budgetStatus(1000, 1000), false)).toBe("near");
    expect(categoryTone(budgetStatus(1000, 1000), true)).toBe("ok");
    expect(categoryTone(budgetStatus(1000, 1001), true)).toBe("over");
  });
});
