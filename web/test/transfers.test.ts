// SPDX-License-Identifier: GPL-3.0-or-later
// Money between the household's own accounts becomes a transfer, out of the
// totals. Every description here is invented.
import { describe, expect, it } from "vitest";
import { modelTransfer } from "@/lib/categorizer";
import { accountIdFor, propose, type ProposeInput } from "@/lib/importers";
import { monthSpendingSplit, monthTotals } from "@/lib/ledger";
import type { StatementLine } from "@/lib/importers";
import type { LocalRow } from "@/lib/sync";
import { BANK_ACCOUNT, CREDIT_CARD, LOAN, OTHER_ACCOUNT, isConsumerLender, knownTransfer } from "@/lib/transfers";
import { ALICE, HOUSEHOLD, LEISURE, MAIN, SALARY, config } from "./support";

describe("known transfers", () => {
  it.each([
    ["Transfer out to Holiday Fund", -10000, "Holiday Fund", "out", "own-account"],
    ["Transfer out to Example TFSA", -2500, "Example TFSA", "out", "own-account"],
    ["Transfer out", -5000, OTHER_ACCOUNT, "out", "own-account"],
    ["Transfer in from Example Savings", 30000, "Example Savings", "in", "own-account"],
    ["Transfer in", 30000, OTHER_ACCOUNT, "in", "own-account"],
    ["Online bill payment for NORTHWIND MASTERCARD, account ••••0000 (executed at 2030-01-03)", -20000, "NORTHWIND MASTERCARD", "out", "card-payment"],
    ["Online bill payment for EXAMPLE BANK - VISA, account ••••0000", -20000, "EXAMPLE BANK - VISA", "out", "card-payment"],
    ["MASTERCARD BILL PAYMENT", -15000, "Mastercard", "out", "card-payment"],
    ["VISA PAYMENT 0001", -15000, "Visa", "out", "card-payment"],
    ["AMEX PMT", -15000, "American Express", "out", "card-payment"],
    ["CAPITAL ONE PAYMENT", -15000, "Capital One", "out", "card-payment"],
    ["CREDIT CARD PAYMENT", -15000, CREDIT_CARD, "out", "card-payment"],
    ["PAYMENT - THANK YOU", 15000, BANK_ACCOUNT, "in", "card-payment"],
    ["PAIEMENT - MERCI", 15000, BANK_ACCOUNT, "in", "card-payment"],
    ["Pre-authorized Debit to SAMPLE AUTO LOAN", -32000, "SAMPLE AUTO LOAN", "out", "loan"],
    ["PAD EXAMPLE BANK LINE OF CREDIT", -5000, LOAN, "out", "loan"],
    ["Pre-authorized Debit to NSLSC", -12000, "NSLSC", "out", "loan"],
  ])("%s → %s", (text, amount, counterpart, direction, reason) => {
    expect(knownTransfer(text, amount)).toMatchObject({ counterpart, direction, reason });
  });

  it.each([
    ["Interac e-Transfer® Out to Example Friend", -5000], // to a person: spending
    ["Interac e-Transfer® In from Example Friend", 5000],
    ["Pre-authorized Debit to AFFIRM INC", -4970], // buy now, pay later: the household decides
    ["Pre-authorized Debit to easyfinancial", -27500],
    ["KLARNA LOAN PAYMENT", -2000],
    ["Pre-authorized Debit to EXAMPLE MORTGAGE", -180000], // housing, not a transfer
    ["VISA DEBIT PURCHASE EXAMPLE STORE", -1999], // a purchase on a debit card
    ["MASTERCARD ANNUAL FEE", -12000],
    ["Online bill payment for EXAMPLE HYDRO, account ••••0000", -8000], // a bill, not a card
    ["Transfer out to Holiday Fund", 10000], // the wrong way round: a reversal, left alone
    ["Transfer in from Example Savings", -10000],
    ["PAYMENT - THANK YOU", -15000],
    ["Example Coffee", -450],
  ])("%s stays as it is", (text, amount) => {
    expect(knownTransfer(text, amount)).toBeNull();
  });

  it("knows the consumer lenders it leaves alone", () => {
    for (const t of ["AFFIRM INC", "easyfinancial", "Easy Financial Services", "AFTERPAY", "PayBright", "SEZZLE", "goPeer LP-0000"]) expect(isConsumerLender(t)).toBe(true);
    expect(isConsumerLender("EXAMPLE CREDIT UNION")).toBe(false);
  });
});

function plan(lines: StatementLine[], over: Partial<ProposeInput> = {}) {
  return propose({
    householdId: HOUSEHOLD, accountId: MAIN, lines, rules: [], uncategorizedExpenseId: LEISURE, uncategorizedIncomeId: SALARY,
    payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-02-01T00:00:00.000Z",
    names: { categories: config.categories, members: config.members, accounts: config.accounts },
    knownMerchants: true, knownTransfers: true, ...over,
  });
}

