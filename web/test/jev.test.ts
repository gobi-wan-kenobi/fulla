// SPDX-License-Identifier: GPL-3.0-or-later
// Jev as the categorizer, with every network call mocked: nothing here
// reaches TypeSafe or Supabase. Every line and name is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { amountBand, dayOfMonth, history, howOftenSeen, payeeKey } from "@/lib/categorize/facts";
import { modelCategory, modelTransfer } from "@/lib/categorizer";
import { DEFAULT_CATEGORIES } from "@/lib/defaults";
import type { Category, Transaction } from "@/lib/model";
import { categorize, provider } from "@/lib/server/categorizer";
import { JEV_CUTOFF, JEV_MODEL, JEV_URL, PARENTS, QUESTIONS, askJev, decodeJev, jevState, subId } from "@/lib/server/jev";
import { LOCAL_CLASSIFIER_ENABLED, askLocal } from "@/lib/server/local";
import { scrub } from "@/lib/server/sanitize";
import { REVIEW_TAG, UNMATCHED_TAG, isUnmatchedTransfer, needsReview, reviewed, withTag, withoutTag } from "@/lib/review";

const KEY = "test-key-not-real-0123456789";

describe("the sanitizer", () => {
  it.each([
    ["Interac e-Transfer® Out to Jane Example", "INTERAC e-Transfer sent"],
    ["Interac e-Transfer® Received from JOHN Q SAMPLE", "INTERAC e-Transfer received"],
    ["Online bill payment for NORTHWIND MASTERCARD, account ••••0000 (executed at 2030-01-03)", "Online bill payment for NORTHWIND MASTERCARD"],
    ["Pre-authorized Debit to goPeer LP-AB12C", "Pre-authorized Debit to goPeer LP"],
    ["SAQ23167 EXAMPLETOWN", "SAQ EXAMPLETOWN"],
    ["FIT4LESS #0042", "FIT4LESS"],
    ["CALL 416-555-0100 or help@example.com EXAMPLE CO", "CALL or EXAMPLE CO"],
    ["Transfer from Example Person", "Transfer from a person"],
    ["Transfer to Example Savings", "Transfer to Example Savings"], // a business word: kept
    ["Purchase at Wealthsimple Example", "Purchase at bank Example"],
    ["RBC ROYAL BANK MORTGAGE", "bank MORTGAGE"],
    ["Sobeys", "Sobeys"],
  ])("%s → %s", (raw, clean) => {
    expect(scrub(raw).text).toBe(clean);
  });

  it("never sends a long number or a masked account", () => {
    for (const raw of ["PAYMENT 1234567890", "ACCT ****1234 EXAMPLE", "REF 12AB34CD EXAMPLE"]) expect(scrub(raw).text).not.toMatch(/\d{4,}|\*{2,}/);
  });
});

describe("the facts sent with a line", () => {
  it("bands the amount, names the day", () => {
    expect(amountBand(645)).toBe("under $10");
    expect(amountBand(-41250)).toBe("$300 to $1,000");
    expect(amountBand(150000)).toBe("over $1,000");
    expect(dayOfMonth("2030-01-03")).toBe("3 (start of month (1st-7th))");
    expect(dayOfMonth("2030-01-28")).toBe("28 (end of month (25th-31st))");
  });

  it("says how often a payee turns up", () => {
    const lines = ["2030-01-02", "2030-02-02", "2030-03-02", "2030-04-02"].map((date) => ({ description: "EXAMPLE STREAMING CO", date, amountMinor: -1599 }));
    const seen = history([...lines, { description: "EXAMPLE CAFE", date: "2030-01-05", amountMinor: -450 }]);
    expect(howOftenSeen("EXAMPLE STREAMING CO", seen)).toBe("about once a month, same amount each time");
    expect(howOftenSeen("EXAMPLE CAFE", seen)).toBe("first time seen");
    expect(payeeKey("Pre-authorized Debit to EXAMPLE LENDER 0001")).toBe("example lender");
  });

  it("goes in the state with the line scrubbed and the real sign", () => {
    const st = jevState({ id: "a", date: "2030-01-15", description: "Interac e-Transfer® Out to Jane Example", amount_minor: 5000, direction: "out", how_often_seen: "first time seen" });
    expect(st).toEqual({ transaction: {
      description: "INTERAC e-Transfer sent", direction: "money out", amount_band_cad: "$30 to $100",
      round_amount: "yes (a round number, typical of transfers and payments)", how_often_seen: "first time seen", day_of_month: "15 (middle of month)",
    } });
    expect(JSON.stringify(st)).not.toContain("Jane");
  });
});

describe("the question set", () => {
  it("asks one Choice over the 19 parents and one per parent, pinned", () => {
    expect(PARENTS).toHaveLength(19);
    for (const p of PARENTS) expect(QUESTIONS[subId(p)]?.type).toBe("choice");
    expect(subId("Dining & Take-out")).toBe("sub__dining___take_out");
    expect(JEV_MODEL).toBe("jev-1.13.0");
    expect(JEV_CUTOFF).toBe(0.7);
  });

  it("has Fulla's Debt payments subcategories", () => {
    expect(Object.keys(QUESTIONS.sub__debt_payments.criteria)).toEqual(
      ["Credit-Card", "Credit-Card Payment", "Personal Loan", "Line of Credit", "Buy Now Pay Later", "Student Loan", "Car Loan", "Other Debt"]);
  });

  it("holds no account numbers, e-mails or phone numbers", () => {
    const text = readFileSync(join(__dirname, "../src/lib/categorize/jev/questions.v2.json"), "utf8");
    expect(text).not.toMatch(/\d{5,}|[∙•]{2,}|@[\w-]+\.\w|\b\d{3}[-.]\d{3}[-.]\d{4}\b/);
  });
});

