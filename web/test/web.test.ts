// SPDX-License-Identifier: GPL-3.0-or-later
// Web-side tests: Canadian bank-style fixtures (all invented), the shared
// vectors and data files, and the pieces ported from core.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectFormat, dropRepeatedBankIds, guessProfile, newCategories, ofxCurrency, parseDate, profileFromJson, profileToJson,
  propose, readCsv, readOfx, readQif, utf8,
} from "@/lib/importers";
import { uuid5 } from "@/lib/ids";
import { DEFAULT_FOR_NEW_HOUSEHOLD, MINOR_UNITS, formatMoney, parseMoney, parseTyped, requireCurrency } from "@/lib/money";
import { normalizeName } from "@/lib/text";
import { stampFor } from "@/lib/sync";
import { ALICE, HOUSEHOLD, LEISURE, MAIN, SALARY, config } from "./support";

const root = join(__dirname, "..", "..");
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", name)));
const cad = requireCurrency("CAD");

describe("Canadian bank-style statements", () => {
  it("an RBC-style CSV maps itself: the CAD$ column, both descriptions, M/d/yyyy, no account names", () => {
    const bytes = fixture("rbc-style.csv");
    expect(detectFormat(bytes)).toBe("csv");
    const p = guessProfile(bytes, "CAD");
    expect(p.dateColumn).toBe(2);
    expect(p.dateFormat).toBe("M/d/yyyy");
    expect(p.amount).toEqual({ mode: "single", column: 6 });
    expect(p.descriptionColumns).toEqual([4, 5]);
    expect(p.kindColumn).toBeNull(); // "Account Type" holds no money-in word
    expect(p.accountColumn).toBeNull(); // "Account Number" is numbers, not names
    const r = readCsv(bytes, p, cad);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([-8420, -475, 250000, -11996]);
    expect(r.lines[0].description).toBe("GROCERY STORE 01 · CARD PURCHASE");
    expect(r.lines[0].date).toBe("2030-01-15");
    // The USD line has nothing in CAD$: skipped, never read as zero.
    expect(r.skipped).toEqual([{ line: 6, reason: "amount" }]);
    // A USD household reads the USD$ column instead.
    const usd = guessProfile(bytes, "USD");
    expect(usd.amount).toEqual({ mode: "single", column: 7 });
    expect(readCsv(bytes, usd, requireCurrency("USD")).lines.map((l) => l.amountMinor)).toEqual([-2500]);
  });

  it("a Tangerine-style QFX is OFX: FITIDs kept, a repeated FITID dropped, identical purchases kept", () => {
    const bytes = fixture("tangerine-style.qfx");
    expect(detectFormat(bytes)).toBe("ofx");
    expect(ofxCurrency(bytes)).toBe("CAD");
    const r = readOfx(bytes, cad);
    expect(r.lines.length).toBe(5);
    expect(r.lines[0]).toMatchObject({ date: "2030-01-05", amountMinor: -4210, bankId: "3030010500001", description: "GROCERY STORE 02 · Point of Sale - Interac" });
    const { lines, repeated } = dropRepeatedBankIds(r.lines);
    expect(repeated).toBe(1);
    expect(lines.map((l) => l.amountMinor)).toEqual([-4210, -4210, 180000, -1599]);
    const p = propose({
      householdId: HOUSEHOLD, accountId: MAIN, lines, rules: [], uncategorizedExpenseId: LEISURE, uncategorizedIncomeId: SALARY,
      payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-02-01T00:00:00.000Z",
    });
    expect(new Set(p.map((x) => x.transaction.id)).size).toBe(4);
    const again = propose({
      householdId: HOUSEHOLD, accountId: MAIN, lines, rules: [], uncategorizedExpenseId: LEISURE, uncategorizedIncomeId: SALARY,
      payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(p.map((x) => x.transaction.id)), now: "2030-03-01T00:00:00.000Z",
    });
    expect(again.every((x) => x.alreadyImported)).toBe(true);
  });

  it("a Wealthsimple-style CSV: ISO dates, signed amounts, UTF-8 accents", () => {
    const bytes = fixture("wealthsimple-style.csv");
    expect(detectFormat(bytes)).toBe("csv");
    const p = guessProfile(bytes, "CAD");
    expect(p.dateFormat).toBe("yyyy-MM-dd");
    expect(p.amount).toEqual({ mode: "single", column: 3 });
    expect(p.descriptionColumns).toEqual([2]);
    const r = readCsv(bytes, p, cad);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([50000, -6137, -335, 84, -625]);
    expect(r.lines[4].description).toBe("Purchase at CAFÉ EXEMPLE");
    const plan = propose({
      householdId: HOUSEHOLD, accountId: MAIN, lines: r.lines, rules: [], uncategorizedExpenseId: LEISURE, uncategorizedIncomeId: SALARY,
      payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-03-07T00:00:00.000Z",
      names: { categories: config.categories, members: config.members, accounts: config.accounts },
    });
    expect(plan.map((x) => x.transaction.kind)).toEqual(["income", "expense", "expense", "income", "expense"]);
    expect(newCategories(plan)).toEqual([]);
  });

  it("content decides the format, never the name", () => {
    expect(detectFormat(utf8("!Type:Bank\nD01/15/2030\nT-1.00\n^\n"))).toBe("qif");
    expect(detectFormat(utf8("<OFX><BANKTRANLIST></BANKTRANLIST></OFX>"))).toBe("ofx");
    expect(detectFormat(utf8("just one column\nno delimiter here\n"))).toBeNull();
    expect(detectFormat(new Uint8Array())).toBeNull();
  });

  it("a QIF in day-first order", () => {
    const r = readQif(utf8("!Type:CCard\nD15/01/2030\nT-12,50\nPBAKERY 01\nMcroissants\n^\n"), cad, "dd/MM/yyyy", "comma");
    expect(r.lines).toEqual([{ date: "2030-01-15", amountMinor: -1250, description: "BAKERY 01 · croissants", bankCategory: null }]);
  });
});

