// SPDX-License-Identifier: GPL-3.0-or-later
// Money between the household's own accounts becomes a transfer, out of the
// totals. Every description here is invented.
import { describe, expect, it } from "vitest";
import { modelTransfer } from "@/lib/categorizer";
import { accountIdFor, propose, type ProposeInput } from "@/lib/importers";
import { monthSpendingSplit, monthTotals } from "@/lib/ledger";
import type { StatementLine } from "@/lib/importers";
import type { LocalRow } from "@/lib/sync";
import { NO_STATEMENT_TAG, UNMATCHED_TAG } from "@/lib/review";
import { matchTransfers } from "@/lib/transferMatch";
import { BANK_ACCOUNT, CREDIT_CARD, OTHER_ACCOUNT, isConsumerLender, isPersonToPerson, knownDebt, knownTransfer } from "@/lib/transfers";

import { ALICE, HOUSEHOLD, LEISURE, MAIN, SALARY, category, config } from "./support";

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
  ])("%s → %s", (text, amount, counterpart, direction, reason) => {
    expect(knownTransfer(text, amount)).toMatchObject({ counterpart, direction, reason });
  });

  it.each([
    ["Interac e-Transfer® Out to Example Friend", -5000], // to a person: spending
    ["Interac e-Transfer® In from Example Friend", 5000],
    ["Pre-authorized Debit to AFFIRM INC", -4970], // buy now, pay later: Debt payments, spending
    ["Pre-authorized Debit to SAMPLE AUTO LOAN", -32000], // loans too
    ["PAD EXAMPLE BANK LINE OF CREDIT", -5000],
    ["Pre-authorized Debit to NSLSC", -12000],
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

  it("never takes a PayPal Pay in 4 instalment for money to a person", () => {
    expect(isPersonToPerson("PAYPAL *PYPL PAYIN4 5550000000")).toBe(false);
    expect(isPersonToPerson("PayPal Pay in 4")).toBe(false);
    expect(isPersonToPerson("PAYPAL *EXAMPLE FRIEND")).toBe(true);
    expect(isConsumerLender("PAYPAL *PYPL PAYIN4 5550000000")).toBe(true);
  });

  it("knows the consumer lenders", () => {
    for (const t of ["AFFIRM INC", "easyfinancial", "Easy Financial Services", "AFTERPAY", "PayBright", "SEZZLE", "goPeer LP-0000", "UEI Financial", "MOGO"]) expect(isConsumerLender(t)).toBe(true);
    expect(isConsumerLender("EXAMPLE CREDIT UNION")).toBe(false);
  });
});

