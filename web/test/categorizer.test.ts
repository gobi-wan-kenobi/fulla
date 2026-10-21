// SPDX-License-Identifier: GPL-3.0-or-later
// The optional categorizer model, with every network call mocked: nothing here
// reaches OpenAI or Supabase. Transactions are invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_PARENTS, modelCategory, modelKey, nameMatch, normalizeLabel, parseAnswer, userPrompt, DEFAULT_CATEGORIZER_MODEL, SYSTEM_PROMPT,
} from "@/lib/categorizer";
import { RETRIES, TIMEOUT_MS, askModel, readItems } from "@/lib/server/categorizer";
import { DEFAULT_CATEGORIES } from "@/lib/defaults";
import type { Category } from "@/lib/model";

const cats: Category[] = DEFAULT_CATEGORIES.map((d, i) => ({
  id: `c${i}`, name: d.name.en, applies_to: d.applies_to, parent_id: null, icon: d.icon, color_index: 0, sort: i, archived: false,
}));
const KEY = "test-key-not-real-0123456789";
const item = { id: "t1", date: "2030-03-02", description: "BLUE DOOR CAFE", amount_minor: 1234 };
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const ANSWER = "Parent Category: Dining & Take\u2011out\nSubcategory: Coffee Shops\nSpending Type: Flexible\nMerchant: BLUE DOOR CAFE";

