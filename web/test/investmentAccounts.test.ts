// SPDX-License-Identifier: GPL-3.0-or-later
// What happens inside an investment account (fees, taxes, fee refunds,
// income) is the account's: it moves the account's value, not the
// household's spending or income. Every amount and name here is invented.
import { describe, expect, it } from "vitest";
import { accountMonths, accountRows, monthSpendingSplit, monthTotals } from "@/lib/ledger";
import { type Account, type Category, type Transaction, outsideTotals } from "@/lib/model";
import { accountBalances, overview } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { ALICE, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FEES = category(id(911), "Fees", "expense");
const TAXES = category(id(912), "Taxes", "expense", { fixed: true });
const GROCERIES = category(id(913), "Groceries", "expense");
const SALARY = category(id(914), "Salary", "income");
const INTEREST = category(id(915), "Interest", "income");
const CATS: Category[] = [FEES, TAXES, GROCERIES, SALARY, INTEREST];
const acct = (n: number, name: string, type: Account["type"]): Account => ({ id: id(n), name, type, opening_balance_minor: 0, opening_balance_date: "2030-01-01", sort: n, archived: false });
const CHEQUING = acct(401, "Example chequing", "checking");
const BROKER = acct(402, "Example brokerage", "investment");
const ACCOUNTS = [CHEQUING, BROKER];

function tx(n: number, kind: Transaction["kind"], date: string, amount: number, categoryId: string | null, accountId: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: id(n), kind, date, amount_minor: amount, category_id: categoryId, account_id: accountId, to_account_id: null,
    paid_by_member_id: kind === "expense" || kind === "refund" ? ALICE : null, to_member_id: null, split: null, recurrence: "variable",
    note: "", tags: [], extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null,
    original_currency: null, created_at: `2030-03-01T00:00:${String(n % 60).padStart(2, "0")}Z`, client_updated_at: "", ...extra,
  };
}

const TXS = [
  tx(1, "income", "2030-03-01", 400000, SALARY.id, CHEQUING.id),
  tx(2, "expense", "2030-03-05", 12000, GROCERIES.id, CHEQUING.id),
  tx(3, "expense", "2030-03-06", 250, FEES.id, CHEQUING.id), // a bank fee on chequing: spending
  tx(4, "transfer", "2030-03-07", 50000, null, CHEQUING.id, { to_account_id: BROKER.id }), // money in: a transfer, never counted
  tx(5, "expense", "2030-03-10", 1500, FEES.id, BROKER.id), // a management fee inside the brokerage
  tx(6, "expense", "2030-03-11", 900, TAXES.id, BROKER.id, { recurrence: "fixed" }), // withholding tax inside it
  tx(7, "refund", "2030-03-12", 600, FEES.id, BROKER.id), // part of the fee given back
  tx(8, "income", "2030-03-15", 320, INTEREST.id, BROKER.id), // interest on its cash
  tx(9, "transfer", "2030-03-20", 10000, null, BROKER.id, { to_account_id: CHEQUING.id }), // money back out
  tx(10, "expense", "2030-02-10", 1100, FEES.id, BROKER.id), // last month's fee
];
const rows = (txs: Transaction[]): LocalRow[] => txs.map((t) => ({ tx: t, state: "synced", base: null }));

describe("an investment account's own fees, taxes, refunds and income", () => {
  it("are left out of the Overview's figures and its categories", () => {
    const v = overview(rows(TXS), CATS, "2030-03", "2030-04-01", ACCOUNTS);
    expect(v.figures.incomeMinor).toBe(400000);
    expect(v.figures.spentMinor).toBe(12000 + 250);
    expect(v.figures.fixedMinor).toBe(0);
    expect(v.figures.leftMinor).toBe(400000 - 12250);
    expect(v.categories.map((c) => [c.categoryId, c.amountMinor])).toEqual([[GROCERIES.id, 12000], [FEES.id, 250]]);
    // Last month's fee inside the brokerage is not "usually" either.
    expect(v.categories.find((c) => c.categoryId === FEES.id)!.usualMinor).toBe(0);
  });

  it("are left out of History's month totals and its fixed/flexible split", () => {
    const outside = outsideTotals(CATS, ACCOUNTS);
    expect(monthTotals(rows(TXS), "2030-03", outside)).toEqual({ spentMinor: 12250, incomeMinor: 400000 });
    expect(monthSpendingSplit(rows(TXS), "2030-03", outside)).toEqual({ fixedMinor: 0, flexibleMinor: 12250 });
    expect(monthTotals(rows(TXS), "2030-02", outside)).toEqual({ spentMinor: 0, incomeMinor: 0 });
  });

  it("still move the account's value", () => {
    const b = accountBalances(TXS, ACCOUNTS, [], "2030-03-31");
    expect(b.get(BROKER.id)).toBe(50000 - 1500 - 900 + 600 + 320 - 10000 - 1100);
    expect(b.get(CHEQUING.id)).toBe(400000 - 12000 - 250 - 50000 + 10000);
  });

  it("come back into the household's figures when the account is no longer an investment one", () => {
    const asSavings = ACCOUNTS.map((a) => (a.id === BROKER.id ? { ...a, type: "savings" as const } : a));
    const v = overview(rows(TXS), CATS, "2030-03", "2030-04-01", asSavings);
    expect(v.figures.spentMinor).toBe(12250 + 1500 + 900 - 600);
    expect(v.figures.fixedMinor).toBe(900);
    expect(v.figures.incomeMinor).toBe(400000 + 320);
    expect(v.categories.find((c) => c.categoryId === FEES.id)!.amountMinor).toBe(250 + 1500 - 600); // the refund nets against the fee
    expect(monthTotals(rows(TXS), "2030-03", outsideTotals(CATS, asSavings))).toEqual({ spentMinor: 14050, incomeMinor: 400320 });
  });
});

describe("an account's own page", () => {
  it("sums each month's fees (refunds netted), income and transfers, newest first", () => {
    expect(accountMonths(rows(TXS), BROKER.id)).toEqual([
      { month: "2030-03", feesMinor: 1500 + 900 - 600, incomeMinor: 320, transfersMinor: 50000 - 10000, count: 6 },
      { month: "2030-02", feesMinor: 1100, incomeMinor: 0, transfersMinor: 0, count: 1 },
    ]);
    const refundedMore = [...TXS, tx(11, "refund", "2030-03-25", 2000, FEES.id, BROKER.id)];
    expect(accountMonths(rows(refundedMore), BROKER.id)[0].feesMinor).toBe(1800 - 2000);
  });

  it("lists the account's rows, transfers into it included, newest first, deleted ones left out", () => {
    const withDeleted = [...TXS, tx(12, "expense", "2030-03-30", 77, FEES.id, BROKER.id, { status: "deleted" })];
    expect(accountRows(rows(withDeleted), BROKER.id).map((r) => r.tx.id)).toEqual([id(9), id(8), id(7), id(6), id(5), id(4), id(10)]);
    expect(accountRows(rows(TXS), CHEQUING.id).map((r) => r.tx.id)).toEqual([id(9), id(4), id(3), id(2), id(1)]);
  });
});
