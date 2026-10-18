// SPDX-License-Identifier: GPL-3.0-or-later
// Card and investment statements, from PDF to the rows an import writes.
// Every statement, account, shop and amount here is invented.
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  type PdfJs, type StatementAccountInfo, type StatementLine, PdfStatementError, accountTail, buildImport, extractPdfPages, foreignAmount,
  money, newAccounts, propose, readPdfStatement, statementKey,
} from "@/lib/importers";
import type { Account, Category, Transaction } from "@/lib/model";
import { requireCurrency } from "@/lib/money";
import { UNMATCHED_TAG, hasTag } from "@/lib/review";
import { proposedStatementAccount } from "@/lib/statementAccount";
import { amexStyle, capitalOneStyle, investmentStyle, singleCurrencyInvestmentStyle } from "./statementPdfFixtures";
import { makePdf } from "./pdfFixture";
import { ALICE, HOUSEHOLD, category } from "./support";

const cad = requireCurrency("CAD");
const lib = pdfjs as unknown as PdfJs;
const read = async (bytes: Uint8Array) => readPdfStatement(await extractPdfPages(bytes, lib), cad);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OTHER = category(id(901), "Other", "expense");
const OTHER_IN = category(id(902), "Other income", "income");
const DEBT = category(id(903), "Debt payments", "expense", { fixed: true });
const CARD_INTEREST = category(id(904), "Credit card interest", "expense", { parent_id: DEBT.id });
const FEES = category(id(905), "Fees", "expense");
const INVEST = category(id(906), "Investment income", "income");
const INTEREST = category(id(907), "Interest", "income");
const CATEGORIES: Category[] = [OTHER, OTHER_IN, DEBT, CARD_INTEREST, FEES, INVEST, INTEREST];
const acct = (n: number, name: string, type: Account["type"], extra: Partial<Account> = {}): Account => ({
  id: id(n), name, type, opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false, ...extra,
});
const CHEQUING = acct(301, "Everyday", "checking", { last4: "1111" });