describe("saved column mappings", () => {
  it("round-trip in the shape fulla.save_import_profile stores", () => {
    const p = guessProfile(fixture("rbc-style.csv"), "CAD");
    const json = profileToJson({ id: "00000000-0000-4000-8000-000000000301", name: "RBC chequing", accountId: MAIN, profile: p });
    expect(json.format).toBe("csv");
    expect(json.mapping).toMatchObject({ date_column: 2, date_format: "M/d/yyyy", amount: { mode: "single", column: 6, negative_is_expense: true }, description_columns: [4, 5], decimal: "." });
    // The database accepts only these characters in a date format.
    expect(/^[dMy/.\- ]{6,12}$/.test(String(json.mapping.date_format))).toBe(true);
    expect(profileFromJson(json)?.profile).toEqual({ ...p, encoding: null, amount: { mode: "single", column: 6, negativeIsExpense: true } });
  });
});

describe("shared rules and data", () => {
  it("normalize_name passes the shared vectors", () => {
    const v = JSON.parse(readFileSync(join(root, "testdata/vectors/normalize_name.json"), "utf8"));
    for (const { input, expected } of v.vectors) expect(normalizeName(input)).toBe(expected);
  });

  it("the web's copies of the defaults are the repository's", () => {
    for (const f of ["currencies.json", "categories.json", "web-categories.json"]) {
      expect(JSON.parse(readFileSync(join(__dirname, "../src/data", f), "utf8"))).toEqual(JSON.parse(readFileSync(join(root, "testdata/defaults", f), "utf8")));
    }
    expect(MINOR_UNITS.CAD).toBe(2);
    expect(MINOR_UNITS.JPY).toBe(0);
  });

  it("a new household is proposed Canadian dollars, as core says", () => {
    const kotlin = readFileSync(join(root, "core/src/main/kotlin/io/github/sirallap/fulla/core/money/Currency.kt"), "utf8");
    expect(kotlin).toContain(`DEFAULT_FOR_NEW_HOUSEHOLD: String = "${DEFAULT_FOR_NEW_HOUSEHOLD}"`);
    expect(DEFAULT_FOR_NEW_HOUSEHOLD).toBe("CAD");
  });

  it("uuid5 is RFC 4122 version 5", () => {
    expect(uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    expect(uuid5(HOUSEHOLD, "account|somewhere else")).toBe("18cc5b8e-86fc-54ff-b6ce-c0406dbdf770"); // python uuid.uuid5
  });
});

describe("money", () => {
  it("parses as core's MoneyParser, half away from zero on the text", () => {
    expect(parseMoney("0.125", cad, "dot")).toBe(13);
    expect(parseMoney("-0.125", cad, "dot")).toBe(-13);
    expect(parseMoney("(1,234.56)", cad, "dot")).toBe(-123456);
    expect(parseMoney("1.234,56 €", cad, "comma")).toBe(123456);
    expect(parseMoney("12-", cad, "dot")).toBe(-1200);
    expect(parseMoney("CA$ 84.20", cad, "dot")).toBe(8420);
    expect(parseMoney("abc", cad, "dot")).toBeNull();
    expect(parseMoney("1000", requireCurrency("JPY"), "dot")).toBe(1000);
    expect(parseMoney("1.2345", requireCurrency("BHD"), "dot")).toBe(1235);
  });

  it("reads what a person typed whatever the keyboard's decimal key", () => {
    expect(parseTyped("12,5", cad, "dot")).toBe(1250);
    expect(parseTyped("1.234,56", cad, "dot")).toBe(123456);
    expect(parseTyped("1,234", cad, "dot")).toBe(123400);
    expect(parseTyped(".5", cad, "dot")).toBe(50);
  });

  it("formats with a real minus and a + on money in", () => {
    expect(formatMoney(-8420, "CAD")).toBe("−$84.20");
    expect(formatMoney(250000, "CAD", "en-CA", true)).toBe("+$2,500.00");
  });
});

describe("dates and stamps", () => {
  it("reads java.time-style patterns strictly", () => {
    expect(parseDate("1/5/2030", "M/d/yyyy")).toBe("2030-01-05");
    expect(parseDate("1/5/2030", "MM/dd/yyyy")).toBeNull();
    expect(parseDate("31/02/2030", "dd/MM/yyyy")).toBeNull();
    expect(parseDate("20300105", "yyyyMMdd")).toBe("2030-01-05");
    expect(parseDate("05.01.30", "dd.MM.yy")).toBe("2030-01-05");
  });

  it("an edit is stamped after the version it edits, whatever the clock (SyncEngine.stampFor)", () => {
    expect(stampFor("2030-01-15T12:00:00.000Z", new Date("2030-01-15T13:00:00Z"))).toBe("2030-01-15T13:00:00.000Z");
    expect(stampFor("2030-01-15T12:00:00.000Z", new Date("2030-01-15T11:00:00Z"))).toBe("2030-01-15T12:00:00.001Z");
    expect(stampFor("2030-01-15T12:00:00.000Z", new Date("2030-01-15T12:00:00Z"))).toBe("2030-01-15T12:00:00.001Z");
    expect(stampFor(null, new Date("2030-01-15T12:00:00Z"))).toBe("2030-01-15T12:00:00.000Z");
  });
});

import { byDay, monthTotals, newTransaction, problem, shiftMonth, withKind } from "@/lib/ledger";
import type { LocalRow } from "@/lib/sync";
import { BOB, CASH, GROCERIES as G } from "./support";

describe("ledger figures", () => {
  const cfg = {
    config_version: 1, me_member_id: ALICE, members: config.members, accounts: config.accounts, categories: config.categories,
    household: { id: HOUSEHOLD, name: "Demo", currency: "CAD", locale: "en-CA", period_start_day: 1, income_shift_day: null, week_start: 1, member_limit: 20, money_mode: null },
    custom_fields: [], budgets: [], recurring_rules: [], categorization_rules: [], import_profiles: [],
  } as import("@/lib/model").Config;
  const row = (over: Partial<import("@/lib/model").Transaction>, state: LocalRow["state"] = "synced"): LocalRow => ({
    tx: { ...newTransaction(cfg, over.kind ?? "expense", over.date ?? "2030-01-15"), category_id: G, amount_minor: 1000, created_at: "2030-01-15T00:00:00.000Z", client_updated_at: "2030-01-15T00:00:00.000Z", ...over },
    state, base: null,
  });

  it("a new expense is paid by me and split between everyone", () => {
    const t = newTransaction(cfg, "expense", "2030-01-15");
    expect(t.paid_by_member_id).toBe(ALICE);
    expect(t.split).toEqual({ mode: "equal", members: [ALICE, BOB] });
    expect(t.account_id).toBe(MAIN);
    expect(problem(t)).toBe("Type an amount");
    expect(problem({ ...t, amount_minor: 100 })).toBe("Choose a category");
    const tr = withKind(cfg, { ...t, category_id: G }, "transfer");
    expect([tr.category_id, tr.split, tr.paid_by_member_id, tr.to_account_id]).toEqual([null, null, ALICE, CASH]); // who paid is optional on a transfer, and kept
  });

  it("month totals count what is held, not deleted or refused rows", () => {
    const rows = [
      row({ amount_minor: 4210 }),
      row({ kind: "refund", amount_minor: 210 }),
      row({ kind: "income", category_id: SALARY, amount_minor: 250000 }),
      row({ amount_minor: 999, status: "deleted" }),
      row({ amount_minor: 777 }, "rejected"),
      row({ amount_minor: 5000, date: "2030-02-01" }),
      row({ kind: "transfer", category_id: null, amount_minor: 10000, to_account_id: CASH }),
    ];
    expect(monthTotals(rows, "2030-01")).toEqual({ spentMinor: 4000, incomeMinor: 250000 });
    expect(byDay(rows, "2030-02").map((d) => d.date)).toEqual(["2030-02-01"]);
    expect(shiftMonth("2030-01", -1)).toBe("2029-12");
    expect(shiftMonth("2030-12", 1)).toBe("2031-01");
  });
});
