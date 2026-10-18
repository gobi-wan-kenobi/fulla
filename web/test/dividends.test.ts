// SPDX-License-Identifier: GPL-3.0-or-later
// A month's dividends as one line, and government grants kept out of the
// household's income. Every amount and name here is invented.
import { describe, expect, it } from "vitest";
import { grantsCategory } from "@/lib/categorize";
import { buildImport, dividendsLabel, groupDividends, newAccounts, propose, readWealthsimpleActivityCsv, statementKey, type StatementAccountInfo, type StatementLine } from "@/lib/importers";
import { monthTotals } from "@/lib/ledger";
import { type Account, type Category, type Transaction, outsideTotals } from "@/lib/model";
import { monthFigures, overview } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { ALICE, HOUSEHOLD, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const div = (date: string, amountMinor: number, extra: Partial<StatementLine> = {}): StatementLine => ({ date, amountMinor, description: `EX${amountMinor}: Cash dividend distribution`, role: "dividend", ...extra });

describe("a month's dividends", () => {
  it("become one line per month for their exact total, on the day of the last, in its place", () => {
    const lines: StatementLine[] = [
      div("2030-01-02", 1), { date: "2030-01-03", amountMinor: 10000, description: "Deposit", role: "transfer" }, div("2030-01-09", 3),
      div("2030-01-30", 7), { date: "2030-01-31", amountMinor: -38, description: "Example fee", role: "fee" }, div("2030-02-04", 5),
      div("2030-02-06", -2), // a dividend taken back stays as it is
    ];
    const posted = lines.map((l) => l.date);
    const g = groupDividends(lines, posted);
    expect(g.lines.map((l) => [l.date, l.amountMinor, l.role, l.description])).toEqual([
      ["2030-01-03", 10000, "transfer", "Deposit"],
      ["2030-01-30", 11, "dividend", "Dividends – January (3)"],
      ["2030-01-31", -38, "fee", "Example fee"],
      ["2030-02-04", 5, "dividend", "EX5: Cash dividend distribution"], // alone in its month: its own line
      ["2030-02-06", -2, "dividend", "EX-2: Cash dividend distribution"],
    ]);
    expect(g.posted).toEqual(["2030-01-03", "2030-01-30", "2030-01-31", "2030-02-04", "2030-02-06"]);
    const sum = (ls: StatementLine[]) => ls.reduce((a, l) => a + l.amountMinor, 0);
    expect(sum(g.lines)).toBe(sum(lines));
    expect(dividendsLabel("2030-09", 73)).toBe("Dividends – September (73)");
  });

  it("keep the foreign amount only when every dividend in the month had one in the same currency", () => {
    const usd = groupDividends([div("2030-01-02", 14, { originalAmountMinor: 10, originalCurrency: "USD" }), div("2030-01-05", 28, { originalAmountMinor: 20, originalCurrency: "USD" })], ["2030-01-02", "2030-01-05"]);
    expect(usd.lines[0]).toMatchObject({ amountMinor: 42, originalAmountMinor: 30, originalCurrency: "USD" });
    const mixed = groupDividends([div("2030-01-02", 14, { originalAmountMinor: 10, originalCurrency: "USD" }), div("2030-01-05", 28)], ["2030-01-02", "2030-01-05"]);
    expect(mixed.lines[0].originalCurrency).toBeUndefined();
  });

  it("are grouped by the activity export too, and its grants are left alone", () => {
    const r = readWealthsimpleActivityCsv([
      '"date","transaction","description","amount","balance","currency"',
      '"2030-03-02","DIV","EXA: Cash dividend distribution, received on 2030-03-02","1.25","11.25","CAD"',
      '"2030-03-09","DIV","EXB: Cash dividend distribution, received on 2030-03-09","0.75","12.0","CAD"',
      '"2030-03-14","GRANT","Grant payment (executed at 2030-03-14)","20.0","32.0","CAD"',
    ].join("\n"))!;
    expect(r.lines.map((l) => [l.date, l.amountMinor, l.role, l.description])).toEqual([
      ["2030-03-09", 200, "dividend", "Dividends – March (2)"],
      ["2030-03-14", 2000, "grant", "Grant payment"],
    ]);
  });
});

const INVEST = category(id(906), "Investment income", "income");
const GRANTS = category(id(908), "Government grants", "income", { parent_id: INVEST.id, excluded_from_income: true });
const OTHER = category(id(901), "Other", "expense");
const OTHER_IN = category(id(902), "Other income", "income");
const SALARY = category(id(909), "Salary", "income");
const CATEGORIES: Category[] = [OTHER, OTHER_IN, INVEST, GRANTS, SALARY];
const RESP: Account = { id: id(330), name: "Example RESP", type: "investment", opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false };

function importInto(lines: StatementLine[], rows: Transaction[], info: StatementAccountInfo, categories = CATEGORIES) {
  const proposals = propose({
    householdId: HOUSEHOLD, accountId: RESP.id, lines, rules: [], uncategorizedExpenseId: OTHER.id, uncategorizedIncomeId: OTHER_IN.id,
    payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(rows.map((r) => r.id)), now: "2030-04-01T00:00:00.000Z",
    names: { categories, members: [], accounts: [RESP] }, knownMerchants: true, knownTransfers: true,
  });
  const out = buildImport({ householdId: HOUSEHOLD, categories, accounts: [RESP], rows, proposals, createdAccounts: newAccounts(proposals), accountId: RESP.id, proposedAccount: null, statement: info, answers: {} });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const u of out.update) byId.set(u.id, u);
  for (const t of out.insert) byId.set(t.id, t);
  return { ...out, rows: [...byId.values()] };
}
const info = (version: number): StatementAccountInfo => ({ institution: "Example Broker", type: "investment", last4: "AB12", closingBalanceMinor: 1, closingDate: "2030-03-31", periodStart: "2030-03-01", version });
const live = (rows: Transaction[]) => rows.filter((t) => t.status === "active");
const income = (rows: Transaction[]) => live(rows).filter((t) => t.kind === "income").reduce((a, t) => a + t.amount_minor, 0);

