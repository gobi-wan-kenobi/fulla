// SPDX-License-Identifier: GPL-3.0-or-later
// The review queue by merchant, and a categorizer that never makes a
// transfer. Every name, amount and merchant here is invented.
import { describe, expect, it } from "vitest";
import { type ModelAnswer, modelOutcome } from "@/lib/categorizer";
import { suggest } from "@/lib/categorize";
import { sourceOf } from "@/lib/examples";
import { buildImport, newAccounts, propose, type StatementLine } from "@/lib/importers";
import type { Account, CategorizationRule, Category, Transaction } from "@/lib/model";
import { needsReview, REVIEW_TAG, suggestedId, suggestionTag, UNMATCHED_TAG, withSuggestion } from "@/lib/review";
import { decideGroup, merchantKey, reviewGroups, rulePatternFor } from "@/lib/reviewQueue";
import { ALICE, HOUSEHOLD, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OTHER = category(id(901), "Other", "expense");
const OTHER_IN = category(id(902), "Other income", "income");
const GROCERIES = category(id(903), "Groceries", "expense");
const EATING = category(id(904), "Eating out", "expense");
const GIFTS = category(id(905), "Gifts", "expense");
const SALARY = category(id(906), "Salary", "income");
const CATEGORIES: Category[] = [OTHER, OTHER_IN, GROCERIES, EATING, GIFTS, SALARY];
const BANK: Account = { id: id(301), name: "Example Bank", type: "checking", opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false };

let n = 0;
function tx(note: string, amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  n++;
  return {
    id: id(5000 + n), kind: "expense", date, amount_minor: amount, category_id: OTHER.id, account_id: BANK.id, to_account_id: null,
    paid_by_member_id: ALICE, to_member_id: null, split: null, recurrence: "variable", note, tags: [REVIEW_TAG], extras: {}, status: "active",
    recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null,
    created_at: "2030-01-01T00:00:00.000Z", client_updated_at: "2030-01-01T00:00:00.000Z", ...extra,
  };
}
const row = (t: Transaction) => ({ tx: t });

describe("a model never makes a transfer", () => {
  const answer = (parent: string, sub: string | null, confidence: number, review = false): ModelAnswer => ({ parent, subcategory: sub, spending: null, confidence, review, by: "jev" });

  it("sends a transfer answer to review with no suggestion, whatever its confidence", () => {
    for (const a of [answer("Transfers", "Account Transfer", 0.97), answer("Savings & Investing", "Brokerage", 0.9), answer("Debt Payments", "Credit Card Payment", 0.88)]) {
      expect(modelOutcome(CATEGORIES, a, "expense", "EXAMPLE XFER 0001")).toEqual({ category: null, review: true, suggestion: null, confidence: null });
    }
  });

  it("files a sure answer, and keeps an unsure one's real category only as the suggestion", () => {
    expect(modelOutcome(CATEGORIES, answer("Groceries", null, 0.92), "expense", "EXAMPLE MARKET")).toMatchObject({ category: GROCERIES, review: false });
    expect(modelOutcome(CATEGORIES, answer("Groceries", null, 0.41, true), "expense", "EXAMPLE MARKET")).toMatchObject({ category: null, review: true, suggestion: GROCERIES, confidence: 0.41 });
    expect(modelOutcome(CATEGORIES, answer("Miscellaneous Fees", null, 0.3, true), "expense", "EXAMPLE THING")?.suggestion).toBeNull();
  });

  it("imports the categorizer's transfer as spending in review, on its own account, with no account made", () => {
    const lines: StatementLine[] = [
      { date: "2030-02-03", amountMinor: -12000, description: "EXAMPLE MOVE 0042" },
      { date: "2030-02-04", amountMinor: -2550, description: "EXAMPLE CORNER MARKET" },
      { date: "2030-02-05", amountMinor: 30000, description: "EXAMPLE INCOMING 77" },
    ];
    const proposals = propose({
      householdId: HOUSEHOLD, accountId: BANK.id, lines, rules: [], uncategorizedExpenseId: OTHER.id, uncategorizedIncomeId: OTHER_IN.id,
      payerMemberId: ALICE, defaultSplit: null, existingIds: new Set(), now: "2030-03-01T00:00:00.000Z",
      names: { categories: CATEGORIES, members: [], accounts: [BANK] }, knownMerchants: true, knownTransfers: true,
    });
    const [move, shop, incoming] = proposals.map((p) => p.transaction.id);
    const answers: Record<string, ModelAnswer> = {
      [move]: answer("Transfers", "Account Transfer", 0.96),
      [shop]: answer("Groceries", null, 0.5, true),
      [incoming]: answer("Savings & Investing", null, 0.9),
    };
    const out = buildImport({ householdId: HOUSEHOLD, categories: CATEGORIES, accounts: [BANK], rows: [], proposals, createdAccounts: newAccounts(proposals), accountId: BANK.id, proposedAccount: null, statement: null, answers });
    expect(out.accounts).toEqual([]);
    const byId = new Map(out.insert.map((t) => [t.id, t]));
    for (const k of [move, incoming]) {
      const t = byId.get(k)!;
      expect(t.kind === "expense" || t.kind === "income").toBe(true);
      expect(t.to_account_id).toBeNull();
      expect(t.account_id).toBe(BANK.id);
      expect(needsReview(t)).toBe(true);
      expect(t.tags).not.toContain(UNMATCHED_TAG);
      expect(suggestedId(t, CATEGORIES.map((c) => c.id))).toBeNull();
    }
    expect(byId.get(move)!.category_id).toBe(OTHER.id);
    expect(byId.get(incoming)!.category_id).toBe(OTHER_IN.id);
    const s = byId.get(shop)!;
    expect(s.category_id).toBe(OTHER.id);
    expect(suggestedId(s, CATEGORIES.map((c) => c.id))).toBe(GROCERIES.id);
    expect(sourceOf(s).confidence).toBe(0.5);
    expect(out.insert.every((t) => t.kind !== "transfer")).toBe(true);
  });
});

describe("the review queue by merchant", () => {
  it("groups a merchant's lines under the name rules use, money out and money in apart", () => {
    expect(merchantKey(tx("SQ *EXAMPLE BAKERY #12 TORONTO ON", 1, "2030-01-01")).key).toBe(merchantKey(tx("EXAMPLE BAKERY #4471 TORONTO ON", 1, "2030-01-02")).key);
    expect(merchantKey(tx("EXAMPLE BAKERY", 1, "2030-01-01")).key).not.toBe(merchantKey(tx("EXAMPLE BAKERY", 1, "2030-01-01", { kind: "income" })).key);
  });

  it("shows count, total, dates and a suggestion; sorts by lines, then total", () => {
    const rows = [
      tx("EXAMPLE BAKERY #12 TORONTO ON", 450, "2030-01-03", { tags: [REVIEW_TAG, suggestionTag(EATING.id), "fulla:conf:60"] }),
      tx("EXAMPLE BAKERY #19 TORONTO ON", 650, "2030-03-09", { tags: [REVIEW_TAG, suggestionTag(EATING.id), "fulla:conf:40"] }),
      tx("EXAMPLE BAKERY #19 TORONTO ON", 200, "2030-02-01"),
      tx("EXAMPLE HARDWARE 0099", 9000, "2030-02-10"),
      tx("EXAMPLE HARDWARE 0099", 1000, "2030-02-11"),
      tx("EXAMPLE BIG STORE", 50000, "2030-02-12"),
      tx("EXAMPLE TINY KIOSK", 300, "2030-02-12"),
      tx("EXAMPLE SORTED ALREADY", 300, "2030-02-12", { tags: [] }),
    ].map(row);
    const g = reviewGroups(rows, CATEGORIES, []);
    expect(g.map((x) => [x.publicLabel, x.count, x.totalMinor])).toEqual([
      ["Example Bakery", 3, 1300],
      ["Example Hardware", 2, 10000],
      ["Example Big Store", 1, 50000],
      ["Example Tiny Kiosk", 1, 300],
    ]);
    expect([g[0].firstDate, g[0].lastDate]).toEqual(["2030-01-03", "2030-03-09"]);
    expect(g[0].rows.map((r) => r.tx.date)).toEqual(["2030-03-09", "2030-02-01", "2030-01-03"]);
    // Two of three lines suggest Eating out; the third, with none, counts as not sure.
    expect(g[0].suggestion).toMatchObject({ category: EATING, source: "categorizer", lines: 2 });
    expect(g[0].suggestion!.confidence).toBeCloseTo((0.6 + 0.4) / 3);
    expect(g[1].suggestion).toBeNull();
    expect(g[0].rulePattern).toBe("example bakery");
  });

  it("suggests what you chose before for the merchant, and a rule that now matches first", () => {
    const past = [tx("EXAMPLE DELI 01", 100, "2029-12-01", { tags: [], category_id: GROCERIES.id }), tx("EXAMPLE DELI 02", 100, "2029-12-02", { tags: [], category_id: GROCERIES.id }), tx("EXAMPLE DELI 03", 100, "2029-12-03", { tags: [], category_id: EATING.id })];
    const waiting = [tx("EXAMPLE DELI 04", 100, "2030-01-01")];
    const g = reviewGroups(waiting.map(row), CATEGORIES, [], [...past, ...waiting]);
    expect(g[0].suggestion).toMatchObject({ category: GROCERIES, source: "history" });
    expect(g[0].suggestion!.confidence).toBeCloseTo(2 / 3);
    // A less sure categorizer guess does not hide it; a surer one wins.
    const unsure = [tx("EXAMPLE DELI 05", 100, "2030-01-02", { tags: [REVIEW_TAG, suggestionTag(EATING.id), "fulla:conf:30"] })];
    expect(reviewGroups(unsure.map(row), CATEGORIES, [], [...past, ...unsure])[0].suggestion).toMatchObject({ category: GROCERIES, source: "history" });
    const sure = [tx("EXAMPLE DELI 06", 100, "2030-01-02", { tags: [REVIEW_TAG, suggestionTag(EATING.id), "fulla:conf:90"] })];
    expect(reviewGroups(sure.map(row), CATEGORIES, [], [...past, ...sure])[0].suggestion).toMatchObject({ category: EATING, source: "categorizer" });
    const rule: CategorizationRule = { id: id(801), pattern: "example deli", action: { category_id: EATING.id }, sort: 0, active: true, archived: false };
    expect(reviewGroups(waiting.map(row), CATEGORIES, [rule], [...past, ...waiting])[0].suggestion).toMatchObject({ category: EATING, source: "rule", confidence: 1 });
  });

  it("groups e-Transfers per person, and nothing it exposes carries the name", () => {
    const rows = [
      tx("Interac e-Transfer® Out to Example Friend", 2000, "2030-01-05"),
      tx("Interac e-Transfer® Out to Example Friend", 3000, "2030-01-20"),
      tx("Interac e-Transfer® Out to Another Example", 1000, "2030-01-21"),
      tx("Interac e-Transfer® In from Example Friend", 500, "2030-01-22", { kind: "income", category_id: OTHER_IN.id }),
      tx("Interac e-Transfer® Out", 700, "2030-01-23"),
      tx("Interac e-Transfer® Out", 800, "2030-01-24"),
      tx("Interac e-Transfer® Out", 900, "2030-01-25"),
    ].map(row);
    const g = reviewGroups(rows, CATEGORIES, []);
    expect(g.map((x) => [x.person, x.count, x.side])).toEqual([[true, 3, "out"], [true, 2, "out"], [true, 1, "out"], [true, 1, "in"]]);
    // No name on the statement: one group, a person's all the same, and no rule (it would match every e-Transfer).
    expect(g[0]).toMatchObject({ label: "e-Transfer sent, no name on the statement", rulePattern: null });
    g.shift();
    expect(g[0].label).toBe("e-Transfer to Example Friend"); // on the household's own screen only
    for (const x of g) {
      expect(x.publicLabel).toBe("e-Transfer to/from a person");
      expect(`${x.id} ${x.publicLabel}`.toLowerCase()).not.toMatch(/friend|another/);
    }
    expect(g[0].rulePattern).toBe("example friend");
  });

  it("one decision sorts every line, clears review and the suggestion, and skips what cannot take the category", () => {
    const rows = [
      tx("EXAMPLE BAKERY 1", 450, "2030-01-03", { tags: [REVIEW_TAG, suggestionTag(EATING.id), "fulla:conf:60", "fulla:st:abcdef123456:v1"] }),
      tx("EXAMPLE BAKERY 2", 120, "2030-01-04", { kind: "refund" }),
    ].map(row);
    const [g] = reviewGroups(rows, CATEGORIES, []);
    const { changes, skipped } = decideGroup(g, EATING);
    expect(skipped).toBe(0);
    expect(changes).toHaveLength(2);
    for (const c of changes) {
      expect(c.tx.category_id).toBe(EATING.id);
      expect(needsReview(c.tx)).toBe(false);
      expect(c.tx.tags.some((t) => t.startsWith("fulla:sg:"))).toBe(false);
      expect(c.tx.tags).toContain("fulla:by:user");
    }
    expect(changes.find((c) => c.tx.note === "EXAMPLE BAKERY 1")!.tx.tags).toContain("fulla:st:abcdef123456:v1");
    const [inbound] = reviewGroups([row(tx("EXAMPLE PAYER", 900, "2030-01-05", { kind: "income", category_id: OTHER_IN.id }))], CATEGORIES, []);
    expect(decideGroup(inbound, GROCERIES)).toMatchObject({ changes: [], skipped: 1 });
  });

  it("offers a rule only for text every line contains", () => {
    expect(rulePatternFor("example bakery", ["SQ *EXAMPLE BAKERY #1", "EXAMPLE BAKERY 2"])).toBe("example bakery");
    expect(rulePatternFor("examples cafe", ["EXAMPLE'S CAFE"])).toBe("cafe");
    expect(rulePatternFor("ab", ["AB"])).toBeNull();
  });

  it("keeps a suggestion tag within the 30 characters a tag may have", () => {
    expect(suggestionTag(GROCERIES.id).length).toBeLessThanOrEqual(30);
    expect(suggestedId(withSuggestion(tx("x", 1, "2030-01-01"), GROCERIES.id), CATEGORIES.map((c) => c.id))).toBe(GROCERIES.id);
    expect(withSuggestion(withSuggestion(tx("x", 1, "2030-01-01"), GROCERIES.id), null).tags).toEqual([REVIEW_TAG]);
  });
});

describe("merchants added to the known list", () => {
  const SUBS = category(id(907), "Subscriptions", "expense");
  const cats = [...CATEGORIES, SUBS];
  it("puts the developer and mail tools in Subscriptions and the meal kit in Groceries", () => {
    for (const d of ["VERCEL INC COVINA CA", "MOZILLACORP EXAMPLE 0001", "Mozilla VPN", "SUPERHUMAN MAIL SAN FRANCISCO CA"]) {
      expect(suggest(d, "expense", [], cats)).toMatchObject({ category: SUBS, source: "merchant" });
    }
    expect(suggest("COOKUNITY CA TORONTO", "expense", [], cats)).toMatchObject({ category: GROCERIES, source: "merchant" });
    expect(suggest("EXAMPLE VERCELLI CAFE", "expense", [], cats)).toBeNull(); // whole words only
  });

  it("are suggested in review, sure and labelled as the list's, without filing the lines", () => {
    const rows = [tx("COOKUNITY CA TORONTO", 10999, "2030-01-03"), tx("COOKUNITY CA TORONTO", 10999, "2030-01-10")].map(row);
    const [g] = reviewGroups(rows, cats, []);
    expect(g.suggestion).toMatchObject({ category: GROCERIES, source: "merchant", confidence: 1, lines: 2 });
    expect(rows.every((r) => needsReview(r.tx) && r.tx.category_id === OTHER.id)).toBe(true);
  });
});