describe("the model's prompt and answer", () => {
  it("asks in the form it was trained on", () => {
    expect(userPrompt({ ...item, institution: "Main account" })).toBe(
      "Categorize this transaction:\nDate: 2030-03-02\nDescription: BLUE DOOR CAFE\nAmount: $12.34\nInstitution: MAIN ACCOUNT",
    );
    expect(userPrompt({ ...item, amount_minor: -500, minor_units: 0 })).toContain("Amount: $500");
  });

  it("reads its four lines, and nothing else", () => {
    expect(parseAnswer(ANSWER)).toEqual({ parent: "Dining & Take-out", subcategory: "Coffee Shops", spending: "flexible" });
    expect(parseAnswer("Parent Category: Utilities\nSubcategory: Internet\nSpending Type: Fixed")?.spending).toBe("fixed");
    expect(parseAnswer("I cannot help with that.")).toBeNull();
  });

  it("maps every one of its 19 parent categories", () => {
    expect(MODEL_PARENTS).toHaveLength(19);
    for (const p of MODEL_PARENTS) {
      const k = modelKey({ parent: p, subcategory: null, spending: null }, "expense");
      if (k !== null) expect(DEFAULT_CATEGORIES.map((d) => d.key)).toContain(k);
    }
  });

  it.each([
    ["Dining & Take\u2011out", "Coffee Shops", "expense", "Eating out"],
    ["Entertainment & Recreation", "Streaming Subscriptions", "expense", "Subscriptions"], // no subcategories: the parent
    ["Entertainment & Recreation", "Video Games", "expense", "Leisure"],
    ["Transportation", "Fuel", "expense", "Transport"],
    ["Utilities", "Mobile Phone", "expense", "Utilities"],
    ["Shopping", "Gifts & Flowers", "expense", "Gifts"],
    ["Education & Self-Improvement", "Courses & Certificates", "expense", "Education"],
    ["Personal Care", "Gym Membership", "expense", "Health"],
    ["Income", "Salary & Wages", "income", "Salary"],
    ["Income", "Refunds & Reimbursements", "income", "Other income"],
    ["Groceries", "Supermarket", "refund", "Groceries"],
  ])("%s / %s (%s) → %s", (parent, sub, kind, name) => {
    expect(modelCategory(cats, { parent, subcategory: sub, spending: null }, kind as "expense")?.name).toBe(name);
  });

  it("writes every kind of hyphen the model uses as '-'", () => {
    for (const h of ["\u00ad", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2043", "\u2212", "\ufe63", "\uff0d"]) {
      expect(normalizeLabel(`Take${h}out`)).toBe("Take-out");
      expect(modelCategory(cats, { parent: `Dining & Take${h}out`, subcategory: null, spending: null }, "expense")?.name).toBe("Eating out");
    }
    expect(parseAnswer("Parent Category: Education & Self\u2011Improvement\nSubcategory: E\u2011books")).toMatchObject({
      parent: "Education & Self-Improvement", subcategory: "E-books",
    });
  });

  it("finds the household's own subcategory by a loose name", () => {
    expect(nameMatch("Rent", "Rent / Mortgage")).toBe(1);
    expect(nameMatch("Gifts & Flowers", "gift and flower")).toBe(2);
    expect(nameMatch("Fuel", "Rent / Mortgage")).toBe(0);
    const housing = cats.find((c) => c.name === "Housing")!;
    const transport = cats.find((c) => c.name === "Transport")!;
    const mine: Category[] = [
      ...cats,
      { ...housing, id: "rent", name: "Rent / Mortgage", parent_id: housing.id, sort: 50 },
      { ...transport, id: "gas", name: "Gas & Fuel", parent_id: transport.id, sort: 51 },
      { ...housing, id: "pets", name: "Pet Supplies", parent_id: null, sort: 52 },
    ];
    expect(modelCategory(mine, { parent: "Housing", subcategory: "Rent", spending: null }, "expense")?.name).toBe("Rent / Mortgage");
    expect(modelCategory(mine, { parent: "Transportation", subcategory: "Fuel", spending: null }, "expense")?.name).toBe("Gas & Fuel");
    expect(modelCategory(mine, { parent: "Housing", subcategory: "Property Tax", spending: null }, "expense")?.name).toBe("Housing");
    // A category of the household's own, named exactly as the subcategory, wins over the parent's.
    expect(modelCategory(mine, { parent: "Shopping", subcategory: "Pet supplies", spending: null }, "expense")?.name).toBe("Pet Supplies");
    // Only a loose match elsewhere: the parent's category stays.
    expect(modelCategory(mine, { parent: "Shopping", subcategory: "Pet food", spending: null }, "expense")?.name).toBe("Shopping");
    // Never a catch-all, and never a category for the other kind of money.
    expect(modelCategory(mine, { parent: "Shopping", subcategory: "Other", spending: null }, "expense")?.name).toBe("Shopping");
    expect(modelCategory(mine, { parent: "Income", subcategory: "Rent", spending: null }, "income")?.name).toBe("Other income");
  });

  it("transfers, savings, unknown names and money the wrong way fall through to Other", () => {
    expect(modelKey({ parent: "Transfers", subcategory: "P2P Transfer", spending: null }, "expense")).toBeNull();
    expect(modelKey({ parent: "Savings & Investing", subcategory: "Brokerage", spending: null }, "expense")).toBeNull();
    expect(modelKey({ parent: "Something new", subcategory: null, spending: null }, "expense")).toBeNull();
    expect(modelKey({ parent: "Income", subcategory: "Salary & Wages", spending: null }, "expense")).toBeNull();
    expect(modelKey({ parent: "Groceries", subcategory: null, spending: null }, "income")).toBeNull();
  });
});

describe("the server's call to the model (mocked)", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("is off, and calls nothing, without a key", async () => {
    const f = vi.fn();
    expect(await askModel([item], {}, f)).toEqual({ results: {}, stopped: "off" });
    expect(await askModel([item], { OPENAI_API_KEY: "  " }, f)).toEqual({ results: {}, stopped: "off" });
    for (const placeholder of ["[REDACTED]", "changeme", "paste the key here please ok", "k"]) {
      expect(await askModel([item], { OPENAI_API_KEY: placeholder }, f)).toEqual({ results: {}, stopped: "off" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the model, temperature 0.1 and the trained prompt; the key only in the header", async () => {
    const f = vi.fn(async () => reply(ANSWER));
    const r = await askModel([item, { ...item, id: "t2" }], { OPENAI_API_KEY: KEY }, f as unknown as typeof fetch);
    expect(r.stopped).toBeNull();
    expect(Object.keys(r.results).sort()).toEqual(["t1", "t2"]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_CATEGORIZER_MODEL);
    expect(body.temperature).toBe(0.1);
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(body.messages[1].content).toBe(userPrompt(item));
    expect(String(init.body)).not.toContain(KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("uses FULLA_CATEGORIZER_MODEL when it is set", async () => {
    const f = vi.fn(async () => reply(ANSWER));
    await askModel([item], { OPENAI_API_KEY: KEY, FULLA_CATEGORIZER_MODEL: "ft:some-other-model" }, f as unknown as typeof fetch);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("ft:some-other-model");
  });

  it("no credit (429 insufficient_quota) stops asking and answers nothing, without throwing", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }));
    const items = Array.from({ length: 12 }, (_, i) => ({ ...item, id: `t${i}` }));
    const r = await askModel(items, { OPENAI_API_KEY: KEY }, f as unknown as typeof fetch);
    expect(r).toEqual({ results: {}, stopped: "quota" });
    expect(f.mock.calls.length).toBeLessThanOrEqual(4); // the ones already in flight, no more
  });

  it("a network error twice or an unreadable answer leaves that line unanswered", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const text = JSON.parse(String(init.body)).messages[1].content as string;
      if (text.includes("LINE ONE")) throw new TypeError("fetch failed");
      if (text.includes("LINE TWO")) return reply("no idea");
      return reply(ANSWER);
    });
    const items = ["LINE ONE", "LINE TWO", "LINE THREE"].map((d, i) => ({ ...item, id: `t${i}`, description: d }));
    const r = await askModel(items, { OPENAI_API_KEY: KEY }, f as unknown as typeof fetch);
    expect(Object.keys(r.results)).toEqual(["t2"]);
    expect(r.stopped).toBe("error");
    expect(f).toHaveBeenCalledTimes(4); // line one tried twice, the others once
  });

  it("waits 30 seconds by default, and tries once more after a timeout or a 5xx (a cold start)", async () => {
    expect(TIMEOUT_MS).toBe(30000);
    expect(RETRIES).toBe(1);
    let n = 0;
    const f = vi.fn((_url: string, init: RequestInit) => {
      n++;
      if (n === 1) {
        // Never answers: the timeout aborts it.
        return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return Promise.resolve(reply(ANSWER));
    });
    const r = await askModel([item], { OPENAI_API_KEY: KEY }, f as unknown as typeof fetch, { timeoutMs: 20 });
    expect(r).toEqual({ results: { t1: expect.objectContaining({ parent: "Dining & Take-out" }) }, stopped: null });
    expect(f).toHaveBeenCalledTimes(2);

    let m = 0;
    const g = vi.fn(async () => (++m === 1 ? new Response("{}", { status: 503 }) : reply(ANSWER)));
    expect(Object.keys((await askModel([item], { OPENAI_API_KEY: KEY }, g as unknown as typeof fetch)).results)).toEqual(["t1"]);
    expect(g).toHaveBeenCalledTimes(2);

    // A 400 is not a cold start: no second try.
    const h = vi.fn(async () => new Response("{}", { status: 400 }));
    expect((await askModel([item], { OPENAI_API_KEY: KEY }, h as unknown as typeof fetch)).stopped).toBe("error");
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("reads only well-formed items, at most 40, trimmed", () => {
    expect(readItems(null)).toBeNull();
    expect(readItems({ items: [{ id: 1 }] })).toBeNull();
    const many = readItems({ items: Array.from({ length: 50 }, (_, i) => ({ ...item, id: `t${i}`, description: "x".repeat(500) })) })!;
    expect(many).toHaveLength(40);
    expect(many[0].description).toHaveLength(200);
  });
});

describe("POST /api/categorize (mocked network)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    // Never the real keys of whoever runs the tests.
    delete process.env.OPENAI_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.FULLA_CATEGORIZER;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const post = (auth?: string) =>
    new Request("http://app.test/api/categorize", {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ items: [item] }),
    });

  it("is off without a key, and says so", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    process.env.FULLA_CATEGORIZER = "openai";
    const { GET, POST } = await import("@/app/api/categorize/route");
    expect(await (await GET()).json()).toEqual({ enabled: false, provider: "off" });
    delete process.env.FULLA_CATEGORIZER;
    expect(await (await GET()).json()).toEqual({ enabled: false, provider: "off" });
    expect(await (await POST(post("Bearer x"))).json()).toEqual({ results: {}, stopped: "off" });
  });

  it("refuses a request without a live Supabase session", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    const f = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", f);
    const { POST } = await import("@/app/api/categorize/route");
    expect((await POST(post())).status).toBe(401);
    expect((await POST(post("Bearer expired"))).status).toBe(401);
    expect((f.mock.calls as unknown[][]).every((c) => !String(c[0]).includes("openai") && !String(c[0]).includes("typesafe"))).toBe(true);
  });

  it("answers a signed-in person with the OpenAI fallback, when it is chosen", async () => {
    process.env.OPENAI_API_KEY = KEY;
    process.env.FULLA_CATEGORIZER = "openai";
    const f = vi.fn(async (url: string) => (String(url).includes("/auth/v1/user") ? new Response("{}", { status: 200 }) : reply(ANSWER)));
    vi.stubGlobal("fetch", f);
    const { POST, GET } = await import("@/app/api/categorize/route");
    expect(await (await GET()).json()).toEqual({ enabled: true, provider: "openai" });
    const body = await (await POST(post("Bearer live"))).json();
    expect(body.results.t1.parent).toBe("Dining & Take-out");
    delete process.env.FULLA_CATEGORIZER;
  });

  it("does not use OpenAI unless chosen, even with its key", async () => {
    process.env.OPENAI_API_KEY = KEY;
    delete process.env.TYPESAFE_API_KEY;
    const { GET } = await import("@/app/api/categorize/route");
    expect(await (await GET()).json()).toEqual({ enabled: false, provider: "off" });
  });
});

