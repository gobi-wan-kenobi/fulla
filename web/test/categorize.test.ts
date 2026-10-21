// SPDX-License-Identifier: GPL-3.0-or-later
// Categorisation: cleaning statement text, the order rules → known merchants →
// model → Other, fixed and flexible, bulk changes. Every line here is invented.
import { describe, expect, it } from "vitest";
import {
  categorizeExisting, categoryForKey, cleanMerchant, fallbackCategory, isCatchAll, knownMerchant, matchRule, suggest, words,
} from "@/lib/categorize";
import { DEFAULT_CATEGORIES, UNCATEGORIZED } from "@/lib/defaults";
import { propose, type ProposeInput, type StatementLine } from "@/lib/importers";
import { monthSpendingSplit, recategorized, withRecurrence } from "@/lib/ledger";
import type { CategorizationRule, Category, Transaction } from "@/lib/model";
import type { LocalRow } from "@/lib/sync";
import { nextSort } from "@/lib/rules";
import { ALICE, HOUSEHOLD, MAIN } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A household with Fulla's starting categories, in the given language. */
function household(lang = "en", extra: Partial<Record<string, Partial<Category>>> = {}): Category[] {
  const cats = DEFAULT_CATEGORIES.map((d, i) => ({
    id: id(100 + i), name: d.name[lang], applies_to: d.applies_to, parent_id: null, icon: d.icon, color_index: d.color_index,
    sort: i, archived: false, ...(extra[d.key] ?? {}),
  }));
  return [...cats, { id: id(199), name: UNCATEGORIZED.name[lang], applies_to: "both", parent_id: null, icon: "help", color_index: 11, sort: 1000, archived: false }];
}
const cats = household();
const cat = (name: string, list = cats) => list.find((c) => c.name === name)!;

function rule(n: number, pattern: string, category: string, over: Partial<CategorizationRule> = {}): CategorizationRule {
  return { id: id(n), pattern, action: { category_id: category }, sort: n, active: true, ...over };
}

describe("cleaning bank-statement merchant strings", () => {
  it.each([
    ["TIM HORTONS #1234 TORONTO ON", "tim hortons"],
    ["SQ *BLUE DOOR CAFE TORONTO ON", "blue door cafe"],
    ["POS PURCHASE NO FRILLS 3421 SCARBOROUGH ON", "no frills"],
    ["AMZN MKTP CA*2X4Y6Z8Q1", "amzn mktp"],
    ["SHOPPERS DRUG MART #0123 NORTH YORK ON", "shoppers drug mart"],
    ["Uber* Eats", "uber eats"],
    ["PRESTO FARE/A1B2C3D4 TORONTO ON", "presto fare"],
    ["Visa Debit Purchase - LCBO/RAO #217 ON", "lcbo"],
    ["Pré-autorisé Café Résumé", "pre autorise cafe resume"],
    ["NETFLIX.COM", "netflix"],
    ["12345", "12345"],
  ])("%s → %s", (raw, clean) => expect(cleanMerchant(raw)).toBe(clean));

  it("words keep & and drop apostrophes, as patterns are written", () => {
    expect(words("A&W #44")).toBe("a&w 44");
    expect(words("McDonald's  Restaurant")).toBe("mcdonalds restaurant");
  });
});

describe("known merchants", () => {
  it.each([
    ["TIM HORTONS #1234 TORONTO ON", "eating_out"],
    ["UBER* EATS PENDING", "eating_out"],
    ["UBER *TRIP HELP.UBER.COM", "transport"],
    ["TACO BELL #031", "eating_out"],
    ["BELL CANADA (OB)", "utilities"],
    ["SHOPPERS DRUG MART #0123", "health"],
    ["LOBLAWS 1012", "groceries"],
    ["COSTCO WHOLESALE W530", "groceries"],
    ["PETRO-CANADA 98765", "transport"],
    ["ROGERS ******1234", "utilities"],
    ["ENBRIDGE GAS DISTRIB", "utilities"],
    ["SPOTIFY P1234ABCD", "subscriptions/streaming"],
    ["AMAZON.CA", "shopping"],
    ["CANADIAN TIRE #102", "shopping"],
    ["LCBO/RAO #217", "leisure"],
  ])("%s means %s", (text, key) => expect(knownMerchant(text)?.merchant.expense).toBe(key));

  it("whole words only: METROLINX is not METRO, PAYMENT is not PAY", () => {
    expect(knownMerchant("METROLINX GO 123")?.merchant.expense).toBe("transport");
    expect(knownMerchant("PAYMENT THANK YOU")).toBeNull();
    expect(knownMerchant("Blue Door Cafe")).toBeNull();
  });

  it("pay and e-transfers depend on the direction", () => {
    expect(suggest("PAYROLL DEPOSIT EXAMPLE CORP", "income", [], cats)?.category.name).toBe("Salary");
    expect(suggest("PAYROLL DEPOSIT EXAMPLE CORP", "expense", [], cats)).toBeNull();
    expect(suggest("INTERAC e-Transfer From: A PERSON", "income", [], cats)?.category.name).toBe("Other income");
    expect(suggest("INTERAC e-Transfer To: A PERSON", "expense", [], cats)?.category.name).toBe("Other");
  });

  it("is matched to the household's own names, in its language", () => {
    const fr = household("fr");
    expect(suggest("TIM HORTONS #1", "expense", [], fr)?.category.name).toBe("Restaurants");
    expect(categoryForKey(fr, "groceries", "expense")?.name).toBe("Courses");
  });

  it("a starting category the household archived or renamed is simply not matched", () => {
    const archived = household("en", { eating_out: { archived: true } });
    expect(suggest("TIM HORTONS", "expense", [], archived)).toBeNull();
    const renamed = household("en", { eating_out: { name: "Takeaway" } });
    expect(suggest("TIM HORTONS", "expense", [], renamed)).toBeNull();
  });

  it("bills come out fixed", () => {
    expect(suggest("ROGERS WIRELESS", "expense", [], cats)?.fixed).toBe(true);
    expect(suggest("TIM HORTONS", "expense", [], cats)?.fixed).toBe(false);
    const fixedGroceries = household("en", { groceries: { fixed: true } });
    expect(suggest("NO FRILLS", "expense", [], fixedGroceries)?.fixed).toBe(true);
  });
});

