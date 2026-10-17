// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from core/src/test/.../ImportersTest.kt. Invented statements only.
import { describe, expect, it } from "vitest";
import {
  columnValues, defaultKeys, detectOfx, detectQif, guessColumns, guessDateFormat, guessDecimal, guessDelimiter,
  guessFixedValues, guessIncomeValues, iconFor, accountIdFor, categoryIdFor, newAccounts, newCategories, profile,
  propose, readCsv, readOfx, readQif, utf8, windows1252, type ProposeInput,
} from "@/lib/importers";
import { requireCurrency } from "@/lib/money";
import type { CategorizationRule } from "@/lib/model";
import { ALICE, BOB, CASH, GROCERIES, HOUSEHOLD, LEISURE, MAIN, SALARY, SNACKS, category, config } from "./support";

const eur = requireCurrency("EUR");
const names = { categories: config.categories, members: config.members, accounts: config.accounts };

const csv = `Statement export
Date;Description;Detail;Amount;Balance
15/01/2030;GROCERY STORE 01;card 1234;-42,10;"1.037,20"
16/01/2030;"COFFEE SHOP; TERRACE";;-3,50;1.033,70
31/01/2030;ACME CORP;salary;2.500,00;3.533,70
not a date;x;;1,00;0
01/02/2030;CASH MACHINE;;-100,00;3.433,70`;

const prof = profile({
  delimiter: ";", skipRows: 1, hasHeader: true, dateColumn: 0, dateFormat: "dd/MM/yyyy",
  amount: { mode: "single", column: 3 }, decimal: "comma", descriptionColumns: [1, 2],
});

function rule(id: string, pattern: string, action: CategorizationRule["action"]): CategorizationRule {
  return { id, pattern, action, sort: 0, active: true };
}

function plan(over: Partial<ProposeInput> & Pick<ProposeInput, "lines">) {
  return propose({
    householdId: HOUSEHOLD, accountId: MAIN, rules: [], uncategorizedExpenseId: LEISURE, uncategorizedIncomeId: SALARY,
    payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-03-06T00:00:00.000Z", ...over,
  });
}