describe("Debt Payments answers", () => {
  const debt = cats.find((c) => c.name === "Debt payments")!;
  const sub = (id: string, name: string): Category => ({ id, name, applies_to: "expense", parent_id: debt.id, icon: "account_balance", color_index: 0, sort: 0, archived: false, fixed: true });
  const withSubs = [...cats, sub("d1", "Personal loan"), sub("d2", "Line of credit"), sub("d3", "Buy now pay later"), sub("d4", "Student loan"), sub("d5", "Car loan"), sub("d6", "Other debt")];
  const ans = (subcategory: string) => ({ parent: "Debt Payments", subcategory, spending: null });
  it.each([
    ["Personal Loan", "EXAMPLE LENDING", "Personal loan"],
    ["Personal Loan", "Pre-authorized Debit to AFFIRM INC", "Buy now pay later"], // the description says which
    ["Personal Loan", "EXAMPLE LINE OF CREDIT PMT", "Line of credit"],
    ["Student Loan", "EXAMPLE", "Student loan"],
    ["Auto Loan", "EXAMPLE", "Car loan"],
    ["Something Else", "EXAMPLE", "Other debt"],
  ])("%s, %s → %s", (s, description, name) => {
    expect(modelCategory(withSubs, ans(s), "expense", description)?.name).toBe(name);
  });
  it("go to Debt payments itself when it has no subcategories, and a mortgage to Housing", () => {
    expect(modelCategory(cats, ans("Personal Loan"), "expense")?.name).toBe("Debt payments");
    expect(modelCategory(cats, ans("Mortgage"), "expense")?.name).toBe("Housing");
  });
});

