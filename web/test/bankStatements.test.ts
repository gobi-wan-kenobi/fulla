// SPDX-License-Identifier: GPL-3.0-or-later
// Card and line of credit statements from more banks, a lender's CSV, lines
// already brought in by another file, and debt accounts in net worth. Every
// statement here is invented (bankStatementFixtures.ts).
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  type PdfJs, type StatementLine, debtTransfer, extractPdfPages, markOverlap, money, propose, readGoPeerCsv, readPdfStatement,
} from "@/lib/importers";
import { type Account, type Category, type Transaction, isDebtAccount } from "@/lib/model";
import { requireCurrency } from "@/lib/money";
import { UNMATCHED_TAG } from "@/lib/review";
import { groupOf } from "@/lib/networth";
import { proposedStatementAccount } from "@/lib/statementAccount";
import { rbcStyle, tangerineCardStyle, tangerineLocStyle, tdStyle, triangleStyle } from "./bankStatementFixtures";
import { creditLineInvestmentStyle } from "./statementPdfFixtures";
import { ALICE, HOUSEHOLD, category } from "./support";

const cad = requireCurrency("CAD");
const read = async (bytes: Uint8Array) => readPdfStatement(await extractPdfPages(bytes, pdfjs as unknown as PdfJs), cad);
const rows = (ls: StatementLine[]) => ls.map((l) => [l.date, l.amountMinor, l.role, l.description]);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const acct = (n: number, name: string, type: Account["type"], extra: Partial<Account> = {}): Account => ({
  id: id(n), name, type, opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false, ...extra,
});

describe("card statements from more banks", () => {
  it("reads an RBC-style card: a posting date run into its text, a foreign amount, the side panel left out", async () => {
    const r = await read(rbcStyle());
    expect(r.statement).toMatchObject({ institution: "RBC", type: "credit_card", last4: "0042", closingBalanceMinor: -116600, closingDate: "2030-02-12", periodStart: "2030-01-13" });
    expect(r.balance).toMatchObject({ ok: true, openingMinor: 100000, closingMinor: 116600 });
    expect(rows(r.lines)).toEqual([
      ["2030-01-14", -4100, null, "EXAMPLE CAFE TORONTO ON"],
      ["2030-01-20", -140500, null, "EXAMPLE HOTEL SAN FRANCISCOCA"],
      ["2030-01-25", 130000, "card-payment", "PAYMENT - THANK YOU / PAIEMENT - MERCI"],
      ["2030-01-28", 2000, "credit", "EXAMPLE SHOP TORONTO ON"],
      ["2030-02-12", -4000, "card-interest", "PURCHASE INTEREST 20.99%"],
    ]);
    expect(r.lines[1]).toMatchObject({ originalAmountMinor: 100000, originalCurrency: "USD" });
  });

  it("reads a TD-style card: a payment from another bank, a fee, a phone number under its shop", async () => {
    const r = await read(tdStyle());
    expect(r.statement).toMatchObject({ institution: "TD", last4: "0077", closingBalanceMinor: -33900, closingDate: "2030-04-22" });
    expect(r.balance.ok).toBe(true);
    expect(rows(r.lines)).toEqual([
      ["2030-03-30", -8500, null, "EXAMPLE GROCER TORONTO"],
      ["2030-04-02", 40000, "card-payment", "EXAMPLE BANK OF CANADA MONTREAL"],
      ["2030-04-11", -1500, null, "EXAMPLE TICKETS 416-555-0100"],
      ["2030-04-22", -13900, "fee", "ANNUAL FEE"],
    ]);
  });

  it("reads a Tangerine-style card: day-month-year dates, a description around its amount, rewards left out", async () => {
    const r = await read(tangerineCardStyle());
    expect(r.statement).toMatchObject({ institution: "Tangerine", last4: "0055", closingBalanceMinor: -73000, periodStart: "2029-12-21", closingDate: "2030-01-20" });
    expect(r.balance.ok).toBe(true);
    expect(r.lines[2]).toMatchObject({ originalAmountMinor: 6400, originalCurrency: "USD" });
    expect(rows(r.lines)).toEqual([
      ["2030-01-20", -1000, "card-interest", "PURCHASE INTEREST"],
      ["2030-01-19", -3000, null, "EXAMPLE CHARITY TORONTO ON"],
      ["2030-01-05", -9000, null, "EXAMPLE EMAIL GENEVA"],
      ["2030-01-02", 10000, "card-payment", "PAYMENT - THANK YOU"],
    ]);
  });

  it("reads a Triangle-style card and stops before the store's own list of what was bought", async () => {
    const r = await read(triangleStyle());
    expect(r.statement).toMatchObject({ institution: "Canadian Tire Bank", last4: "0099", closingBalanceMinor: -83500, periodStart: "2030-04-04", closingDate: "2030-05-03" });
    expect(r.balance.ok).toBe(true);
    expect(rows(r.lines)).toEqual([
      ["2030-04-29", 30000, "card-payment", "EXAMPLE TELEPAYMENTS"],
      ["2030-04-12", -6000, null, "EXAMPLE PHONE CO EDMONTON AB"],
      ["2030-04-19", -4000, null, "EXAMPLE SPORTS AJAX ON"],
      ["2030-05-03", -3500, "card-interest", "INTEREST CHARGES"],
    ]);
  });
});

