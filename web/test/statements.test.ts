// SPDX-License-Identifier: GPL-3.0-or-later
// Which account a statement is for, its closing balance, and one transfer
// however many statements show it. Every account, number and line is invented.
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { type PdfJs, type StatementLine, extractPdfPages, lastFour, newAccounts, propose, readOfx, readWealthsimpleChequing, utf8 } from "@/lib/importers";
import type { Account, Transaction } from "@/lib/model";
import { requireCurrency } from "@/lib/money";
import { UNMATCHED_TAG, hasTag, legTags } from "@/lib/review";
import { digitsDiffer, findStatementAccount, linkedAccount, proposedStatementAccount } from "@/lib/statementAccount";
import { MATCH_DAYS, matchTransfers } from "@/lib/transferMatch";
import { makePdf, samplePages } from "./pdfFixture";
import { ALICE, GROCERIES, HOUSEHOLD } from "./support";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cad = requireCurrency("CAD");
const OTHER = "00000000-0000-4000-8000-000000000199";
const OTHER_IN = "00000000-0000-4000-8000-000000000198";
const BANK_A = "00000000-0000-4000-8000-000000000301";
const BANK_B = "00000000-0000-4000-8000-000000000302";
const CARD = "00000000-0000-4000-8000-000000000303";

const acct = (id: string, name: string, type: Account["type"], extra: Partial<Account> = {}): Account => ({
  id, name, type, opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false, ...extra,
});

