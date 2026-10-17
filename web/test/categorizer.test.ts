// SPDX-License-Identifier: GPL-3.0-or-later
// The optional categorizer model, with every network call mocked: nothing here
// reaches OpenAI or Supabase. Transactions are invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_PARENTS, modelCategory, modelKey, parseAnswer, userPrompt, DEFAULT_CATEGORIZER_MODEL, SYSTEM_PROMPT } from "@/lib/categorizer";
import { askModel, readItems } from "@/lib/server/categorizer";
import { DEFAULT_CATEGORIES } from "@/lib/defaults";
import type { Category } from "@/lib/model";

const cats: Category[] = DEFAULT_CATEGORIES.map((d, i) => ({
  id: `c${i}`, name: d.name.en, applies_to: d.applies_to, parent_id: null, icon: d.icon, color_index: 0, sort: i, archived: false,
}));
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
    expect(parseAnswer(ANSWER)).toEqual({ parent: "Dining & Take\u2011out", subcategory: "Coffee Shops", spending: "flexible" });
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
    ["Entertainment & Recreation", "Streaming Subscriptions", "expense", "Subscriptions"],
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
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the model, temperature 0.1 and the trained prompt; the key only in the header", async () => {
    const f = vi.fn(async () => reply(ANSWER));
    const r = await askModel([item, { ...item, id: "t2" }], { OPENAI_API_KEY: "test-key-not-real" }, f as unknown as typeof fetch);
    expect(r.stopped).toBeNull();
    expect(Object.keys(r.results).sort()).toEqual(["t1", "t2"]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_CATEGORIZER_MODEL);
    expect(body.temperature).toBe(0.1);
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(body.messages[1].content).toBe(userPrompt(item));
    expect(String(init.body)).not.toContain("test-key-not-real");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key-not-real");
  });

  it("uses FULLA_CATEGORIZER_MODEL when it is set", async () => {
    const f = vi.fn(async () => reply(ANSWER));
    await askModel([item], { OPENAI_API_KEY: "k", FULLA_CATEGORIZER_MODEL: "ft:some-other-model" }, f as unknown as typeof fetch);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("ft:some-other-model");
  });

  it("no credit (429 insufficient_quota) stops asking and answers nothing, without throwing", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }));
    const items = Array.from({ length: 12 }, (_, i) => ({ ...item, id: `t${i}` }));
    const r = await askModel(items, { OPENAI_API_KEY: "k" }, f as unknown as typeof fetch);
    expect(r).toEqual({ results: {}, stopped: "quota" });
    expect(f.mock.calls.length).toBeLessThanOrEqual(4); // the ones already in flight, no more
  });

  it("a network error or an unreadable answer leaves that line unanswered", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return reply("no idea");
      return reply(ANSWER);
    });
    const items = [1, 2, 3].map((i) => ({ ...item, id: `t${i}` }));
    const r = await askModel(items, { OPENAI_API_KEY: "k" }, f as unknown as typeof fetch);
    expect(Object.keys(r.results)).toHaveLength(1);
    expect(r.stopped).toBe("error");
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

  it("is off without OPENAI_API_KEY, and says so", async () => {
    delete process.env.OPENAI_API_KEY;
    const { GET, POST } = await import("@/app/api/categorize/route");
    expect(await (await GET()).json()).toEqual({ enabled: false });
    expect(await (await POST(post("Bearer x"))).json()).toEqual({ results: {}, stopped: "off" });
  });

  it("refuses a request without a live Supabase session", async () => {
    process.env.OPENAI_API_KEY = "k";
    const f = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", f);
    const { POST } = await import("@/app/api/categorize/route");
    expect((await POST(post())).status).toBe(401);
    expect((await POST(post("Bearer expired"))).status).toBe(401);
    expect((f.mock.calls as unknown[][]).every((c) => !String(c[0]).includes("openai"))).toBe(true);
  });

  it("answers a signed-in person", async () => {
    process.env.OPENAI_API_KEY = "k";
    const f = vi.fn(async (url: string) => (String(url).includes("/auth/v1/user") ? new Response("{}", { status: 200 }) : reply(ANSWER)));
    vi.stubGlobal("fetch", f);
    const { POST, GET } = await import("@/app/api/categorize/route");
    expect(await (await GET()).json()).toEqual({ enabled: true });
    const body = await (await POST(post("Bearer live"))).json();
    expect(body.results.t1.parent).toBe("Dining & Take\u2011out");
  });
});
