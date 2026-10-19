// SPDX-License-Identifier: GPL-3.0-or-later
// Insights: the month in figures, by the Overview's rules. Invented data.
import { describe, expect, it } from "vitest";
import { weekday } from "@/lib/dates";
import { report, merchantName } from "@/lib/insights";
import { type Account, type Category, type Config, type Transaction, outsideTotals } from "@/lib/model";
import { ALICE, BOB, GROCERIES, LEISURE, MAIN, SALARY, SNACKS, category, config as base } from "./support";

const RENT = "00000000-0000-4000-8000-000000000105";
const GRANT = "00000000-0000-4000-8000-000000000106";
const TFSA = "00000000-0000-4000-8000-000000000203";
const categories: Category[] = [...base.categories, category(RENT, "Rent", "expense", { fixed: true }), category(GRANT, "Grants", "income", { excluded_from_income: true })];
const accounts: Account[] = [...base.accounts, { id: TFSA, name: "TFSA", type: "investment", opening_balance_minor: 0, sort: 3, archived: false }];
const config = { ...base, categories, accounts, budgets: [
  { id: "b1", category_id: GROCERIES, period: null, amount_minor: 8000 },
  { id: "b2", category_id: LEISURE, period: null, amount_minor: 5000 },
], trips: [], household: {} } as unknown as Config;
const outside = outsideTotals(categories, accounts);

let n = 1;
function tx(date: string, kind: Transaction["kind"], amount: number, categoryId: string | null, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: `00000000-0000-4000-8000-${String(9000 + n++).padStart(12, "0")}`, kind, date, amount_minor: amount, category_id: categoryId, account_id: MAIN, to_account_id: null,
    paid_by_member_id: kind === "expense" ? ALICE : null, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}

const rows = [
  tx("2030-04-02", "expense", 3000, GROCERIES), tx("2030-04-09", "expense", 2000, GROCERIES),
  tx("2030-04-20", "expense", 10000, GROCERIES), tx("2030-04-05", "expense", 1000, LEISURE),
  tx("2030-05-01", "expense", 4000, GROCERIES, { note: "FRESH MARKET #12" }),
  tx("2030-05-03", "expense", 6000, GROCERIES, { note: "FRESH MARKET #40", split: { mode: "equal", members: [ALICE, BOB] } }),
  tx("2030-05-01", "expense", 150000, RENT, { recurrence: "fixed", note: "LANDLORD" }),
  tx("2030-05-04", "refund", 1000, GROCERIES),
  tx("2030-05-06", "expense", 500, SNACKS),
  tx("2030-05-02", "income", 300000, SALARY),
  tx("2030-05-03", "income", 50000, GRANT),
  tx("2030-05-05", "expense", 9999, LEISURE, { account_id: TFSA }),
  tx("2030-05-06", "transfer", 70000, null, { to_account_id: TFSA }),
  tx("2030-05-07", "expense", 777, LEISURE, { status: "deleted" }),
];

describe("the month in figures", () => {
  const r = report(rows, config, "2030-05", "2030-05-10", outside);

  it("spending is expenses less refunds; transfers, investment accounts and grants are left out", () => {
    expect(r).toMatchObject({ running: true, days: 10, length: 31, spentMinor: 159500, incomeMinor: 300000, count: 4, averageMinor: 40125,
      fixedMinor: 150000, variableMinor: 9500, dailyMinor: 950 });
    expect(r.savingsRate).toBeCloseTo(140500 / 300000);
    expect(r.biggest.map((t) => t.amount_minor)).toEqual([150000, 6000, 4000, 500]);
  });

  it("compares with the same days of last month while the month runs", () => {
    expect(r.previousSpentMinor).toBe(6000);
    expect(report(rows, config, "2030-04", "2030-06-01", outside)).toMatchObject({ running: false, days: 30, previousSpentMinor: null, noSpendOf: 30, spentMinor: 16000 });
  });

  it("no-spend days count the days gone, everyday spending only", () => {
    expect(r.noSpendOf).toBe(9);
    expect(r.noSpendDays).toBe(6);
    const w = [0, 0, 0, 0, 0, 0, 0];
    w[weekday("2030-05-01") - 1] += 4000; w[weekday("2030-05-03") - 1] += 6000; w[weekday("2030-05-04") - 1] -= 1000; w[weekday("2030-05-06") - 1] += 500;
    expect(r.weekdays).toEqual(w);
  });

  it("places bought from again and again, where it went, and budgets over", () => {
    expect(r.places).toEqual([{ name: "Fresh Market", count: 2, totalMinor: 10000 }]);
    expect(merchantName("FRESH MARKET #12")).toBe("Fresh Market");
    expect(r.top).toEqual([{ categoryId: RENT, amountMinor: 150000 }, { categoryId: GROCERIES, amountMinor: 9500 }]);
    expect(report(rows, config, "2030-05", "2030-05-10", outside, 100, 1).top).toEqual([{ categoryId: RENT, amountMinor: 150000 }, { categoryId: null, amountMinor: 9500 }]);
    expect(r).toMatchObject({ budgets: 2, budgetsOver: 1 });
  });

  it("against the usual: 20% and 10 units off the earlier months, cut to the same days", () => {
    expect(r.trends).toEqual([{ categoryId: GROCERIES, currentMinor: 9500, averageMinor: 5000, change: 0.9 }]);
  });

  it("who paid and whose share, and month by month", () => {
    expect(r.byMember).toEqual([{ memberId: ALICE, paidMinor: 160500, shareMinor: 157500 }, { memberId: BOB, paidMinor: 0, shareMinor: 3000 }]);
    expect(r.series).toEqual([
      { month: "2030-05", incomeMinor: 300000, expenseMinor: 159500, savingsMinor: 140500 },
      { month: "2030-04", incomeMinor: 0, expenseMinor: 16000, savingsMinor: -16000 },
    ]);
  });
});