describe("what a statement says about its account", () => {
  it("keeps only the last four digits of a number", () => {
    expect(lastFour("Account number: 000012345")).toBe("2345");
    expect(lastFour("••••0042")).toBe("0042");
    expect(lastFour("123")).toBeNull();
    expect(lastFour(null)).toBeNull();
  });

  it("reads the Wealthsimple PDF's account, closing balance and date", async () => {
    const r = readWealthsimpleChequing(await extractPdfPages(makePdf(samplePages()), pdfjs as unknown as PdfJs), cad);
    expect(r.statement).toEqual({ institution: "Wealthsimple", type: "checking", last4: "0000", closingBalanceMinor: 170852, closingDate: "2030-01-31" });
  });

  it("reads an OFX/QFX statement's account, kind and ledger balance", () => {
    const r = readOfx(new Uint8Array(readFileSync(join(__dirname, "fixtures", "tangerine-style.qfx"))), cad);
    expect(r.statement?.last4).toBe("0000");
    expect(r.statement?.type).toBe("checking");
    expect(r.statement?.closingBalanceMinor).toBe(168382);
    expect(r.statement?.closingDate).toBe("2030-01-31");
    const card = utf8(`OFXHEADER:100
<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Example Card Co</ORG></FI></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>CAD<CCACCTFROM><ACCTID>4500000000009876</CCACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20300105<TRNAMT>-12.00<FITID>1<NAME>EXAMPLE SHOP</STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>-512.30<DTASOF>20300131</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`);
    const s = readOfx(card, cad).statement;
    expect(s).toMatchObject({ type: "credit_card", last4: "9876", institution: "Example Card Co", closingBalanceMinor: -51230, closingDate: "2030-01-31" });
    // Never more than four digits of the number.
    expect(JSON.stringify(s)).not.toMatch(/45000/);
  });

  const info = { institution: "Example Bank", type: "checking" as const, last4: "1234", closingBalanceMinor: 100, closingDate: "2030-01-31" };

  it("finds the household's account by its last four digits; bank and kind only break ties, the name never counts", () => {
    const mine = acct(BANK_A, "Everyday", "checking", { institution: "Example Bank", last4: "1234" });
    const other = acct(BANK_B, "Savings", "savings", { institution: "Example Bank", last4: "1234" });
    expect(findStatementAccount([other, mine], info)?.id).toBe(BANK_A);
    // Same digits at another bank or of another kind: still that account, when it is the only one with them.
    expect(findStatementAccount([acct(BANK_A, "x", "cash", { institution: "Other Bank", last4: "1234" })], info)?.id).toBe(BANK_A);
    expect(findStatementAccount([acct(BANK_A, "x", "checking", { last4: "1234" })], info)?.id).toBe(BANK_A);
    // The bank breaks a tie before the kind does.
    const sameBankOtherKind = acct(BANK_B, "Cash", "cash", { institution: "Example Bank", last4: "1234" });
    const otherBankSameKind = acct(CARD, "Chequing", "checking", { institution: "Other Bank", last4: "1234" });
    expect(findStatementAccount([otherBankSameKind, sameBankOtherKind], info)?.id).toBe(BANK_B);
    // A name that looks right without the digits is not a match.
    expect(findStatementAccount([acct(BANK_A, "Example Bank chequing", "checking", { institution: "Example Bank" })], info)).toBeNull();
    expect(findStatementAccount([mine], { ...info, last4: "9999" })).toBeNull();
    expect(findStatementAccount([mine], { ...info, last4: null })).toBeNull();
    expect(findStatementAccount([{ ...mine, archived: true }], info)).toBeNull();
  });

  it("proposes a new account, prefilled, when none is the statement's", () => {
    const p = proposedStatementAccount(HOUSEHOLD, [acct(BANK_A, "Example Bank chequing ••1234", "checking")], info);
    expect(p).toMatchObject({ name: "Example Bank chequing ••1234 (2)", type: "checking", institution: "Example Bank", last4: "1234" });
    expect(proposedStatementAccount(HOUSEHOLD, [], info).id).toBe(proposedStatementAccount(HOUSEHOLD, [], info).id);
  });

  it("gives a chosen account the statement's digits, never replacing others, its name or its kind", () => {
    const plain = acct(BANK_A, "Cash", "cash");
    expect(linkedAccount(plain, info)).toMatchObject({ name: "Cash", type: "cash", last4: "1234", institution: "Example Bank" });
    expect(linkedAccount({ ...plain, last4: "5555" }, info)).toBeNull();
    expect(digitsDiffer({ ...plain, last4: "5555" }, info)).toBe(true);
    expect(digitsDiffer(plain, info)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/** One statement into the household, as the import screen does it. */
function importInto(accountId: string, lines: StatementLine[], rows: Transaction[], accounts: Account[]) {
  const proposals = propose({
    householdId: HOUSEHOLD, accountId, lines, rules: [], uncategorizedExpenseId: OTHER, uncategorizedIncomeId: OTHER_IN,
    payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(rows.map((r) => r.id)), now: "2030-02-01T00:00:00.000Z",
    names: { categories: [], members: [], accounts }, knownMerchants: true, knownTransfers: true,
  });
  const made = newAccounts(proposals);
  const fresh = proposals.filter((p) => !p.alreadyImported).map((p) => p.transaction);
  const all = [...accounts, ...made.filter((m) => !accounts.some((a) => a.id === m.id))];
  const m = matchTransfers({ accountId, fresh, existing: rows, accounts: all });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const u of m.update) byId.set(u.id, u);
  for (const t of m.insert) byId.set(t.id, t);
  return { ...m, rows: [...byId.values()], accounts: all };
}
const live = (rows: Transaction[]) => rows.filter((r) => r.status === "active");
const transfers = (rows: Transaction[]) => live(rows).filter((r) => r.kind === "transfer");

describe("transfer matching", () => {
  const A = acct(BANK_A, "Everyday", "checking", { last4: "1111" });
  const B = acct(BANK_B, "Other bank", "checking", { last4: "2222" });
  const C = acct(CARD, "Northwind card", "credit_card", { last4: "0000" });
  const accounts = [A, B, C];
  // Every statement also has some spending, so it is a real account and not a stand-in.
  const shop = (date: string): StatementLine => ({ date, amountMinor: -1234, description: "EXAMPLE GROCER" });

  it("pairs money out of one account with the same amount into another within the window, counted once", () => {
    const one = importInto(BANK_A, [shop("2030-01-02"), { date: "2030-01-10", amountMinor: -50000, description: "Transfer out to Other account" }], [], accounts);
    expect(one.unmatched).toBe(1);
    expect(transfers(one.rows).every((t) => hasTag(t, UNMATCHED_TAG))).toBe(true);
    const two = importInto(BANK_B, [shop("2030-01-03"), { date: "2030-01-12", amountMinor: 50000, description: "Transfer in from Other account" }], one.rows, one.accounts);
    expect(two.matched).toBe(1);
    const t = transfers(two.rows);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ account_id: BANK_A, to_account_id: BANK_B, amount_minor: 50000 });
    expect(hasTag(t[0], UNMATCHED_TAG)).toBe(false);
    expect(legTags(t[0])).toHaveLength(1);
    // The same statement again adds nothing and changes nothing.
    const again = importInto(BANK_B, [shop("2030-01-03"), { date: "2030-01-12", amountMinor: 50000, description: "Transfer in from Other account" }], two.rows, two.accounts);
    expect(again.insert).toHaveLength(0);
    expect(transfers(again.rows)).toHaveLength(1);
  });

  it(`leaves different amounts, the same direction, or more than ${MATCH_DAYS} days apart unmatched`, () => {
    const one = importInto(BANK_A, [shop("2030-01-02"), { date: "2030-01-10", amountMinor: -50000, description: "Transfer out to Other account" }], [], accounts);
    for (const [date, amount] of [["2030-01-12", 49999], ["2030-01-16", 50000], ["2030-01-12", -50000]] as const) {
      const two = importInto(BANK_B, [shop("2030-01-03"), { date, amountMinor: amount, description: amount > 0 ? "Transfer in from Other account" : "Transfer out to Other account" }], one.rows, one.accounts);
      expect(two.matched).toBe(0);
      expect(transfers(two.rows)).toHaveLength(2);
      expect(transfers(two.rows).every((t) => hasTag(t, UNMATCHED_TAG))).toBe(true);
    }
  });

  it("matches a card bill paid from the bank with the payment received on the card's statement", () => {
    const bank = importInto(BANK_B, [shop("2030-01-02"), { date: "2030-01-20", amountMinor: -30000, description: "Online bill payment for NORTHWIND CARDS, account ••••0000" }], [], accounts);
    // The payment goes to the card with those digits, whatever it is called.
    expect(transfers(bank.rows)[0]).toMatchObject({ account_id: BANK_B, to_account_id: CARD });
    const card = importInto(CARD, [shop("2030-01-05"), { date: "2030-01-21", amountMinor: 30000, description: "PAYMENT - THANK YOU" }], bank.rows, bank.accounts);
    expect(card.matched).toBe(1);
    const t = transfers(card.rows);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ account_id: BANK_B, to_account_id: CARD });
    expect(hasTag(t[0], UNMATCHED_TAG)).toBe(false);
  });

  it("follows money moved to another bank and a card paid from there: transfers, not spending", () => {
    const a = importInto(BANK_A, [shop("2030-01-02"), { date: "2030-01-10", amountMinor: -40000, description: "Transfer out to Other account" }], [], accounts);
    const b = importInto(BANK_B, [
      shop("2030-01-03"),
      { date: "2030-01-11", amountMinor: 40000, description: "Transfer in from Other account" },
      { date: "2030-01-12", amountMinor: -40000, description: "Online bill payment for NORTHWIND CARDS, account ••••0000" },
    ], a.rows, a.accounts);
    const c = importInto(CARD, [shop("2030-01-04"), { date: "2030-01-13", amountMinor: 40000, description: "PAYMENT - THANK YOU" }], b.rows, b.accounts);
    const t = transfers(c.rows);
    expect(t.map((x) => [x.account_id, x.to_account_id])).toEqual(expect.arrayContaining([[BANK_A, BANK_B], [BANK_B, CARD]]));
    expect(t).toHaveLength(2);
    expect(t.some((x) => hasTag(x, UNMATCHED_TAG))).toBe(false);
    // Spending is only the shops.
    expect(live(c.rows).filter((r) => r.kind === "expense").map((r) => r.amount_minor)).toEqual([1234, 1234, 1234]);
  });

  it("turns an e-Transfer to yourself at another bank into one transfer", () => {
    const a = importInto(BANK_A, [shop("2030-01-02"), { date: "2030-01-10", amountMinor: -25000, description: "Interac e-Transfer® Out to Example Person" }], [], accounts);
    expect(live(a.rows).find((r) => r.amount_minor === 25000)?.kind).toBe("expense");
    const b = importInto(BANK_B, [shop("2030-01-03"), { date: "2030-01-10", amountMinor: 25000, description: "INTERAC E-TRANSFER FROM EXAMPLE PERSON" }], a.rows, a.accounts);
    expect(b.matched).toBe(1);
    const t = transfers(b.rows);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ account_id: BANK_A, to_account_id: BANK_B, category_id: null });
    // Someone else's name is a real payment.
    const c = importInto(BANK_B, [shop("2030-01-03"), { date: "2030-01-10", amountMinor: 25000, description: "INTERAC E-TRANSFER FROM SOMEONE ELSE" }], a.rows, a.accounts);
    expect(c.matched).toBe(0);
  });

  it("joins two unmatched transfers already in the household", () => {
    const base = (id: string, from: string, to: string, date: string, fp: string): Transaction => ({
      id, kind: "transfer", date, amount_minor: 7000, category_id: null, account_id: from, to_account_id: to, paid_by_member_id: null,
      to_member_id: null, split: null, recurrence: "variable", note: "Transfer", tags: [UNMATCHED_TAG], extras: {}, status: "active",
      recurring_rule_id: null, occurrence_date: null, import_fingerprint: fp, original_currency: null, created_at: "", client_updated_at: "",
    });
    const SA = "00000000-0000-4000-8000-000000000401";
    const SB = "00000000-0000-4000-8000-000000000402";
    const spend = (id: string, on: string): Transaction => ({ ...base(id, on, on, "2030-01-01", id), kind: "expense", to_account_id: null, category_id: GROCERIES, tags: [] });
    const rows = [
      spend("00000000-0000-4000-8000-0000000005a1", BANK_A), spend("00000000-0000-4000-8000-0000000005a2", BANK_B),
      base("00000000-0000-4000-8000-000000000501", BANK_A, SA, "2030-01-10", "fp-a"),
      base("00000000-0000-4000-8000-000000000502", SB, BANK_B, "2030-01-11", "fp-b"),
    ];
    const m = matchTransfers({ accountId: BANK_A, fresh: [], existing: rows, accounts: [...accounts, acct(SA, "Other account", "other"), acct(SB, "Other account 2", "other")] });
    expect(m.joined).toBe(1);
    const kept = m.update.filter((u) => u.status === "active");
    const gone = m.update.filter((u) => u.status === "deleted");
    expect(kept).toHaveLength(1);
    expect(gone).toHaveLength(1);
    expect(kept[0]).toMatchObject({ account_id: BANK_A, to_account_id: BANK_B });
    expect(hasTag(kept[0], UNMATCHED_TAG)).toBe(false);

    // Two transfers out of one account to two stand-ins, same amount and day, are two transfers, not one.
    const twoOut = [
      rows[0],
      base("00000000-0000-4000-8000-000000000503", BANK_A, SA, "2030-01-10", "fp-c"),
      base("00000000-0000-4000-8000-000000000504", BANK_A, SB, "2030-01-10", "fp-d"),
    ];
    const none = matchTransfers({ accountId: BANK_A, fresh: [], existing: twoOut, accounts: [...accounts, acct(SA, "Other account", "other"), acct(SB, "Other account 2", "other")] });
    expect(none.joined).toBe(0);
    expect(none.update).toHaveLength(0);
  });
});