describe("transfers in an import", () => {
  const lines: StatementLine[] = [
    { date: "2030-01-02", amountMinor: -10000, description: "Transfer out to Holiday Fund" },
    { date: "2030-01-03", amountMinor: 30000, description: "Transfer in from Holiday Fund" },
    { date: "2030-01-04", amountMinor: -20000, description: "Online bill payment for NORTHWIND MASTERCARD, account ••••0000" },
    { date: "2030-01-05", amountMinor: -4970, description: "Pre-authorized Debit to AFFIRM INC" },
    { date: "2030-01-06", amountMinor: -5000, description: "Transfer out to Cash" },
    { date: "2030-01-07", amountMinor: -650, description: "Example Coffee" },
  ];

  it("become transfers between the account and one named for the other end, made once", () => {
    const p = plan(lines);
    expect(p.map((x) => x.transaction.kind)).toEqual(["transfer", "transfer", "transfer", "expense", "transfer", "expense"]);
    const fund = accountIdFor(HOUSEHOLD, "Holiday Fund");
    expect(p[0].transaction).toMatchObject({ account_id: MAIN, to_account_id: fund, category_id: null, paid_by_member_id: null, split: null, recurrence: "variable" });
    expect(p[1].transaction).toMatchObject({ account_id: fund, to_account_id: MAIN });
    expect(p[2].transaction.to_account_id).toBe(accountIdFor(HOUSEHOLD, "NORTHWIND MASTERCARD"));
    // An account the household already has is used, not made again.
    expect(p[4].transaction.to_account_id).toBe(config.accounts.find((a) => a.name === "Cash")!.id);
    expect(p[0].source).toBeNull();
    expect(p[0].matchedTransfer).toMatchObject({ counterpart: "Holiday Fund", reason: "own-account" });
    // The consumer lender is left as spending, to Other.
    expect(p[3].transaction).toMatchObject({ kind: "expense", category_id: LEISURE });
    const made = new Map(p.flatMap((x) => x.newAccounts).map((a) => [a.id, a]));
    expect([...made.values()].map((a) => [a.name, a.type]).sort()).toEqual([["Holiday Fund", "other"], ["NORTHWIND MASTERCARD", "credit_card"]]);
  });

  it("keep the same ids, so a file imported before is still recognised", () => {
    const before = plan(lines, { knownTransfers: false });
    const after = plan(lines, { existingIds: new Set(before.map((x) => x.transaction.id)) });
    expect(after.every((x) => x.alreadyImported)).toBe(true);
  });

  it("a household rule still comes first", () => {
    const p = plan([lines[0]], { rules: [{ id: "r1", pattern: "holiday fund", action: { category_id: LEISURE }, sort: 0, active: true }] });
    expect(p[0].transaction).toMatchObject({ kind: "expense", category_id: LEISURE });
  });

  it("stay out of spending, income and fixed/flexible, while still in the list", () => {
    const rows: LocalRow[] = plan(lines).map((x) => ({ tx: x.transaction, state: "synced", base: null }));
    expect(monthTotals(rows, "2030-01")).toEqual({ spentMinor: 4970 + 650, incomeMinor: 0 });
    const split = monthSpendingSplit(rows, "2030-01");
    expect(split.fixedMinor + split.flexibleMinor).toBe(4970 + 650);
    expect(rows.filter((r) => r.tx.kind === "transfer")).toHaveLength(4);
  });
});

describe("the model's transfers", () => {
  const a = (parent: string, subcategory: string | null = null) => ({ parent, subcategory, spending: null });
  it("Transfers, Savings & Investing, and card or loan Debt Payments are transfers", () => {
    expect(modelTransfer(a("Transfers", "Account Transfer"), "EXAMPLE XFER 0001", "expense")).toEqual({ counterpart: OTHER_ACCOUNT, counterpartType: "other", direction: "out" });
    expect(modelTransfer(a("Transfers"), "EXAMPLE XFER 0001", "income")?.direction).toBe("in");
    expect(modelTransfer(a("Savings & Investing", "Brokerage"), "EXAMPLE INVEST", "expense")?.counterpart).toBe(OTHER_ACCOUNT);
    expect(modelTransfer(a("Debt Payments", "Credit Card Payment"), "EXAMPLE CARD CO", "expense")).toMatchObject({ counterpart: CREDIT_CARD, counterpartType: "credit_card" });
    expect(modelTransfer(a("Debt Payments", "Personal Loan"), "EXAMPLE LENDING", "expense")?.counterpart).toBe(LOAN);
    expect(modelTransfer(a("Debt Payments", "Student Loan"), "EXAMPLE LENDING", "expense")?.counterpart).toBe(LOAN);
  });

  it("but never money to a person, a consumer lender, a mortgage or plain spending", () => {
    expect(modelTransfer(a("Transfers", "P2P Transfer"), "Interac e-Transfer® Out to Example Friend", "expense")).toBeNull();
    expect(modelTransfer(a("Debt Payments", "Personal Loan"), "Pre-authorized Debit to AFFIRM INC", "expense")).toBeNull();
    expect(modelTransfer(a("Debt Payments", "Installment Loan"), "easyfinancial", "expense")).toBeNull();
    expect(modelTransfer(a("Debt Payments", "Mortgage Loan"), "EXAMPLE HOMES", "expense")).toBeNull();
    expect(modelTransfer(a("Debt Payments", "Other Debt"), "EXAMPLE", "expense")).toBeNull();
    expect(modelTransfer(a("Groceries", "Supermarket"), "EXAMPLE GROCER", "expense")).toBeNull();
    expect(modelTransfer(a("Transfers"), "EXAMPLE", "refund")).toBeNull();
  });
});