function proposeInto(accountId: string, lines: StatementLine[], rows: Transaction[], accounts: Account[]) {
  return propose({
    householdId: HOUSEHOLD, accountId, lines, rules: [], uncategorizedExpenseId: OTHER.id, uncategorizedIncomeId: OTHER_IN.id,
    payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(rows.map((r) => r.id)), now: "2030-02-20T00:00:00.000Z",
    names: { categories: CATEGORIES, members: [], accounts }, knownMerchants: true, knownTransfers: true,
  });
}
function importInto(accountId: string, lines: StatementLine[], rows: Transaction[], accounts: Account[], statement: StatementAccountInfo | null = null, proposed: Account | null = null) {
  const proposals = proposeInto(accountId, lines, rows, accounts);
  const out = buildImport({
    householdId: HOUSEHOLD, categories: CATEGORIES, accounts, rows, proposals, createdAccounts: newAccounts(proposals),
    accountId, proposedAccount: proposed, statement, answers: {},
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const u of out.update) byId.set(u.id, u);
  for (const t of out.insert) byId.set(t.id, t);
  return { ...out, proposals, rows: [...byId.values()] };
}

describe("reading statements", () => {
  it("reads money and foreign amounts as statements print them", () => {
    expect([money("$1,234.56"), money("-120.00"), money("- $350.00"), money("+ $0.00"), money("= $2,527.36"), money(".99"), money("$45.56 CAD")])
      .toEqual([123456, -12000, -35000, 0, 252736, 99, 4556]);
    expect([money("1.99167%"), money("2.1953"), money("Jan 5")]).toEqual([null, null, null]);
    expect(foreignAmount("UNITED STATES DOLLAR 20.00 @ 1.41200")).toEqual({ amountMinor: 2000, currency: "USD" });
    expect(foreignAmount("EURO .99 @ 1.5")).toEqual({ amountMinor: 99, currency: "EUR" });
    expect(foreignAmount("Reference EXAMPLE")).toBeNull();
    expect(accountTail("ZZ9EXAMPLE1CAD")).toBe("PLE1");
  });

  it("reads an American Express-style card and checks it adds up to the new balance", async () => {
    const r = await read(amexStyle());
    expect(r.kind).toBe("card");
    expect(r.statement).toMatchObject({
      institution: "American Express", type: "credit_card", last4: "2345", closingBalanceMinor: -96500, closingDate: "2030-02-16",
      periodStart: "2030-01-17", label: "American Express Example Rewards",
    });
    expect(r.balance).toMatchObject({ ok: true, openingMinor: 100000, closingMinor: 96500 });
    expect(r.lines.map((l) => [l.date, l.amountMinor, l.role ?? null, l.description])).toEqual([
      ["2030-01-20", 20000, "card-payment", "PAYMENT RECEIVED - THANK YOU"],
      ["2030-01-22", -2450, null, "EXAMPLE CAFE TORONTO"],
      ["2030-01-25", -7000, null, "EXAMPLE SOFTWARE SAN FRANCISCO"],
      ["2030-02-02", -4000, null, "EXAMPLE GROCER TORONTO"],
      ["2030-02-05", 1000, "credit", "EXAMPLE CAFE TORONTO"],
      ["2030-02-16", -2500, "fee", "ANNUAL FEE"],
      ["2030-02-16", -1550, "card-interest", "INTEREST"],
    ]);
    expect(r.lines[2]).toMatchObject({ originalAmountMinor: 5000, originalCurrency: "USD" });
    // Only the last four digits of the card leave the reader.
    expect(JSON.stringify(r)).not.toMatch(/12345/);
    // A line misread or missing: the new balance is not reached.
    expect((await read(amexStyle({ newBalance: "$966.00" }))).balance.ok).toBe(false);
  });

  it("reads a Capital One-style card", async () => {
    const r = await read(capitalOneStyle());
    expect(r.statement).toMatchObject({ institution: "Capital One", type: "credit_card", last4: "0042", closingBalanceMinor: -26999, closingDate: "2030-02-20", label: "Capital One Mastercard" });
    expect(r.balance.ok).toBe(true);
    expect(r.lines.map((l) => [l.date, l.amountMinor, l.role ?? null])).toEqual([["2030-01-30", 30000, "card-payment"], ["2030-02-03", -6000, null], ["2030-02-19", -999, "card-interest"]]);
  });

  it("reads an investment statement's cash in and out, leaves trades out, and keeps the market value", async () => {
    const r = await read(investmentStyle({ version: 2 }));
    expect(r.kind).toBe("investment");
    expect(r.statement).toMatchObject({
      institution: "Wealthsimple", type: "investment", last4: "PLE1", closingBalanceMinor: 500000, closingDate: "2030-01-31",
      periodStart: "2030-01-01", label: "Wealthsimple TFSA", version: 2,
    });
    expect(r.balance.ok).toBe(true);
    expect(r.ignored).toBe(2);
    expect(r.lines.map((l) => [l.date, l.amountMinor, l.role, l.description, l.originalAmountMinor ?? null, l.originalCurrency ?? null])).toEqual([
      ["2030-01-05", 20000, "transfer", "Contribution", null, null],
      ["2030-01-20", 300, "dividend", "EXAMPLE ETF: Cash dividend distribution", null, null],
      ["2030-01-10", 70, "dividend", "EXAMPLECO: Cash dividend distribution", 50, "USD"],
      ["2030-01-10", -14, "fee", "Non-resident tax", 10, "USD"],
    ]);
    expect((await read(investmentStyle())).statement.version).toBe(1);
  });

  it("reads a statement in one currency, its activity over several pages, and a fee given back", async () => {
    const r = await read(singleCurrencyInvestmentStyle());
    expect(r.statement).toMatchObject({
      institution: "Wealthsimple", type: "investment", last4: "PLE7", closingBalanceMinor: 123456, closingDate: "2030-02-28",
      periodStart: "2030-02-01", label: "Wealthsimple Non-registered", version: 1,
    });
    expect(r.balance).toMatchObject({ ok: true, openingMinor: 500, closingMinor: 510, mismatches: [] });
    expect(r.ignored).toBe(1); // the purchase
    expect(r.lines.map((l) => [l.date, l.amountMinor, l.role, l.description])).toEqual([
      ["2030-02-02", 40, "dividend", "EXAMPLECO: Cash dividend distribution"],
      ["2030-02-03", 13, "fee", "MANAGEMENT_FEE_REIMBURSEMENT"],
      ["2030-02-07", 10000, "transfer", "Money transfer into the account"],
      ["2030-02-09", -5, "fee", "Non-resident tax"],
      ["2030-02-28", -38, "fee", "Example Portfolio Service Fee"],
    ]);
  });

  it("says when a PDF is a statement Fulla does not read", async () => {
    await expect(read(makePdf([[{ x: 40, y: 500, text: "Example Bank: your monthly statement" }]]))).rejects.toThrow(PdfStatementError);
  });
});

describe("importing card and investment statements", () => {
  it("sorts card lines: payments are transfers from the bank, interest is debt, fees are fees, credits reduce spending, foreign amounts kept", async () => {
    const r = await read(amexStyle());
    const card = proposedStatementAccount(HOUSEHOLD, [CHEQUING], r.statement);
    expect(card).toMatchObject({ name: "American Express Example Rewards ••2345", type: "credit_card", last4: "2345" });
    const p = proposeInto(card.id, r.lines, [], [CHEQUING, card]);
    const by = (d: string) => p.find((x) => x.line.description === d && x.line.amountMinor === r.lines.find((l) => l.description === d)!.amountMinor)!.transaction;
    const pay = by("PAYMENT RECEIVED - THANK YOU");
    expect(pay.kind).toBe("transfer");
    expect(pay.to_account_id).toBe(card.id);
    expect(by("INTEREST").category_id).toBe(CARD_INTEREST.id);
    expect(by("ANNUAL FEE").category_id).toBe(FEES.id);
    expect(p.find((x) => x.line.role === "credit")!.transaction.kind).toBe("refund");
    expect(by("EXAMPLE SOFTWARE SAN FRANCISCO")).toMatchObject({ kind: "expense", amount_minor: 7000, original_amount_minor: 5000, original_currency: "USD" });
  });

  it("matches a card's payment to the bill paid from chequing, pointing the stand-in at the card", async () => {
    const r = await read(amexStyle());
    const card = proposedStatementAccount(HOUSEHOLD, [CHEQUING], r.statement);
    const standIn = acct(310, "EXAMPLE CARDS", "credit_card");
    const bill: Transaction = {
      id: id(501), kind: "transfer", date: "2030-01-19", amount_minor: 20000, category_id: null, account_id: CHEQUING.id, to_account_id: standIn.id,
      paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "Online bill payment for EXAMPLE CARDS", tags: [UNMATCHED_TAG],
      extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: "a".repeat(64), original_currency: null,
      created_at: "", client_updated_at: "",
    };
    const spend: Transaction = { ...bill, id: id(502), kind: "expense", to_account_id: null, amount_minor: 500, category_id: OTHER.id, tags: [], note: "EXAMPLE SHOP", import_fingerprint: "b".repeat(64) };
    const out = importInto(card.id, r.lines, [bill, spend], [CHEQUING, standIn], r.statement, card);
    expect(out.matched).toBe(1);
    const joined = out.rows.find((t) => t.id === bill.id)!;
    expect(joined.to_account_id).toBe(card.id);
    expect(hasTag(joined, UNMATCHED_TAG)).toBe(false);
    expect(out.rows.filter((t) => t.kind === "transfer" && t.status === "active")).toHaveLength(1);
  });

  it("matches a contribution to a generic transfer out, never to a stand-in named for another kind of account", async () => {
    const r = await read(investmentStyle());
    const tfsa = proposedStatementAccount(HOUSEHOLD, [CHEQUING], r.statement);
    expect(tfsa.name).toBe("Wealthsimple TFSA ••PLE1");
    expect(tfsa.type).toBe("investment");
    const resp = acct(311, "Family RESP", "other");
    const other = acct(312, "Other account", "other");
    const out1 = (to: string, n: number): Transaction => ({
      id: id(n), kind: "transfer", date: "2030-01-05", amount_minor: 20000, category_id: null, account_id: CHEQUING.id, to_account_id: to,
      paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "Transfer out", tags: [UNMATCHED_TAG], extras: {},
      status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: String(n).repeat(8), original_currency: null, created_at: "", client_updated_at: "",
    });
    const spend: Transaction = { ...out1(CHEQUING.id, 520), kind: "expense", to_account_id: null, amount_minor: 1, category_id: OTHER.id, tags: [], note: "EXAMPLE SHOP" };
    // The RESP's transfer first, so only the names decide.
    const rows = [out1(resp.id, 511), out1(other.id, 512), spend];
    const out = importInto(tfsa.id, r.lines, rows, [CHEQUING, resp, other], r.statement, tfsa);
    expect(out.matched).toBe(1);
    expect(out.rows.find((t) => t.id === id(512))!.to_account_id).toBe(tfsa.id);
    expect(hasTag(out.rows.find((t) => t.id === id(511))!, UNMATCHED_TAG)).toBe(true);
    // Dividends are investment income; tax withheld is a fee.
    expect(out.insert.filter((t) => t.kind === "income").map((t) => t.category_id)).toEqual([INVEST.id, INVEST.id]);
    expect(out.insert.find((t) => t.kind === "expense")!.category_id).toBe(FEES.id);
  });

  it("matches an activity export's deposits to the chequing transfers into a stand-in, and never pairs two transfers out", () => {
    const resp = acct(330, "Example RESP", "investment");
    const out = (n: number, date: string, amount: number, to: string): Transaction => ({
      id: id(n), kind: "transfer", date, amount_minor: amount, category_id: null, account_id: CHEQUING.id, to_account_id: to,
      paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "Transfer out", tags: [UNMATCHED_TAG], extras: {},
      status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: String(n).repeat(8), original_currency: null, created_at: "", client_updated_at: "",
    });
    // Two transfers out of chequing on one day, same amount, to the RESP and to another stand-in: only the RESP's is matched.
    const other = acct(331, "Other account", "other");
    const spend: Transaction = { ...out(530, "2030-03-02", 450, CHEQUING.id), kind: "expense", to_account_id: null, category_id: OTHER.id, tags: [], note: "EXAMPLE SHOP" };
    const rows = [out(531, "2030-03-07", 10000, resp.id), out(532, "2030-03-07", 10000, other.id), out(533, "2030-03-14", 10000, resp.id), spend];
    const lines: StatementLine[] = [
      { date: "2030-03-07", amountMinor: 10000, description: "Deposit", role: "transfer" },
      { date: "2030-03-14", amountMinor: 10000, description: "Deposit", role: "transfer" },
      { date: "2030-03-14", amountMinor: 2000, description: "Grant payment", role: "dividend" },
      { date: "2030-03-31", amountMinor: 13, description: "MANAGEMENT_FEE_REIMBURSEMENT", role: "fee" },
    ];
    const info: StatementAccountInfo = { institution: "Wealthsimple", type: "investment", last4: null, closingBalanceMinor: null, closingDate: "2030-03-31", periodStart: "2030-03-01", version: 1 };
    const r = importInto(resp.id, lines, rows, [CHEQUING, resp, other], info);
    expect(r.matched).toBe(2);
    expect(r.unmatched).toBe(0);
    const live = r.rows.filter((t) => t.status === "active");
    expect(live.filter((t) => t.kind === "transfer").map((t) => [t.id, t.account_id, t.to_account_id, hasTag(t, UNMATCHED_TAG)])).toEqual([
      [id(531), CHEQUING.id, resp.id, false], [id(532), CHEQUING.id, other.id, true], [id(533), CHEQUING.id, resp.id, false],
    ]);
    // Never a transfer out of one account paired with another transfer out.
    expect(live.filter((t) => t.kind === "transfer" && t.account_id === resp.id)).toEqual([]);
    expect(live.find((t) => t.kind === "income")!.category_id).toBe(INVEST.id);
    // A fee given back is less spent on fees.
    expect(live.find((t) => t.kind === "refund")).toMatchObject({ category_id: FEES.id, amount_minor: 13 });
  });

  it("replaces an earlier version of the same statement, and ignores an earlier one imported after a later", () => {
    const tfsa = acct(320, "Example TFSA", "other", { last4: "PLE1" });
    const info = (version: number): StatementAccountInfo => ({ institution: "Example Broker", type: "other", last4: "PLE1", closingBalanceMinor: 1, closingDate: "2030-01-31", periodStart: "2030-01-01", version });
    const v1: StatementLine[] = [
      { date: "2030-01-05", amountMinor: 20000, description: "Contribution", role: "transfer" },
      { date: "2030-01-20", amountMinor: 300, description: "EXAMPLE ETF: Cash dividend distribution", role: "dividend" },
    ];
    const v2: StatementLine[] = [v1[0], { date: "2030-01-20", amountMinor: 310, description: "EXAMPLE ETF: Cash dividend distribution", role: "dividend" }];
    const first = importInto(tfsa.id, v1, [], [CHEQUING, tfsa], info(1));
    const key = statementKey(tfsa.id, info(1))!;
    expect(first.insert.every((t) => t.tags.includes(`${key}:v1`))).toBe(true);
    const second = importInto(tfsa.id, v2, first.rows, [CHEQUING, tfsa], info(2));
    expect(second.replaced).toBe(1);
    expect(second.insert.map((t) => t.amount_minor)).toEqual([310]);
    const live = second.rows.filter((t) => t.status === "active");
    expect(live.map((t) => t.amount_minor).sort()).toEqual([20000, 310].sort());
    expect(live.every((t) => t.tags.includes(`${key}:v2`))).toBe(true);
    // The same version again adds nothing; an older one changes nothing.
    expect(importInto(tfsa.id, v2, second.rows, [CHEQUING, tfsa], info(2)).insert).toEqual([]);
    const older = importInto(tfsa.id, v1, second.rows, [CHEQUING, tfsa], info(1));
    expect(older.older).toBe(true);
    expect([older.insert.length, older.update.length]).toEqual([0, 0]);
  });
});