describe("re-importing grouped dividends", () => {
  const v1 = groupDividends([div("2030-03-02", 125), div("2030-03-09", 75)], ["2030-03-02", "2030-03-09"]).lines;
  const v2 = groupDividends([div("2030-03-02", 125), div("2030-03-09", 75), div("2030-03-20", 40)], ["2030-03-02", "2030-03-09", "2030-03-20"]).lines;

  it("adds nothing the second time, and a later version replaces the month's line instead of adding to it", () => {
    const first = importInto(v1, [], info(1));
    expect(first.insert.map((t) => [t.note, t.amount_minor])).toEqual([["Dividends – March (2)", 200]]);
    expect(importInto(v1, first.rows, info(1)).insert).toEqual([]);
    const second = importInto(v2, first.rows, info(2));
    expect(second.replaced).toBe(1);
    expect(live(second.rows).map((t) => [t.note, t.amount_minor])).toEqual([["Dividends – March (3)", 240]]);
    expect(income(second.rows)).toBe(240);
    const key = statementKey(RESP.id, info(2))!;
    expect(live(second.rows).every((t) => t.tags.includes(`${key}:v2`))).toBe(true);
  });
});

describe("money that stays inside an investment account", () => {
  const CHEQUING: Account = { ...RESP, id: id(301), name: "Example chequing", type: "checking" };
  const SAVINGS: Account = { ...RESP, id: id(302), name: "Example savings", type: "savings" };
  const TFSA: Account = { ...RESP, id: id(331), name: "Example TFSA", type: "investment" };
  const INTEREST = category(id(907), "Interest", "income");
  const cats = [...CATEGORIES, INTEREST];
  const tx = (n: number, amount: number, categoryId: string, accountId: string, kind: Transaction["kind"] = "income"): Transaction => ({
    id: id(n), kind, date: "2030-03-20", amount_minor: amount, category_id: categoryId, account_id: accountId, to_account_id: null,
    paid_by_member_id: kind === "income" ? null : ALICE, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {}, status: "active",
    recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "",
  });
  const txs = [
    tx(1, 300000, SALARY.id, CHEQUING.id),
    tx(2, 1200, INTEREST.id, SAVINGS.id), // interest paid into savings: income
    tx(3, 300, INVEST.id, CHEQUING.id), // a dividend paid out to chequing: income
    tx(4, 178, INVEST.id, TFSA.id), // dividends kept in the TFSA: not income
    tx(5, 6, INTEREST.id, TFSA.id), // interest on the TFSA's cash: not income
    tx(6, 2000, GRANTS.id, RESP.id), // a grant into the RESP: not income
    tx(7, 13, INVEST.id, TFSA.id, "refund"), // a fee given back inside the TFSA
  ];
  const rows: LocalRow[] = txs.map((t) => ({ tx: t, state: "synced", base: null }));
  const accounts = [CHEQUING, SAVINGS, TFSA, RESP];

  it("is left out of the Overview's income and History's month total, by the account's type", () => {
    expect(overview(rows, cats, "2030-03", "2030-04-01", accounts).figures.incomeMinor).toBe(301500);
    expect(monthTotals(rows, "2030-03", outsideTotals(cats, accounts)).incomeMinor).toBe(301500);
    expect(monthTotals(rows, "2030-03", outsideTotals(cats, accounts)).spentMinor).toBe(0); // the TFSA's fee refund is the TFSA's too
    const outside = outsideTotals(cats, accounts);
    expect(txs.filter(outside).map((t) => t.id)).toEqual([id(4), id(5), id(6), id(7)]);
  });

  it("counts again once the account is no longer an investment one, the grants category aside", () => {
    const asOther = accounts.map((a) => (a.id === TFSA.id || a.id === RESP.id ? { ...a, type: "other" as const } : a));
    expect(overview(rows, cats, "2030-03", "2030-04-01", asOther).figures.incomeMinor).toBe(301500 + 178 + 6);
  });
});