describe("lines of credit and loans", () => {
  it("reads a Tangerine-style line of credit: what is owed, its interest, and the chequing account money moved with", async () => {
    const r = await read(tangerineLocStyle());
    expect(r.statement).toMatchObject({ institution: "Tangerine", type: "line_of_credit", last4: "0042", closingBalanceMinor: -121500, closingDate: "2030-08-31" });
    expect(r.balance).toMatchObject({ ok: true, openingMinor: 100000, closingMinor: 121500 });
    expect(rows(r.lines)).toEqual([
      ["2030-08-14", 10000, "transfer", "Payment from Example Chequing Account"],
      ["2030-08-23", -30000, "transfer", "Loan Advance to Example Chequing Account"],
      ["2030-08-31", -1500, "card-interest", "Interest (01 Aug 2030 - 31 Aug 2030)"],
    ]);
    expect(r.lines[0].counterpart).toBe("Example Chequing");
    expect(r.lines[2].debtKind).toBe("line_of_credit");
    const loc = proposedStatementAccount(HOUSEHOLD, [], r.statement);
    expect(loc.type).toBe("line_of_credit");
    expect(isDebtAccount(loc)).toBe(true);
  });

  it("reads a portfolio line of credit: balances printed $-1,000.00 and its interest charged", async () => {
    expect([money("$-1,100.00"), money("-$1,100.00"), money("$1,100.00")]).toEqual([-110000, -110000, 110000]);
    const r = await read(creditLineInvestmentStyle());
    expect(r.balance).toMatchObject({ ok: true, openingMinor: -100000, closingMinor: -90500 });
    expect(rows(r.lines)).toEqual([
      ["2030-03-10", 10000, "transfer", "Money transfer into the account"],
      ["2030-03-31", -500, "card-interest", "Margin Interest Charges"],
    ]);
    expect(r.lines[1].debtKind).toBe("line_of_credit");
  });

  it("reads a lender's activity export: completed moves only, payments into the loan", () => {
    const csv = [
      "Date,Type,Description,Stage,Amount",
      "2029/12/01,Loan Disbursement,Example loan,COMPLETED,-$5000.00",
      "2029/12/01,Loan Activation,Example loan,COMPLETED,$0.00",
      "2030/01/15,Loan Payment,Example loan,INITIATED,$200.00",
      "2030/01/17,Loan Payment,Example loan,COMPLETED,$200.00",
      "2030/02/17,Loan Payment,Example loan,COMPLETED,$200.00",
    ].join("\n");
    const all = readGoPeerCsv(csv)!;
    expect(rows(all.lines)).toEqual([
      ["2029-12-01", -500000, "transfer", "goPeer loan disbursement"],
      ["2030-01-17", 20000, "transfer", "goPeer loan payment"],
      ["2030-02-17", 20000, "transfer", "goPeer loan payment"],
    ]);
    expect(all.statement).toMatchObject({ institution: "goPeer", type: "loan", closingBalanceMinor: null });
    expect(readGoPeerCsv(csv, { from: "2030-01-01" })!.lines).toHaveLength(2);
    expect(readGoPeerCsv("Date,Description,Amount\n2030-01-01,x,1")).toBeNull();
  });

  it("makes a repayment to a lender the household holds a transfer into that loan", () => {
    const loan = acct(401, "Example loan", "loan", { institution: "Example Lender" });
    const pay: StatementLine = { date: "2030-01-17", amountMinor: -20000, description: "Pre-authorized Debit to Example Lender LP-0001", role: null };
    expect(debtTransfer(pay, [loan])).toMatchObject({ counterpart: "Example loan", counterpartType: "loan", direction: "out" });
    expect(debtTransfer({ ...pay, amountMinor: 20000 }, [loan])).toBeNull();
    expect(debtTransfer(pay, [])).toBeNull();
    expect(debtTransfer({ ...pay, description: "Pre-authorized Debit to Another Lender" }, [loan])).toBeNull();
  });

  it("counts lines of credit and loans with the cards, as debt", () => {
    for (const type of ["credit_card", "line_of_credit", "loan"] as const) expect(groupOf(acct(1, "x", type))).toBe("debt");
    expect(groupOf(acct(1, "x", "checking"))).toBe("cash");
    expect(isDebtAccount(acct(1, "x", "investment"))).toBe(false);
  });
});

