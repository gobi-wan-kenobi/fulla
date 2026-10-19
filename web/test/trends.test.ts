// SPDX-License-Identifier: GPL-3.0-or-later
// Trends: a category's spending month by month, its average and its change
// against the period before. Every amount and name here is invented.
import { describe, expect, it } from "vitest";
import { outsideTotals, type Account, type Category, type Transaction } from "@/lib/model";
import type { LocalRow } from "@/lib/sync";
import { changePercent, daysIn, previousRange, rangeFor, trend } from "@/lib/trends";
import { ALICE, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LEISURE = category(id(931), "Leisure", "expense");
const CINEMA = category(id(932), "Cinema", "expense", { parent_id: LEISURE.id });
const GROCERIES = category(id(933), "Groceries", "expense");
const FEES = category(id(934), "Fees", "expense");
const GRANTS = category(id(935), "Government grants", "income", { excluded_from_income: true });
const CATS: Category[] = [LEISURE, CINEMA, GROCERIES, FEES, GRANTS];
const acct = (n: number, type: Account["type"]): Account => ({ id: id(n), name: `Example ${type}`, type, opening_balance_minor: 0, sort: n, archived: false });
const CHEQUING = acct(601, "checking");
const BROKER = acct(602, "investment");
const OUT = outsideTotals(CATS, [CHEQUING, BROKER]);

let n = 1;
function tx(date: string, kind: Transaction["kind"], amount: number, categoryId: string | null, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: id(n++), kind, date, amount_minor: amount, category_id: categoryId, account_id: CHEQUING.id, to_account_id: null,
    paid_by_member_id: kind === "income" ? null : ALICE, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}
const rows = (txs: Transaction[]): LocalRow[] => txs.map((t) => ({ tx: t, state: "synced", base: null }));

describe("the ranges", () => {
  it("end today and include it: 90 days, 6 months, a year, or custom dates in either order", () => {
    expect(rangeFor("90d", "2030-05-15")).toEqual({ from: "2030-02-15", to: "2030-05-15" });
    expect(daysIn(rangeFor("90d", "2030-05-15"))).toBe(90);
    expect(rangeFor("6m", "2030-05-15")).toEqual({ from: "2029-11-16", to: "2030-05-15" });
    expect(rangeFor("1y", "2030-05-15")).toEqual({ from: "2029-05-16", to: "2030-05-15" });
    expect(rangeFor("6m", "2030-08-31")).toEqual({ from: "2030-03-01", to: "2030-08-31" }); // 28 Feb + 1
    expect(rangeFor("custom", "2030-05-15", { from: "2030-04-30", to: "2030-04-01" })).toEqual({ from: "2030-04-01", to: "2030-04-30" });
  });

  it("compare with the period of the same length just before", () => {
    const r = { from: "2030-03-01", to: "2030-03-31" };
    expect(previousRange(r)).toEqual({ from: "2030-01-29", to: "2030-02-28" });
    expect(daysIn(previousRange(r))).toBe(31);
  });
});

describe("a category's trend", () => {
  const txs = [
    tx("2030-01-20", "expense", 5000, LEISURE.id), // before the range: the previous period
    tx("2030-02-03", "expense", 4000, CINEMA.id),
    tx("2030-02-10", "expense", 3000, LEISURE.id),
    tx("2030-03-05", "expense", 6000, LEISURE.id),
    tx("2030-03-06", "refund", 1000, LEISURE.id), // nets against Leisure
    tx("2030-03-07", "refund", 2500, GROCERIES.id), // another category's refund: not here
    tx("2030-03-08", "expense", 2000, CINEMA.id), // a subcategory rolls into its parent
    tx("2030-03-09", "expense", 9000, GROCERIES.id),
    tx("2030-04-02", "expense", 1500, LEISURE.id),
    tx("2030-04-03", "expense", 800, LEISURE.id, { account_id: BROKER.id }), // inside an investment account
    tx("2030-04-04", "expense", 900, FEES.id, { account_id: BROKER.id }),
    tx("2030-04-05", "transfer", 50000, null, { to_account_id: BROKER.id }), // a transfer: never spending
    tx("2030-04-06", "income", 10000, GRANTS.id, { account_id: BROKER.id }),
    tx("2030-04-07", "expense", 700, LEISURE.id, { status: "deleted" }),
  ];
  const range = { from: "2030-02-10", to: "2030-04-10" }; // 60 days

  it("puts each month's spending in a bar, partial months marked, the parent taking its subcategories", () => {
    const t = trend(rows(txs), CATS, LEISURE.id, range, OUT);
    expect(t.months).toEqual([
      { month: "2030-02", amountMinor: 3000, partial: true, days: 19, recorded: true }, // the 3 Feb cinema is before the range
      { month: "2030-03", amountMinor: 6000 - 1000 + 2000, partial: false, days: 31, recorded: true },
      { month: "2030-04", amountMinor: 1500, partial: true, days: 10, recorded: true },
    ]);
    expect(t.totalMinor).toBe(11500);
    expect(t.count).toBe(5);
    expect(t.monthsWithData).toBe(3);
  });

  it("averages per month of the range's real length, so partial months do not drag it down", () => {
    const t = trend(rows(txs), CATS, LEISURE.id, range, OUT);
    expect(t.averageMinor).toBe(Math.round(11500 / (60 / (365.25 / 12))));
  });

  it("changes against the 60 days before, in money and per cent, once the records cover them", () => {
    const covered = [tx("2029-11-01", "expense", 1000, GROCERIES.id), ...txs];
    const t = trend(rows(covered), CATS, LEISURE.id, range, OUT);
    expect(t.previous).toEqual({ from: "2029-12-12", to: "2030-02-09" });
    expect(t.previousCoverage).toBe("full");
    expect(t.previousTotalMinor).toBe(5000 + 4000);
    expect(t.changeMinor).toBe(2500);
    expect(t.changeRatio).toBeCloseTo(2500 / 9000, 12);
    expect(changePercent(t.changeRatio)).toBe("+28 %");
  });

  it("does not compare with a previous period the records only partly cover", () => {
    const t = trend(rows(txs), CATS, LEISURE.id, range, OUT);
    expect(t.previousCoverage).toBe("partial"); // the records start on 20 Jan, inside the previous period
    expect(t.previousTotalMinor).toBe(9000);
    expect(t.changeMinor).toBeNull();
    expect(t.changeRatio).toBeNull();
  });

  it("marks months before the records start as not recorded, and averages from where they start", () => {
    const t = trend(rows(txs), CATS, LEISURE.id, { from: "2029-11-01", to: "2030-02-28" }, OUT);
    expect(t.months.map((m) => [m.month, m.recorded])).toEqual([["2029-11", false], ["2029-12", false], ["2030-01", true], ["2030-02", true]]);
    expect(t.totalMinor).toBe(5000 + 4000 + 3000);
    expect(t.averageMinor).toBe(Math.round(12000 / (daysIn({ from: "2030-01-20", to: "2030-02-28" }) / (365.25 / 12))));
  });

  it("takes a subcategory on its own, and all spending with every category", () => {
    expect(trend(rows(txs), CATS, CINEMA.id, range, OUT).totalMinor).toBe(2000);
    const all = trend(rows(txs), CATS, null, range, OUT);
    expect(all.totalMinor).toBe(3000 + 6000 - 1000 - 2500 + 2000 + 9000 + 1500);
  });

  it("says there is nothing to compare with rather than an infinite per cent", () => {
    const late = trend(rows(txs), CATS, LEISURE.id, { from: "2030-03-01", to: "2030-04-30" }, OUT);
    expect(late.previousCoverage).toBe("partial");
    const early = trend(rows(txs), CATS, LEISURE.id, { from: "2030-01-01", to: "2030-01-31" }, OUT);
    expect(early.previousHasData).toBe(false);
    expect(early.previousCoverage).toBe("none");
    expect(early.changeMinor).toBeNull();
    expect(early.changeRatio).toBeNull();
    expect(changePercent(early.changeRatio)).toBeNull();
    // Data in the previous period, but none of this category's spending: a change, no per cent.
    const groceries = trend(rows(txs), CATS, GROCERIES.id, { from: "2030-03-01", to: "2030-03-31" }, OUT); // the 31 days before: 29 Jan – 28 Feb
    expect(groceries.previousCoverage).toBe("full");
    expect(groceries.previousTotalMinor).toBe(0);
    expect(groceries.changeMinor).toBe(9000 - 2500);
    expect(groceries.changeRatio).toBeNull();
    expect(changePercent(-0.034)).toBe("−3 %");
    expect(changePercent(0.001)).toBe("0 %");
  });

  it("is empty with nothing in the range, and knows where the records start", () => {
    const t = trend(rows(txs), CATS, LEISURE.id, { from: "2029-01-01", to: "2029-06-30" }, OUT);
    expect(t.count).toBe(0);
    expect(t.averageMinor).toBe(0);
    expect(t.months).toHaveLength(6);
    expect(t.months.every((m) => m.amountMinor === 0 && !m.partial)).toBe(true);
    expect(t.dataFrom).toBe("2030-01-20");
    expect(trend([], CATS, null, range).dataFrom).toBeNull();
  });

  it("counts what is inside an investment account once it is no longer one", () => {
    const asSavings = outsideTotals(CATS, [CHEQUING, { ...BROKER, type: "savings" }]);
    expect(trend(rows(txs), CATS, LEISURE.id, range, asSavings).totalMinor).toBe(11500 + 800);
  });
});