describe("government grants", () => {
  it("go to the category left out of income, else Investment income", () => {
    expect(grantsCategory(CATEGORIES)!.id).toBe(GRANTS.id);
    expect(grantsCategory([OTHER, OTHER_IN, INVEST])!.id).toBe(INVEST.id);
    // Found by its name when the flag has not reached this client yet.
    expect(grantsCategory([OTHER, OTHER_IN, INVEST, { ...GRANTS, excluded_from_income: undefined }])!.id).toBe(GRANTS.id);
    const out = importInto([{ date: "2030-03-14", amountMinor: 2000, description: "Grant payment", role: "grant" }], [], info(1));
    expect(out.insert[0]).toMatchObject({ kind: "income", category_id: GRANTS.id, account_id: RESP.id, amount_minor: 2000 });
  });

  it("stay in the account but out of the month's income on the Overview and in History", () => {
    const tx = (n: number, amount: number, categoryId: string): Transaction => ({
      id: id(n), kind: "income", date: "2030-03-14", amount_minor: amount, category_id: categoryId, account_id: RESP.id, to_account_id: null,
      paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {}, status: "active",
      recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "",
    });
    const txs = [tx(1, 2000, GRANTS.id), tx(2, 200, INVEST.id), tx(3, 300000, SALARY.id)];
    const rows: LocalRow[] = txs.map((t) => ({ tx: t, state: "synced", base: null }));
    expect(overview(rows, CATEGORIES, "2030-03", "2030-04-01").figures.incomeMinor).toBe(300200);
    expect(monthFigures(txs, "2030-03").incomeMinor).toBe(302200); // without the categories, everything counts
    expect(monthTotals(rows, "2030-03", outsideTotals(CATEGORIES)).incomeMinor).toBe(300200);
  });
});