describe("lines another file already brought in", () => {
  const OTHER: Category = category(id(901), "Other", "expense");
  const OTHER_IN: Category = category(id(902), "Other income", "income");
  const BANK = acct(301, "Everyday", "checking", { last4: "1111" });
  const row = (n: number, date: string, kind: Transaction["kind"], amount: number, note: string): Transaction => ({
    id: id(n), kind, date, amount_minor: amount, category_id: kind === "transfer" ? null : OTHER.id, account_id: BANK.id, to_account_id: kind === "transfer" ? id(399) : null,
    paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note, tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "",
  });
  const proposeLines = (lines: StatementLine[]) => propose({
    householdId: HOUSEHOLD, accountId: BANK.id, lines, rules: [], uncategorizedExpenseId: OTHER.id, uncategorizedIncomeId: OTHER_IN.id,
    payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-02-20T00:00:00.000Z",
    names: { categories: [OTHER, OTHER_IN], members: [], accounts: [BANK] }, knownMerchants: true, knownTransfers: true,
  });

  it("marks lines the account already holds, each row answering for one line", () => {
    const held = [
      row(1, "2030-01-05", "expense", 450, "Coffee"),
      row(2, "2030-01-07", "transfer", 10000, "Transfer out"),
      row(3, "2030-01-09", "expense", 2500, "EXAMPLE BOOKS"),
    ];
    const lines: StatementLine[] = [
      { date: "2030-01-05", amountMinor: -450, description: "EXAMPLE COFFEE", role: null },
      { date: "2030-01-05", amountMinor: -450, description: "EXAMPLE COFFEE", role: null },
      { date: "2030-01-07", amountMinor: -10000, description: "Transfer out to Example", role: null },
      { date: "2030-01-11", amountMinor: -2500, description: "Example Books Toronto", role: null },
      { date: "2030-01-11", amountMinor: 2500, description: "Example refund", role: null },
    ];
    const out = markOverlap(proposeLines(lines), held, BANK.id);
    expect(out.overlapped).toBe(3);
    expect(out.proposals.map((p) => p.alreadyImported)).toEqual([true, false, true, true, false]);
  });

  it("leaves a transfer still waiting for its other statement to transfer matching, unless the texts agree", () => {
    const waiting = { ...row(4, "2030-01-14", "transfer", 30000, "Online bill payment for EXAMPLE MASTERCARD"), tags: [UNMATCHED_TAG] };
    // The card's statement: its payment line is the other leg, not the same line.
    const card = markOverlap(proposeLines([{ date: "2030-01-14", amountMinor: -30000, description: "PAYMENT RECEIVED - THANK YOU", role: null }]), [waiting], BANK.id);
    expect(card.overlapped).toBe(0);
    // The bank's own statement after its CSV: the same line.
    const bank = markOverlap(proposeLines([{ date: "2030-01-14", amountMinor: -30000, description: "Online bill payment for EXAMPLE MASTERCARD", role: null }]), [waiting], BANK.id);
    expect(bank.overlapped).toBe(1);
  });

  it("knows a transfer's other leg by the statement it was read from, whatever the texts say", () => {
    const CARD = acct(302, "Example card", "credit_card", { last4: "2222" });
    const fromBank = (n: number, date: string, kind: Transaction["kind"], amount: number, note: string, to: string | null): Transaction =>
      ({ ...row(n, date, kind, amount, note), to_account_id: to, tags: ["fulla:st:000000000001:v1", ...(kind === "transfer" ? [UNMATCHED_TAG] : [])] });
    const rows = [fromBank(5, "2030-01-14", "transfer", 30000, "Pre-authorized Debit to EXAMPLE CARD", CARD.id), fromBank(6, "2030-01-15", "expense", 900, "EXAMPLE SHOP", null)];
    const card = markOverlap(propose({
      householdId: HOUSEHOLD, accountId: CARD.id, lines: [{ date: "2030-01-14", amountMinor: 30000, description: "EXAMPLE CARD PAYMENT", role: null }], rules: [],
      uncategorizedExpenseId: OTHER.id, uncategorizedIncomeId: OTHER_IN.id, payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-02-20T00:00:00.000Z",
      names: { categories: [OTHER, OTHER_IN], members: [], accounts: [BANK, CARD] }, knownMerchants: true, knownTransfers: true,
    }), rows, CARD.id);
    expect(card.overlapped).toBe(0);
    const bank = markOverlap(proposeLines([{ date: "2030-01-14", amountMinor: -30000, description: "Pre-authorized Debit to EXAMPLE CARD", role: null }]), rows, BANK.id);
    expect(bank.overlapped).toBe(1);
  });

  it("does not take a row two days off when nothing in the text is the same", () => {
    const out = markOverlap(proposeLines([{ date: "2030-01-11", amountMinor: -2500, description: "Something else", role: null }]),
      [row(3, "2030-01-09", "expense", 2500, "EXAMPLE BOOKS")], BANK.id);
    expect(out.overlapped).toBe(0);
  });
});