const probs = (best: string, all: string[], p = 0.9) => Object.fromEntries(all.map((k) => [k, k === best ? p : (1 - p) / (all.length - 1)]));
function answers(parent: string, sub: string, conf: number) {
  const a: Record<string, { probabilities: Record<string, number>; confidence?: number }> = { flat: { probabilities: probs(parent, PARENTS), confidence: conf } };
  for (const p of PARENTS) {
    const subs = Object.keys(QUESTIONS[subId(p)].criteria);
    a[subId(p)] = { probabilities: probs(p === parent ? sub : subs[0], subs, 0.95) };
  }
  return a;
}

describe("decoding Jev's answers", () => {
  it("takes the best parent and subcategory pair, and the parent's confidence", () => {
    expect(decodeJev(answers("Groceries", "Supermarket", 0.92))).toEqual({
      parent: "Groceries", subcategory: "Supermarket", spending: null, confidence: 0.92, review: false, by: "jev",
    });
  });

  it("sends an unsure line to review", () => {
    expect(decodeJev(answers("Shopping", "Other", 0.55))?.review).toBe(true);
    expect(decodeJev(answers("Shopping", "Other", 0.7))?.review).toBe(false);
  });

  it("reads nothing from a broken answer", () => {
    expect(decodeJev(undefined)).toBeNull();
    expect(decodeJev({})).toBeNull();
  });
});

describe("asking Jev (mocked)", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  const item = { id: "t1", date: "2030-03-02", description: "Interac e-Transfer® Out to Jane Example", amount_minor: 5000, direction: "out" as const };

  it("posts the scrubbed state and the question set, with the key only in the header", async () => {
    const f = vi.fn(async (...args: [string, RequestInit]) => void args || new Response(JSON.stringify({ answers: answers("Transfers", "P2P Transfer", 1) }), { status: 200 }));
    const r = await askJev([item], { TYPESAFE_API_KEY: KEY }, f as unknown as typeof fetch);
    expect(r.results.t1).toMatchObject({ parent: "Transfers", subcategory: "P2P Transfer", review: false });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(JEV_URL);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(JSON.stringify(body)).not.toContain("Jane");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("stops on a refused key, and is off without one", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 401 }));
    expect((await askJev([item, { ...item, id: "t2" }], { TYPESAFE_API_KEY: KEY }, f as unknown as typeof fetch)).stopped).toBe("quota");
    expect(await askJev([item], {}, f as unknown as typeof fetch)).toEqual({ results: {}, stopped: "off" });
    expect(await askJev([item], { TYPESAFE_API_KEY: "[REDACTED]" }, f as unknown as typeof fetch)).toEqual({ results: {}, stopped: "off" });
  });

  it("is the default categorizer; OpenAI only when chosen; the local classifier is off", async () => {
    expect(provider({ TYPESAFE_API_KEY: KEY })).toBe("jev");
    expect(provider({ OPENAI_API_KEY: KEY })).toBe("off");
    expect(provider({ OPENAI_API_KEY: KEY, TYPESAFE_API_KEY: KEY, FULLA_CATEGORIZER: "openai" })).toBe("openai");
    expect(provider({ TYPESAFE_API_KEY: KEY, FULLA_CATEGORIZER: "off" })).toBe("off");
    expect(LOCAL_CLASSIFIER_ENABLED).toBe(false);
    expect(askLocal([item])).toEqual({});
    const f = vi.fn(async () => new Response(JSON.stringify({ answers: answers("Groceries", "Supermarket", 0.9) }), { status: 200 }));
    expect((await categorize([item], { TYPESAFE_API_KEY: KEY }, f as unknown as typeof fetch)).results.t1.parent).toBe("Groceries");
  });
});

describe("Jev's answers in the household", () => {
  const cats: Category[] = DEFAULT_CATEGORIES.map((d, i) => ({
    id: `c${i}`, name: d.name.en, applies_to: d.applies_to, parent_id: null, icon: d.icon, color_index: 0, sort: i, archived: false,
  }));
  const a = (parent: string, subcategory: string) => ({ parent, subcategory, spending: null, confidence: 0.9, by: "jev" as const });
  it("files Jev's own subcategory names", () => {
    expect(modelCategory(cats, a("Debt Payments", "Buy Now Pay Later"), "expense", "EXAMPLE")?.name).toBe("Debt payments");
    expect(modelCategory(cats, a("Dining & Take-out", "Coffee Shops"), "expense")?.name).toBe("Eating out");
    expect(modelTransfer(a("Debt Payments", "Credit-Card"), "Online bill payment for EXAMPLE", "expense")?.counterpartType).toBe("credit_card");
    expect(modelTransfer(a("Debt Payments", "Car Loan"), "EXAMPLE", "expense")).toBeNull();
    expect(modelTransfer(a("Transfers", "Credit-Card Payment"), "EXAMPLE", "expense")?.counterpartType).toBe("credit_card");
  });
});

describe("review tags", () => {
  const t = { id: "x", kind: "expense", category_id: "c1", tags: ["mine"], status: "active" } as unknown as Transaction;
  it("mark, clear on a new category, and stay for an unchanged save", () => {
    const marked = withTag(t, REVIEW_TAG);
    expect(needsReview(marked)).toBe(true);
    expect(reviewed(marked, { ...marked, note: "x" })).toEqual({ ...marked, note: "x" });
    expect(needsReview(reviewed(marked, { ...marked, category_id: "c2" }))).toBe(false);
    expect(withoutTag(marked, REVIEW_TAG).tags).toEqual(["mine"]);
    expect(isUnmatchedTransfer(withTag({ ...t, kind: "transfer" }, UNMATCHED_TAG))).toBe(true);
  });
});