describe("Insurance and Interest answers", () => {
  const ins = cats.find((c) => c.name === "Insurance")!;
  const sub = (id: string, name: string): Category => ({ id, name, applies_to: "expense", parent_id: ins.id, icon: "shield", color_index: 0, sort: 0, archived: false, fixed: true });
  const withSubs = [...cats, sub("i1", "Life insurance"), sub("i2", "Home insurance"), sub("i3", "Auto insurance"), sub("i4", "Health insurance")];
  it.each([
    ["Life", "Pre-authorized Debit to EXAMPLEINS-LIFE", "Life insurance"],
    ["Auto Insurance", "EXAMPLE MUTUAL", "Auto insurance"],
    ["Home Insurance", "EXAMPLE MUTUAL", "Home insurance"],
    ["Health Insurance", "EXAMPLE PLAN", "Health insurance"],
    ["Auto Insurance", "EXAMPLE LIFE ASSURANCE", "Life insurance"], // the description says which
    ["Something Else", "EXAMPLE MUTUAL", "Insurance"],
  ])("Insurance › %s, %s → %s", (s, description, name) => {
    expect(modelCategory(withSubs, { parent: "Insurance", subcategory: s, spending: null }, "expense", description)?.name).toBe(name);
  });
  it("is Insurance itself without subcategories, and Other only in a household without Insurance", () => {
    expect(modelCategory(cats, { parent: "Insurance", subcategory: "Life", spending: null }, "expense")?.name).toBe("Insurance");
    expect(modelCategory(cats.filter((c) => c.name !== "Insurance"), { parent: "Insurance", subcategory: "Life", spending: null }, "expense")).toBeNull();
  });
  it("puts interest earned in Interest, else Other income", () => {
    const a = { parent: "Income", subcategory: "Interest & Dividends", spending: null };
    expect(modelCategory(cats, a, "income")?.name).toBe("Interest");
    expect(modelCategory(cats.filter((c) => c.name !== "Interest"), a, "income")?.name).toBe("Other income");
  });
});