describe("importers (core parity)", () => {
  it("csv with a mapping", () => {
    const r = readCsv(utf8(csv), prof, eur);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([-4210, -350, 250000, -10000]);
    expect(r.lines[0].description).toBe("GROCERY STORE 01 · card 1234");
    expect(r.lines[1].description).toBe("COFFEE SHOP; TERRACE");
    expect(r.skipped.map((s) => s.line)).toEqual([6]);
    expect(guessDelimiter(csv.split("\n").slice(1).join("\n"))).toBe(";");
  });

  it("csv with debit and credit columns, in Windows-1252", () => {
    const bytes = windows1252("Date,Payee,Out,In\n2030-01-05,CAFÉ,12.00,\n2030-01-06,REFUND,,5.25\n");
    const r = readCsv(bytes, profile({ dateColumn: 0, dateFormat: "yyyy-MM-dd", amount: { mode: "split", debitColumn: 2, creditColumn: 3 }, descriptionColumns: [1] }), eur);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([-1200, 525]);
    expect(r.lines[0].description).toBe("CAFÉ");
  });

  it("ofx, sgml and xml", () => {
    const sgml = utf8(`OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20300115120000<TRNAMT>-42.10<FITID>A1<NAME>GROCERY STORE 01
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20300131<TRNAMT>2500.00<FITID>A2<NAME>ACME CORP<MEMO>salary
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
    expect(detectOfx(sgml)).toBe(1);
    const r = readOfx(sgml, eur);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([-4210, 250000]);
    expect(r.lines[1].description).toBe("ACME CORP · salary");
    expect(r.lines[0].bankId).toBe("A1");
    const xml = "<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20300110</DTPOSTED><TRNAMT>-7.49</TRNAMT><NAME>STREAMING SERVICE</NAME></STMTTRN></BANKTRANLIST></OFX>";
    expect(readOfx(utf8(xml), eur).lines.map((l) => l.amountMinor)).toEqual([-749]);
  });

  it("qif", () => {
    const qif = utf8("!Type:Bank\nD01/15/2030\nT-42.10\nPGROCERY STORE 01\n^\nD01/31'30\nT2,500.00\nPACME CORP\n^\n");
    expect(detectQif(qif)).toBe(1);
    const r = readQif(qif, eur, "MM/dd/yyyy");
    expect(r.lines.map((l) => l.amountMinor)).toEqual([-4210]);
    expect(r.skipped.length).toBe(1); // a two-digit year does not fit a four-digit format
  });

  it("importing the same statement twice produces the same ids, and rules categorise", () => {
    const lines = readCsv(utf8(csv), prof, eur).lines;
    const rules = [rule("r1", "grocery store", { category_id: GROCERIES }), rule("r2", "cash machine", { kind: "transfer", to_account_id: CASH })];
    const go = (existing: Set<string>) =>
      plan({ lines, rules, defaultSplit: { mode: "equal", members: [ALICE, BOB] }, existingIds: existing, now: "2030-02-02T10:00:00.000Z" });
    const first = go(new Set());
    expect(first[0].transaction.category_id).toBe(GROCERIES);
    expect(first[2].transaction.kind).toBe("income");
    expect(first[3].transaction.kind).toBe("transfer");
    expect(first[3].transaction.to_account_id).toBe(CASH);
    expect(first[1].transaction.category_id).toBe(LEISURE);
    const again = go(new Set(first.map((p) => p.transaction.id)));
    expect(again.map((p) => p.transaction.id)).toEqual(first.map((p) => p.transaction.id));
    expect(again.every((p) => p.alreadyImported)).toBe(true);
  });

  it("two identical lines in one file stay two transactions", () => {
    const lines = readCsv(utf8("d,a\n01/01/2030,-1.00\n01/01/2030,-1.00\n"), profile({ dateColumn: 0, dateFormat: "dd/MM/yyyy", amount: { mode: "single", column: 1 } }), eur).lines;
    const ids = plan({ lines }).map((p) => p.transaction.id);
    expect(new Set(ids).size).toBe(2);
    expect(lines[0].date).toBe("2030-01-01");
  });

  const ledger = `date;type;amount;category;who;account;note
2030-03-01;in;1.800,00;Salary;Bob;Main account;March pay
2030-03-02;out;42,10;groceries;alice;Main account;weekly shop
2030-03-03;OUT;12,00;Pets;B;Cash;vet treats
2030-03-04;out;8,00;pets;Zed;Somewhere else;more treats
2030-03-05;In;50,00;Gifts;Alice;Cash;birthday`;
  const ledgerProfile = profile({
    delimiter: ";", dateColumn: 0, dateFormat: "yyyy-MM-dd", amount: { mode: "single", column: 2 }, decimal: "comma",
    descriptionColumns: [6], categoryColumn: 3, kindColumn: 1, incomeValues: ["in"], payerColumn: 4, accountColumn: 5,
  });

  it("a type column decides the sign when every amount is positive", () => {
    const lines = readCsv(utf8(ledger), ledgerProfile, eur).lines;
    expect(lines.map((l) => l.amountMinor)).toEqual([180000, -4210, -1200, -800, 5000]);
    expect(lines.map((l) => l.payer)).toEqual(["Bob", "alice", "B", "Zed", "Alice"]);
    expect(lines[2].account).toBe("Cash");
    expect(columnValues(utf8(ledger), ledgerProfile, 1).map((v) => v.toLowerCase())).toEqual(["out", "in"]);
  });

  it("the file's own categories, payers and accounts land on the household's", () => {
    const lines = readCsv(utf8(ledger), ledgerProfile, eur).lines;
    const go = () => plan({ lines, names });
    const p = go().map((x) => x.transaction);
    expect(p[0].category_id).toBe(SALARY);
    expect(p[0].kind).toBe("income");
    expect(p[1].category_id).toBe(GROCERIES);
    expect(p[1].paid_by_member_id).toBe(ALICE);
    expect(p[2].paid_by_member_id).toBe(BOB);
    expect(p[3].paid_by_member_id).toBe(ALICE);
    expect(p[2].account_id).toBe(CASH);
    const made = newAccounts(go());
    expect(made.map((a) => a.name)).toEqual(["Somewhere else"]);
    expect(p[3].account_id).toBe(made[0].id);
    expect(made[0].id).toBe(accountIdFor(HOUSEHOLD, "SOMEWHERE ELSE"));
    const created = newCategories(go());
    expect(created.map((c) => [c.name, c.applies_to])).toEqual([["Pets", "expense"], ["Gifts", "income"]]);
    expect(p[2].category_id).toBe(p[3].category_id);
    expect(created[0].id).toBe(categoryIdFor(HOUSEHOLD, "PETS"));
  });

  it("a rule still beats the file's category", () => {
    const lines = readCsv(utf8(ledger), ledgerProfile, eur).lines;
    const p = plan({ lines, rules: [rule("r", "treats", { category_id: SNACKS })], names });
    expect(p[2].transaction.category_id).toBe(SNACKS);
    expect(newCategories(p).map((c) => c.name)).toEqual(["Gifts"]);
  });

  it("an ordinary header maps itself, in any of the six languages", () => {
    expect(guessColumns(["Date", "Type", "Amount", "Category", "Paid by", "Account", "Note"])).toEqual({
      date: 0, kind: 1, amount: 2, category: 3, payer: 4, account: 5, description: 6,
    });
    const es = guessColumns(["Fecha", "Concepto", "Importe", "Categoría", "Quién", "Cuenta"]);
    expect([es.date, es.description, es.amount, es.category, es.payer, es.account]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(guessColumns(["Buchungstag", "Verwendungszweck", "Betrag", "Saldo"])).toEqual({ date: 0, amount: 2, description: 1 });
    const bank = guessColumns(["Booking date", "Value date", "Details", "Amount", "Balance"]);
    expect(bank.date).toBe(0);
    expect(bank.amount).toBe(3);
    expect(guessColumns(["a", "b"])).toEqual({});
  });

  it("date format, decimal separator and income values are guessed from the values", () => {
    const formats = ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"];
    expect(guessDateFormat(["01/31/2030", "02/01/2030"], formats)).toBe("MM/dd/yyyy");
    expect(guessDateFormat(["01/02/2030", ""], formats)).toBe("dd/MM/yyyy");
    expect(guessDateFormat(["2030-03-01"], formats)).toBe("yyyy-MM-dd");
    expect(guessDateFormat(["soon"], formats)).toBeNull();
    expect(guessDecimal(["1.234,56", "-3,5"])).toBe("comma");
    expect(guessDecimal(["1,234.56"])).toBe("dot");
    expect(guessDecimal(["12"])).toBeNull();
    expect(guessIncomeValues(["Gasto", "Ingreso", "in", "out"])).toEqual(["Ingreso", "in"]);
  });

  it("a category named after one of the household's accounts is money changing pockets", () => {
    const file = `date;type;amount;category;account;note;repeats
2030-04-01;out;200,00;cash;Main account;cash machine;variable
2030-04-02;out;4,25;Groceries;Cash;market stall;variable
2030-04-03;in;50,00;Cash;Main account;paid back in;variable
2030-04-04;out;650,00;Rent;Main account;flat;fixed`;
    expect(guessColumns(file.split("\n")[0].split(";")).recurrence).toBe(6);
    const p2 = profile({
      delimiter: ";", dateColumn: 0, dateFormat: "yyyy-MM-dd", amount: { mode: "single", column: 2 }, decimal: "comma",
      descriptionColumns: [5], categoryColumn: 3, kindColumn: 1, incomeValues: ["in"], accountColumn: 4, fixedColumn: 6,
      fixedValues: guessFixedValues(["variable", "fixed"]),
    });
    const p = plan({ lines: readCsv(utf8(file), p2, eur).lines, names });
    const t = p.map((x) => x.transaction);
    expect(t[0].kind).toBe("transfer");
    expect([t[0].account_id, t[0].to_account_id]).toEqual([MAIN, CASH]);
    expect(t[0].category_id).toBeNull();
    expect(t[1].kind).toBe("expense");
    expect(t[1].account_id).toBe(CASH);
    expect(t[2].kind).toBe("transfer");
    expect([t[2].account_id, t[2].to_account_id]).toEqual([CASH, MAIN]);
    expect(t[3].recurrence).toBe("fixed");
    expect(t[1].recurrence).toBe("variable");
    expect(newCategories(p).map((c) => c.name)).toEqual(["Rent"]);
  });

  it("money in stays income, and one name makes one category for both kinds", () => {
    const file = `date;type;amount;category;note
2030-05-01;out;45,95;Shopping;plugs
2030-05-02;in;100,00;Shopping;sold the old screen
2030-05-03;in;8,88;Groceries;refund
2030-05-04;out;12,00;Salary;payroll fee
2030-05-05;in;1.200,00;Bonus;`;
    const p2 = profile({ delimiter: ";", dateColumn: 0, dateFormat: "yyyy-MM-dd", amount: { mode: "single", column: 2 }, decimal: "comma", descriptionColumns: [4], categoryColumn: 3, kindColumn: 1, incomeValues: ["in"] });
    const p = plan({ lines: readCsv(utf8(file), p2, eur).lines, names, defaultSplit: { mode: "equal", members: [ALICE, BOB] } });
    const t = p.map((x) => x.transaction);
    expect(t.map((x) => x.kind)).toEqual(["expense", "income", "income", "expense", "income"]);
    expect(t[0].category_id).toBe(t[1].category_id);
    expect(t[2].category_id).toBe(GROCERIES);
    expect(t[3].category_id).toBe(SALARY);
    const written = newCategories(p);
    expect(written.map((c) => [c.name, c.applies_to])).toEqual([["Shopping", "both"], ["Groceries", "both"], ["Salary", "both"], ["Bonus", "income"]]);
    expect(written.filter((c) => c.name === "Groceries" || c.name === "Salary").map((c) => c.id)).toEqual([GROCERIES, SALARY]);
  });

  it("a file's names land on Fulla's own categories, in any language, and new ones get an icon", () => {
    expect(defaultKeys("Supermercado")).toEqual(["groceries"]);
    expect(defaultKeys("Nómina")).toEqual(["salary"]);
    expect(defaultKeys("restaurantes")).toEqual(["eating_out"]);
    expect(defaultKeys("Otros")).toEqual(["other", "other_income"]);
    expect(defaultKeys("Carnicería")).toEqual([]);
    expect(iconFor("Farmacia")).toBe("local_hospital");
    expect(iconFor("Combustible")).toBe("local_gas_station");
    expect(iconFor("Taxi")).toBe("directions_bus");
    expect(iconFor("peluquería")).toBe("content_cut");
    expect(iconFor("Carnicería")).toBe("shopping_cart");
    expect(iconFor("Supermercado")).toBe("shopping_cart");
    expect(iconFor("Zzyzx")).toBeNull();

    const file = `date;type;amount;category;note
2030-06-01;out;30,00;Supermercado;
2030-06-02;out;12,00;Restaurantes;
2030-06-03;in;2.000,00;Nómina;
2030-06-04;in;20,00;Otros;
2030-06-05;out;9,00;Farmacia;`;
    const p2 = profile({ delimiter: ";", dateColumn: 0, dateFormat: "yyyy-MM-dd", amount: { mode: "single", column: 2 }, decimal: "comma", descriptionColumns: [4], categoryColumn: 3, kindColumn: 1, incomeValues: ["in"] });
    const eatingOut = category("00000000-0000-4000-8000-000000000105", "Eating out", "expense", { icon: "restaurant" });
    const otherIncome = category("00000000-0000-4000-8000-000000000106", "Other income", "income", { icon: "savings" });
    const other = category("00000000-0000-4000-8000-000000000107", "Other", "expense", { icon: "more_horiz" });
    const cats = [...config.categories, eatingOut, other, otherIncome];
    const p = plan({ lines: readCsv(utf8(file), p2, eur).lines, names: { ...names, categories: cats } });
    expect(p.slice(0, 4).map((x) => x.transaction.category_id)).toEqual([GROCERIES, eatingOut.id, SALARY, otherIncome.id]);
    expect(newCategories(p).map((c) => [c.name, c.icon])).toEqual([["Farmacia", "local_hospital"]]);
  });
});