describe("precedence: household rules, then known merchants, then the catch-all", () => {
  it("a rule beats a known merchant", () => {
    const rules = [rule(1, "tim hortons", cat("Groceries").id)];
    const s = suggest("TIM HORTONS #1234 TORONTO ON", "expense", rules, cats);
    expect(s?.source).toBe("rule");
    expect(s?.category.name).toBe("Groceries");
  });

  it("paused and deleted rules never match; the first live rule by sort wins", () => {
    const rules = [
      rule(1, "hortons", cat("Shopping").id, { active: false }),
      rule(2, "tim", cat("Leisure").id, { archived: true }),
      rule(4, "tim hortons", cat("Health").id),
      rule(3, "hortons", cat("Groceries").id),
    ];
    expect(matchRule(rules, "TIM HORTONS")?.id).toBe(id(3));
    expect(suggest("TIM HORTONS", "expense", rules, cats)?.category.name).toBe("Groceries");
  });

  it("a rule whose category cannot take this kind falls through to the merchants", () => {
    const rules = [rule(1, "tim hortons", cat("Salary").id)];
    expect(suggest("TIM HORTONS", "expense", rules, cats)?.source).toBe("merchant");
  });

  it("the catch-all is Other or Other income, else Uncategorized", () => {
    expect(fallbackCategory(cats, "expense")?.name).toBe("Other");
    expect(fallbackCategory(cats, "income")?.name).toBe("Other income");
    const noOther = household("en", { other: { archived: true } });
    expect(fallbackCategory(noOther, "expense")?.name).toBe("Uncategorized");
    expect(isCatchAll(cat("Other"))).toBe(true);
    expect(isCatchAll(cat("Uncategorized"))).toBe(true);
    expect(isCatchAll(cat("Groceries"))).toBe(false);
  });
});

describe("imports: rules, the file's own category, known merchants, Other", () => {
  const line = (description: string, amountMinor: number, extra: Partial<StatementLine> = {}): StatementLine =>
    ({ date: "2030-03-02", amountMinor, description, ...extra });
  const plan = (lines: StatementLine[], over: Partial<ProposeInput> = {}) =>
    propose({
      householdId: HOUSEHOLD, accountId: MAIN, lines, rules: [], uncategorizedExpenseId: cat("Other").id,
      uncategorizedIncomeId: cat("Other income").id, payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(),
      now: "2030-03-06T00:00:00.000Z", names: { categories: cats, members: [], accounts: [] }, knownMerchants: true, ...over,
    });

  it("each line says where its category came from", () => {
    const p = plan(
      [
        line("TIM HORTONS #12 TORONTO ON", -245),
        line("BLUE DOOR CAFE", -1800),
        line("CORNER STORE", -999, { bankCategory: "Groceries" }),
        line("NO FRILLS 3421", -5432),
        line("PAYROLL DEPOSIT EXAMPLE CORP", 250000),
        line("A SIDE GIG", 5000),
      ],
      { rules: [rule(1, "blue door", cat("Eating out").id)] },
    );
    const got = p.map((x) => [x.source, cats.find((c) => c.id === x.transaction.category_id)?.name, x.transaction.kind]);
    expect(got).toEqual([
      ["merchant", "Eating out", "expense"],
      ["rule", "Eating out", "expense"],
      ["file", "Groceries", "expense"],
      ["merchant", "Groceries", "expense"],
      ["merchant", "Salary", "income"],
      ["fallback", "Other income", "income"],
    ]);
    expect(p[1].matchedRule?.pattern).toBe("blue door");
    expect(p[0].matchedMerchant?.pattern).toBe("tim hortons");
  });

  it("money back from a shop is a refund in its category", () => {
    const [p] = plan([line("AMAZON.CA REFUND", 2599)]);
    expect(p.transaction.kind).toBe("refund");
    expect(cats.find((c) => c.id === p.transaction.category_id)?.name).toBe("Shopping");
  });

  it("bills and fixed categories import as fixed; the file's own say wins", () => {
    const fixedHousing = household("en", { housing: { fixed: true } });
    const p = plan(
      [line("ROGERS WIRELESS", -9000), line("TIM HORTONS", -245), line("LANDLORD", -150000, { bankCategory: "Housing" }), line("ROGERS", -100, { fixed: false })],
      { names: { categories: fixedHousing, members: [], accounts: [] }, uncategorizedExpenseId: cat("Other", fixedHousing).id },
    );
    expect(p.map((x) => x.transaction.recurrence)).toEqual(["fixed", "variable", "fixed", "variable"]);
  });

  it("without knownMerchants the plan is the Android one (parity)", () => {
    const [p] = plan([line("TIM HORTONS", -245)], { knownMerchants: false });
    expect(p.source).toBe("fallback");
    expect(p.transaction.category_id).toBe(cat("Other").id);
  });

  it("the ids do not depend on how a line was categorised", () => {
    const a = plan([line("TIM HORTONS", -245)])[0].transaction.id;
    const b = plan([line("TIM HORTONS", -245)], { knownMerchants: false, rules: [rule(1, "tim", cat("Shopping").id)] })[0].transaction.id;
    expect(a).toBe(b);
  });
});

