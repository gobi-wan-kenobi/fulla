// SPDX-License-Identifier: GPL-3.0-or-later
// The Overview's figures. Invented households and amounts only.
import { describe, expect, it } from "vitest";
import type { Account, Category, Transaction } from "@/lib/model";
import { accountBalances, byCategory, holdings, monthFigures, overview, wholePercents } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { category } from "./support";

const FOOD = "00000000-0000-4000-8000-000000000a01";
const SNACK = "00000000-0000-4000-8000-000000000a02";
const DEBT = "00000000-0000-4000-8000-000000000a03";
const LOAN = "00000000-0000-4000-8000-000000000a04";
const PAY = "00000000-0000-4000-8000-000000000a05";
const A = "00000000-0000-4000-8000-000000000b01";
const B = "00000000-0000-4000-8000-000000000b02";
const cats: Category[] = [
  category(FOOD, "Groceries", "expense"),
  category(SNACK, "Snacks", "expense", { parent_id: FOOD }),
  category(DEBT, "Debt payments", "expense", { fixed: true }),
  category(LOAN, "Personal loan", "expense", { parent_id: DEBT, fixed: true }),
  category(PAY, "Salary", "income"),
];
let n = 0;
function tx(kind: Transaction["kind"], date: string, amount: number, extra: Partial<Transaction> = {}): Transaction {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, kind, date, amount_minor: amount, category_id: null, account_id: A, to_account_id: null,
    paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {}, status: "active",
    recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}
const rows = (txs: Transaction[]): LocalRow[] => txs.map((t) => ({ tx: t, state: "synced", base: null }));

const month = [
  tx("income", "2030-03-01", 300000, { category_id: PAY }),
  tx("expense", "2030-03-02", 10000, { category_id: FOOD }),
  tx("expense", "2030-03-03", 2500, { category_id: SNACK }),
  tx("refund", "2030-03-04", 500, { category_id: FOOD }),
  tx("expense", "2030-03-05", 40000, { category_id: LOAN, recurrence: "fixed" }),
  tx("transfer", "2030-03-06", 99999, { to_account_id: B }),
  tx("expense", "2030-03-07", 1000),
  tx("expense", "2030-04-01", 7777, { category_id: FOOD }),
];

describe("the Overview", () => {
  it("counts income, spending less refunds, what is left and its share; never transfers", () => {
    const f = monthFigures(month, "2030-03");
    expect(f).toEqual({ incomeMinor: 300000, spentMinor: 53000, leftMinor: 247000, savingsRate: 247000 / 300000, fixedMinor: 40000, flexibleMinor: 13000 });
    expect(monthFigures([], "2030-03").savingsRate).toBeNull();
    expect(monthFigures([tx("expense", "2030-03-01", 500)], "2030-03").leftMinor).toBe(-500);
  });

  it("rolls categories up to their parent, Debt payments included, largest first, with subcategories", () => {
    const c = byCategory(month, cats, "2030-03");
    expect(c.map((r) => [r.categoryId, r.amountMinor])).toEqual([[DEBT, 40000], [FOOD, 12000], [null, 1000]]);
    expect(c[0]).toMatchObject({ fixedMinor: 40000, flexibleMinor: 0, subs: [{ categoryId: LOAN, amountMinor: 40000 }] });
    expect(c[1].subs).toEqual([{ categoryId: FOOD, amountMinor: 9500 }, { categoryId: SNACK, amountMinor: 2500 }]);
    expect(c[2].subs).toEqual([]);
    expect(c.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1);
  });

  it("says what a category usually is, from up to three earlier months with anything in them", () => {
    const earlier = [tx("expense", "2030-01-10", 6000, { category_id: FOOD }), tx("expense", "2030-02-10", 2000, { category_id: SNACK })];
    const c = byCategory([...month, ...earlier], cats, "2030-03");
    expect(c.find((r) => r.categoryId === FOOD)?.usualMinor).toBe(4000);
    expect(c.find((r) => r.categoryId === DEBT)?.usualMinor).toBe(0);
  });

  it("leaves out deleted and refused rows, and knows a running month", () => {
    const r = rows(month);
    r[1] = { ...r[1], state: "rejected" };
    r[2] = { ...r[2], tx: { ...r[2].tx, status: "deleted" } };
    const o = overview(r, cats, "2030-03", "2030-03-15");
    expect(o.running).toBe(true);
    expect(o.figures.spentMinor).toBe(53000 - 12500);
    expect(overview(r, cats, "2030-03", "2030-04-02").running).toBe(false);
  });

  it("gives whole percentages that add up to 100", () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
    expect(wholePercents([40000, 12000, 1000]).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("works out what the accounts hold from a statement balance or an opening balance", () => {
    const acct = (id: string, extra: Partial<Account> = {}): Account => ({ id, name: id, type: "checking", opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false, ...extra });
    const accounts = [acct(A), acct(B, { opening_balance_minor: 5000, opening_balance_date: "2030-03-01" })];
    const snap = [{ account_id: A, as_of: "2030-03-05", balance_minor: 100000 }];
    const b = accountBalances(month, accounts, snap, "2030-03-31");
    // A: the statement's 1,000.00 on the 5th, then the transfer out and the 10.00 expense after it.
    expect(b.get(A)).toBe(100000 - 99999 - 1000);
    // B: its opening balance, then the transfer in.
    expect(b.get(B)).toBe(5000 + 99999);
    expect(holdings(rows(month), accounts, snap, "2030-03-31")?.totalMinor).toBe(100000 - 1000 + 5000);
    expect(holdings(rows(month), [acct(A)], [], "2030-03-31")).toBeNull();
    // A statement after the day asked about is not used.
    expect(holdings(rows(month), [acct(A)], snap, "2030-03-01")).toBeNull();
  });
});
