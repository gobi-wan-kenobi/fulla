// SPDX-License-Identifier: GPL-3.0-or-later
// Subscriptions › Software and › Streaming & entertainment (0035). Every name,
// amount and line here is invented; the services are brand names only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetUse } from "@/lib/budgets";
import { categoryForPath, knownMerchant, suggest } from "@/lib/categorize";
import { modelCategory } from "@/lib/categorizer";
import { SHARED_DEFAULT_CATEGORIES, SHARED_SUBCATEGORIES, WEB_DEFAULT_CATEGORIES } from "@/lib/defaults";
import { KNOWN_MERCHANTS } from "@/lib/merchants";
import type { Category, Transaction } from "@/lib/model";
import { byCategory } from "@/lib/overview";
import { ALICE, category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SUBS = category(id(1), "Subscriptions", "expense");
const SOFTWARE = category(id(2), "Software", "expense", { parent_id: SUBS.id });
const STREAMING = category(id(3), "Streaming & entertainment", "expense", { parent_id: SUBS.id });
const LEISURE = category(id(4), "Leisure", "expense");
const OTHER = category(id(5), "Other", "expense");
const WITH: Category[] = [SUBS, SOFTWARE, STREAMING, LEISURE, OTHER];
const WITHOUT: Category[] = [SUBS, LEISURE, OTHER];

describe("the defaults", () => {
  it("put Software and Streaming & entertainment under the shared Subscriptions, in every language", () => {
    const [g] = SHARED_SUBCATEGORIES;
    expect(g.parent).toBe("subscriptions");
    expect(SHARED_DEFAULT_CATEGORIES.some((d) => d.key === "subscriptions")).toBe(true);
    expect(g.subcategories.map((s) => [s.key, s.name.en])).toEqual([["software", "Software"], ["streaming", "Streaming & entertainment"]]);
    const langs = Object.keys(SHARED_DEFAULT_CATEGORIES[0].name);
    for (const s of g.subcategories) expect(Object.keys(s.name).sort()).toEqual([...langs].sort());
  });

  it("every merchant key is a starting category, or a subcategory of one", () => {
    const subs = (p: string) => [...SHARED_SUBCATEGORIES.filter((g) => g.parent === p).flatMap((g) => g.subcategories), ...(WEB_DEFAULT_CATEGORIES.find((d) => d.key === p)?.subcategories ?? [])].map((s) => s.key);
    const tops = [...SHARED_DEFAULT_CATEGORIES, ...WEB_DEFAULT_CATEGORIES].map((d) => d.key);
    for (const m of KNOWN_MERCHANTS) for (const k of [m.expense, m.income].filter((x): x is string => !!x)) {
      const [p, s] = k.split("/");
      expect(tops).toContain(p);
      if (s) expect(subs(p)).toContain(s);
    }
  });
});

describe("known merchants", () => {
  it.each([
    ["VERCEL INC COVINA CA", SOFTWARE], ["OPENROUTER INC NEW YORK NY", SOFTWARE], ["SUPERHUMAN MAIL SAN FRANCISCO", SOFTWARE], ["MOZILLACORP 0001", SOFTWARE],
    ["NETFLIX.COM 866-000-0000", STREAMING], ["Spotify P0000ABCD", STREAMING], ["DISNEY PLUS 0000", STREAMING], ["CRAVE 0000 TORONTO ON", STREAMING],
    ["PRIME VIDEO*AB12CD", STREAMING], ["APPLE TV+ 0000", STREAMING], ["YOUTUBE PREMIUM", STREAMING], ["APPLE MUSIC 0000", STREAMING],
    ["APPLE.COM/BILL 866-000-0000", SUBS], ["DROPBOX*AB12", SUBS],
  ])("%s → %s", (text, c) => expect(suggest(text, "expense", [], WITH)).toMatchObject({ category: c, source: "merchant" }));

  it("fall back to Subscriptions in a household without the subcategories", () => {
    expect(suggest("VERCEL INC", "expense", [], WITHOUT)?.category).toBe(SUBS);
    expect(suggest("NETFLIX.COM", "expense", [], WITHOUT)?.category).toBe(SUBS);
    expect(categoryForPath(WITH, "subscriptions/software", "expense")).toBe(SOFTWARE);
    expect(categoryForPath(WITH, "subscriptions/nothing", "expense")).toBe(SUBS);
    expect(categoryForPath([LEISURE], "subscriptions/software", "expense")).toBeNull();
  });

  it("only clear descriptors: an ordinary word is not a service", () => {
    expect(knownMerchant("EXAMPLE APPLE ORCHARD")).toBeNull();
    expect(knownMerchant("EXAMPLE MUSIC SCHOOL")).toBeNull();
    expect(knownMerchant("EXAMPLE TV REPAIR")).toBeNull();
  });
});

describe("Jev", () => {
  const q = JSON.parse(readFileSync(join(__dirname, "../src/lib/categorize/jev/questions.v2.json"), "utf8"));
  it("asks both subcategories under Entertainment & Recreation, in the cookbook format", () => {
    const opts = q.questions.sub__entertainment___recreation.criteria;
    for (const k of ["Software", "Streaming & Entertainment"]) {
      expect(typeof opts[k].includes).toBe("string");
      expect(opts[k].examples.length).toBeGreaterThan(3);
      expect(typeof opts[k].excludes).toBe("string");
    }
    expect(opts["Subscriptions"]).toBeUndefined();
    expect(opts["Streaming Subscriptions"]).toBeUndefined();
    expect(Object.keys(q.fulla_subscription_subcategories).sort()).toEqual(["Software", "Streaming & Entertainment"]);
  });

  it("maps the answers to the household's subcategories, else Subscriptions", () => {
    const a = (sub: string) => ({ parent: "Entertainment & Recreation", subcategory: sub, spending: null });
    expect(modelCategory(WITH, a("Software"), "expense")).toBe(SOFTWARE);
    expect(modelCategory(WITH, a("Streaming & Entertainment"), "expense")).toBe(STREAMING);
    expect(modelCategory(WITHOUT, a("Software"), "expense")).toBe(SUBS);
    expect(modelCategory(WITH, a("Video Games"), "expense")).toBe(LEISURE);
  });
});

describe("Budgets and reports", () => {
  const tx = (n: number, c: Category, amount: number): Transaction => ({
    id: id(100 + n), kind: "expense", date: "2030-03-0" + n, amount_minor: amount, category_id: c.id, account_id: null, to_account_id: null, paid_by_member_id: ALICE,
    to_member_id: null, split: null, recurrence: "fixed", note: "", tags: [], extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null,
    import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "",
  });
  const rows = [tx(1, SOFTWARE, 2000), tx(2, STREAMING, 1500), tx(3, SUBS, 500)];
  it("roll the subcategories up under Subscriptions", () => {
    expect(budgetUse(rows, WITH, new Map([[SUBS.id, 10000], [SOFTWARE.id, 3000]]), "2030-03").get(SUBS.id)).toBe(4000);
    const top = byCategory(rows, WITH, "2030-03");
    expect(top.map((c) => [c.categoryId, c.amountMinor])).toEqual([[SUBS.id, 4000]]);
  });
});