describe("debt payments", () => {
  it.each([
    ["Pre-authorized Debit to AFFIRM INC", "bnpl"],
    ["KLARNA LOAN PAYMENT", "bnpl"],
    ["Pre-authorized Debit to easyfinancial", "personal_loan"],
    ["Pre-authorized Debit to goPeer LP-0000", "personal_loan"],
    ["Pre-authorized Debit to UEI Financial", "personal_loan"],
    ["MOGO FINANCE PAD", "personal_loan"],
    ["PAD EXAMPLE BANK LINE OF CREDIT", "line_of_credit"],
    ["Pre-authorized Debit to NSLSC", "student_loan"],
    ["OSAP REPAYMENT", "student_loan"],
    ["Pre-authorized Debit to SAMPLE AUTO LOAN", "car_loan"],
    ["EXAMPLE TOYOTA FINANCIAL PAD", "car_loan"],
    ["EXAMPLE BANK LOAN PAYMENT", "other_debt"],
    // PayPal Pay in 4, however the card statement words it (made-up numbers).
    ["PAYPAL *PYPL PAYIN4 5550000000", "bnpl"],
    ["PAYPAL *PAY IN 4 5550000000", "bnpl"],
    ["PayPal Pay in 4", "bnpl"],
    ["PAYPAL PAY-IN-4 INSTALMENT", "bnpl"],
    ["PayPal Pay Later", "bnpl"],
  ])("%s → %s", (text, kind) => {
    expect(knownDebt(text, -10000)).toEqual({ kind });
  });

  it.each([
    ["Pre-authorized Debit to EXAMPLE MORTGAGE", -180000],
    ["EXAMPLE MTG LOAN PAYMENT", -180000],
    ["Online bill payment for NORTHWIND MASTERCARD, account ••••0000", -20000],
    ["Interac e-Transfer® Out to Example Friend", -5000],
    ["Example Coffee", -450],
    ["AFFIRM REFUND", 4970], // money in is never a repayment
    ["PAYPAL *PYPL PAYIN4 5550000000", 1949], // nor is a Pay in 4 refund
    ["PAYPAL *EXAMPLE SHOP 5550000000", -1949], // an ordinary PayPal purchase is not a plan
    ["PAYPAL *PAYMENTS4U EXAMPLE", -1949],
  ])("%s is not one", (text, amount) => {
    expect(knownDebt(text, amount)).toBeNull();
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
    { date: "2030-01-08", amountMinor: -32000, description: "Pre-authorized Debit to SAMPLE AUTO LOAN" },
  ];
  const DEBT = "00000000-0000-4000-8000-000000000301";
  const BNPL = "00000000-0000-4000-8000-000000000302";
  const CAR = "00000000-0000-4000-8000-000000000303";
  const withDebt = [
    ...config.categories,
    category(DEBT, "Debt payments", "expense", { fixed: true }),
    category(BNPL, "Buy now pay later", "expense", { parent_id: DEBT, fixed: true }),
    category(CAR, "Car loan", "expense", { parent_id: DEBT, fixed: true }),
  ];

  it("become transfers between the account and one named for the other end, made once", () => {
    const p = plan(lines);
    expect(p.map((x) => x.transaction.kind)).toEqual(["transfer", "transfer", "transfer", "expense", "transfer", "expense", "expense"]);
    const fund = accountIdFor(HOUSEHOLD, "Holiday Fund");
    expect(p[0].transaction).toMatchObject({ account_id: MAIN, to_account_id: fund, category_id: null, paid_by_member_id: null, split: null, recurrence: "variable" });
    expect(p[1].transaction).toMatchObject({ account_id: fund, to_account_id: MAIN });
    expect(p[2].transaction.to_account_id).toBe(accountIdFor(HOUSEHOLD, "NORTHWIND MASTERCARD"));
    // An account the household already has is used, not made again.
    expect(p[4].transaction.to_account_id).toBe(config.accounts.find((a) => a.name === "Cash")!.id);
    expect(p[0].source).toBeNull();
    expect(p[0].matchedTransfer).toMatchObject({ counterpart: "Holiday Fund", reason: "own-account" });
    // Without a Debt payments category, a repayment is spending in the catch-all.
    expect(p[3].transaction).toMatchObject({ kind: "expense", category_id: LEISURE });
    expect(p[6].transaction).toMatchObject({ kind: "expense", category_id: LEISURE });
    const made = new Map(p.flatMap((x) => x.newAccounts).map((a) => [a.id, a]));
    expect([...made.values()].map((a) => [a.name, a.type]).sort()).toEqual([["Holiday Fund", "other"], ["NORTHWIND MASTERCARD", "credit_card"]]);
  });

  it("repayments go to Debt payments, its subcategory when there is one, as fixed spending", () => {
    const p = plan(lines, { names: { categories: withDebt, members: config.members, accounts: config.accounts } });
    expect(p[3].transaction).toMatchObject({ kind: "expense", category_id: BNPL, recurrence: "fixed" });
    expect(p[3].source).toBe("debt");
    expect(p[3].matchedDebt).toEqual({ kind: "bnpl" });
    expect(p[6].transaction).toMatchObject({ kind: "expense", category_id: CAR, recurrence: "fixed" });
    expect(p[2].transaction.kind).toBe("transfer"); // a card bill stays a transfer
    const rows: LocalRow[] = p.map((x) => ({ tx: x.transaction, state: "synced", base: null }));
    expect(monthTotals(rows, "2030-01").spentMinor).toBe(4970 + 650 + 32000);
    expect(monthSpendingSplit(rows, "2030-01").fixedMinor).toBe(4970 + 32000);
  });

  it("a PayPal Pay in 4 card charge goes to Buy now pay later, before any categorizer", () => {
    const card: StatementLine[] = [
      { date: "2030-01-09", amountMinor: -1949, description: "PAYPAL *PYPL PAYIN4 5550000000" },
      { date: "2030-01-10", amountMinor: -2500, description: "PayPal Pay in 4" },
    ];
    const p = plan(card, { names: { categories: withDebt, members: config.members, accounts: config.accounts } });
    for (const x of p) {
      expect(x.transaction).toMatchObject({ kind: "expense", category_id: BNPL, recurrence: "fixed" });
      expect(x.source).toBe("debt");
      expect(x.matchedDebt).toEqual({ kind: "bnpl" });
    }
  });

  it("a rule can say a transfer has no other statement: it is never left unmatched", () => {
    const JAR = "00000000-0000-4000-8000-000000000390";
    const rules = [{ id: "r-jar", pattern: "example jar", action: { kind: "transfer" as const, to_account_id: JAR, tags: [NO_STATEMENT_TAG] }, sort: 0, active: true }];
    const p = plan([
      { date: "2030-01-09", amountMinor: -300, description: "Transfer out to Example Jar" },
      { date: "2030-01-09", amountMinor: -400, description: "Transfer out to Holiday Fund" },
    ], { rules });
    expect(p[0].transaction).toMatchObject({ kind: "transfer", account_id: MAIN, to_account_id: JAR, category_id: null });
    expect(p[0].transaction.tags).toContain(NO_STATEMENT_TAG);
    const m = matchTransfers({ accountId: MAIN, fresh: p.map((x) => x.transaction), existing: [], accounts: config.accounts });
    const jar = m.insert.find((t) => t.to_account_id === JAR)!;
    expect(jar.tags).not.toContain(UNMATCHED_TAG);
    // Out of spending, like any transfer; the transfer with no rule still waits for its other statement.
    const rows: LocalRow[] = m.insert.map((tx) => ({ tx, state: "synced", base: null }));
    expect(monthTotals(rows, "2030-01").spentMinor).toBe(0);
    expect(m.unmatched).toBe(1);
    expect(m.insert.find((t) => t.to_account_id !== JAR)!.tags).toContain(UNMATCHED_TAG);
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
    expect(monthTotals(rows, "2030-01")).toEqual({ spentMinor: 4970 + 650 + 32000, incomeMinor: 0 });
    const split = monthSpendingSplit(rows, "2030-01");
    expect(split.fixedMinor + split.flexibleMinor).toBe(4970 + 650 + 32000);
    expect(rows.filter((r) => r.tx.kind === "transfer")).toHaveLength(4);
  });
});

describe("the model's transfers", () => {
  const a = (parent: string, subcategory: string | null = null) => ({ parent, subcategory, spending: null });
  it("Transfers, Savings & Investing, and card-bill Debt Payments are transfers", () => {
    expect(modelTransfer(a("Transfers", "Account Transfer"), "EXAMPLE XFER 0001", "expense")).toEqual({ counterpart: OTHER_ACCOUNT, counterpartType: "other", direction: "out" });
    expect(modelTransfer(a("Transfers"), "EXAMPLE XFER 0001", "income")?.direction).toBe("in");
    expect(modelTransfer(a("Savings & Investing", "Brokerage"), "EXAMPLE INVEST", "expense")?.counterpart).toBe(OTHER_ACCOUNT);
    expect(modelTransfer(a("Debt Payments", "Credit Card Payment"), "EXAMPLE CARD CO", "expense")).toMatchObject({ counterpart: CREDIT_CARD, counterpartType: "credit_card" });
    expect(modelTransfer(a("Debt Payments", "Credit-Card"), "Online bill payment for EXAMPLE CARD", "expense")?.counterpartType).toBe("credit_card");
  });

  it("loan Debt Payments are spending, not transfers", () => {
    expect(modelTransfer(a("Debt Payments", "Personal Loan"), "EXAMPLE LENDING", "expense")).toBeNull();
    expect(modelTransfer(a("Debt Payments", "Student Loan"), "EXAMPLE LENDING", "expense")).toBeNull();
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

describe("e-Transfers with people", () => {
  it("are told apart from card purchases that only say Interac", async () => {
    const { isTransferWithPerson, personOf } = await import("@/lib/transfers");
    expect(isTransferWithPerson("Interac e-Transfer® Out to Example Person")).toBe(true);
    expect(isTransferWithPerson("INTERAC PURCHASE - EXAMPLE CAFE")).toBe(false);
    expect(personOf("Interac e-Transfer® Out to Example Person")).toBe("Example Person");
    expect(personOf("INTERAC E-TRANSFER FROM EXAMPLE PERSON")).toBe("EXAMPLE PERSON");
    expect(personOf("e-Transfer received from Example Person (ref 123456)")).toBe("Example Person");
    expect(personOf("EXAMPLE GROCER")).toBeNull();
  });
});

describe("an import with e-Transfers with people, insurance and interest", () => {
  const INS = "00000000-0000-4000-8000-000000000401";
  const LIFE = "00000000-0000-4000-8000-000000000402";
  const INTEREST = "00000000-0000-4000-8000-000000000403";
  const OTHER = "00000000-0000-4000-8000-000000000404";
  const cats = [
    ...config.categories,
    category(OTHER, "Other", "expense"),
    category(INS, "Insurance", "expense", { fixed: true }),
    category(LIFE, "Life insurance", "expense", { parent_id: INS, fixed: true }),
    category(INTEREST, "Interest", "income"),
  ];
  const names = { categories: cats, members: config.members, accounts: config.accounts };
  const lines: StatementLine[] = [
    { date: "2030-01-02", amountMinor: -5000, description: "Interac e-Transfer® Out to Example Person" },
    { date: "2030-01-03", amountMinor: 2500, description: "Interac e-Transfer® Received from Example Person" },
    { date: "2030-01-04", amountMinor: -650, description: "INTERAC PURCHASE - EXAMPLE COFFEE" },
    { date: "2030-01-05", amountMinor: -4211, description: "Pre-authorized Debit to RBCINS-LIFE" },
    { date: "2030-01-06", amountMinor: 12, description: "Interest earned" },
  ];
  it("sends e-Transfers with people to Review, and insurance and interest to their categories", async () => {
    const { REVIEW_TAG } = await import("@/lib/review");
    const p = plan(lines, { names, uncategorizedExpenseId: OTHER });
    expect(p.map((x) => !!x.personReview)).toEqual([true, true, false, false, false]);
    expect(p[0].transaction.tags).toContain(REVIEW_TAG);
    expect(p[0].transaction.note).toContain("Example Person");
    expect(p[2].transaction.tags).not.toContain(REVIEW_TAG);
    expect(p[3].transaction).toMatchObject({ category_id: LIFE, recurrence: "fixed" });
    expect(p[4].transaction.category_id).toBe(INTEREST);
  });
  it("leaves a person a rule sorts out of Review", async () => {
    const { REVIEW_TAG } = await import("@/lib/review");
    const rule = { id: "00000000-0000-4000-8000-000000000499", pattern: "Example Person", action: { category_id: LEISURE }, active: true, archived: false, sort: 0 };
    const p = plan(lines.slice(0, 1), { names, rules: [rule] as never, uncategorizedExpenseId: OTHER });
    expect(p[0].source).toBe("rule");
    expect(p[0].transaction.category_id).toBe(LEISURE);
    expect(p[0].transaction.tags).not.toContain(REVIEW_TAG);
  });
});