function tx(n: number, over: Partial<Transaction>): Transaction {
  return {
    id: id(n), kind: "expense", date: "2030-03-02", amount_minor: 1000, category_id: cat("Other").id, account_id: MAIN,
    to_account_id: null, paid_by_member_id: ALICE, to_member_id: null, split: null, recurrence: "variable", note: "",
    tags: [], extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null,
    original_currency: null, created_at: "2030-03-02T00:00:00.000Z", client_updated_at: "2030-03-02T00:00:00.000Z", ...over,
  };
}
const row = (t: Transaction): LocalRow => ({ tx: t, state: "synced", base: null });

describe("applying rules to what is already there, and bulk changes", () => {
  it("only rows still in a catch-all are sorted, and only when something now knows them", () => {
    const rows = [
      row(tx(1, { note: "TIM HORTONS #1" })),
      row(tx(2, { note: "TIM HORTONS #2", category_id: cat("Leisure").id })), // someone chose this
      row(tx(3, { note: "BLUE DOOR CAFE" })),
      row(tx(4, { note: "BLUE DOOR CAFE", category_id: cat("Uncategorized").id })),
      row(tx(5, { note: "NO FRILLS", status: "deleted" })),
      row(tx(6, { note: "PAYROLL EXAMPLE", kind: "income", category_id: cat("Other income").id })),
      row(tx(7, { note: "TIM HORTONS", kind: "transfer", category_id: null })),
    ];
    const rules = [rule(1, "blue door", cat("Eating out").id)];
    const out = categorizeExisting(rows, rules, cats).map((c) => [c.row.tx.id, c.category.name, c.source]);
    expect(out).toEqual([
      [id(1), "Eating out", "merchant"],
      [id(3), "Eating out", "rule"],
      [id(4), "Eating out", "rule"],
      [id(6), "Salary", "merchant"],
    ]);
  });

  it("moving a row takes the new category's fixed or flexible default; transfers and wrong kinds refuse", () => {
    const fixedUtilities = { ...cat("Utilities"), fixed: true };
    expect(recategorized(tx(1, {}), fixedUtilities)).toMatchObject({ category_id: fixedUtilities.id, recurrence: "fixed" });
    expect(recategorized(tx(1, { recurrence: "fixed" }), cat("Leisure"))).toMatchObject({ recurrence: "variable" });
    expect(recategorized(tx(1, { kind: "income" }), cat("Leisure"))).toBeNull();
    expect(recategorized(tx(1, { kind: "transfer", category_id: null }), cat("Leisure"))).toBeNull();
    expect(withRecurrence(tx(1, {}), true)?.recurrence).toBe("fixed");
    expect(withRecurrence(tx(1, { kind: "transfer" }), true)).toBeNull();
  });

  it("a month's spending splits into fixed and flexible; refunds come off, income and other months do not count", () => {
    const rows = [
      row(tx(1, { amount_minor: 150000, recurrence: "fixed" })),
      row(tx(2, { amount_minor: 2500 })),
      row(tx(3, { amount_minor: 500, kind: "refund" })),
      row(tx(4, { amount_minor: 9000, kind: "income", recurrence: "fixed" })),
      row(tx(5, { amount_minor: 7000, date: "2030-04-01" })),
      row(tx(6, { amount_minor: 7000, status: "deleted" })),
      { ...row(tx(7, { amount_minor: 7000 })), state: "rejected" as const },
    ];
    expect(monthSpendingSplit(rows, "2030-03")).toEqual({ fixedMinor: 150000, flexibleMinor: 2000 });
  });
});

describe("rule order", () => {
  it("a new rule goes after every rule there is, deleted ones included", () => {
    expect(nextSort([])).toBe(0);
    expect(nextSort([rule(1, "a", cat("Other").id, { sort: 4 }), rule(2, "b", cat("Other").id, { sort: 9, archived: true })])).toBe(10);
  });
});
