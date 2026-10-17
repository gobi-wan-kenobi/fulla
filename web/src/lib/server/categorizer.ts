// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The server's half of the categorizer: asks the model about a few lines and
 * returns its answers. Off unless OPENAI_API_KEY is set (server-side only,
 * never NEXT_PUBLIC_). Any failure (no key, no credit, rate limit, timeout, an
 * answer it cannot read) leaves those lines unanswered, and the import falls
 * through to Other as if the model were off.
 */
import { DEFAULT_CATEGORIZER_MODEL, type ModelAnswer, type ModelItem, SYSTEM_PROMPT, parseAnswer, userPrompt } from "../categorizer";

export const MAX_ITEMS = 40;
const CONCURRENCY = 4;
/** Long enough for a fine-tuned model's cold start, which can take well over ten seconds. */
export const TIMEOUT_MS = 30000;
/** One more try after a timeout, a network error or a 5xx/408: a cold model often answers the second time. */
export const RETRIES = 1;

export interface CategorizerEnv {
  OPENAI_API_KEY?: string;
  FULLA_CATEGORIZER_MODEL?: string;
  OPENAI_BASE_URL?: string;
}

/**
 * On when OPENAI_API_KEY looks like an API key: one token of 20 or more key
 * characters. A placeholder ("[REDACTED]", "changeme", a pasted sentence)
 * leaves it off, so the app says so instead of failing every call.
 */
export function categorizerEnabled(env: CategorizerEnv): boolean {
  const k = env.OPENAI_API_KEY?.trim() ?? "";
  return /^[A-Za-z0-9_\-.:]{20,}$/.test(k);
}

export interface Answered {
  results: Record<string, ModelAnswer>;
  /** Why some or all lines went unanswered, if any did: "off", "quota", "error". */
  stopped: "off" | "quota" | "error" | null;
}

type Fetch = typeof fetch;

/** Asks the model about each item (one request each, a few at a time). Never throws. */
export async function askModel(
  items: ModelItem[], env: CategorizerEnv, doFetch: Fetch = fetch, opts: { timeoutMs?: number; retries?: number } = {},
): Promise<Answered> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const retries = opts.retries ?? RETRIES;
  if (!categorizerEnabled(env)) return { results: {}, stopped: "off" };
  const model = env.FULLA_CATEGORIZER_MODEL?.trim() || DEFAULT_CATEGORIZER_MODEL;
  const base = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const results: Record<string, ModelAnswer> = {};
  let stopped: Answered["stopped"] = null;
  const queue = items.slice(0, MAX_ITEMS);

  /** One request: an answer, a reason to stop asking, or "retry" for a failure worth one more try. */
  async function attempt(item: ModelItem): Promise<ModelAnswer | null | "quota" | "retry" | "error"> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY!.trim()}` },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 80,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt(item) }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Only the status is logged, never the request or the answer.
        console.warn(`categorizer: model answered ${res.status}; falling through`);
        // 429 is a rate limit or, with insufficient_quota, no credit: stop asking either way.
        if (res.status === 429 || res.status === 401 || res.status === 403) return "quota";
        return res.status >= 500 || res.status === 408 ? "retry" : "error";
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return parseAnswer(body.choices?.[0]?.message?.content ?? "");
    } catch (e) {
      console.warn(`categorizer: ${e instanceof Error ? e.name : "error"}; falling through`);
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }

  async function one(item: ModelItem) {
    for (let tries = 0; tries <= retries; tries++) {
      if (stopped === "quota") return;
      const got = await attempt(item);
      if (got === "retry" && tries < retries) continue;
      if (got === "quota") stopped = "quota";
      else if (got === "retry" || got === "error") stopped ??= "error";
      else if (got) results[item.id] = got;
      return;
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) await one(queue[next++]);
    }),
  );
  return { results, stopped };
}

/** The items of a request body, checked and trimmed; null when the body is not that. */
export function readItems(body: unknown): ModelItem[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) return null;
  const out: ModelItem[] = [];
  for (const x of (body as { items: unknown[] }).items.slice(0, MAX_ITEMS)) {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.description !== "string" || typeof o.date !== "string") return null;
    if (typeof o.amount_minor !== "number" || !Number.isFinite(o.amount_minor)) return null;
    out.push({
      id: o.id.slice(0, 64),
      date: o.date.slice(0, 10),
      description: o.description.slice(0, 200),
      amount_minor: Math.trunc(o.amount_minor),
      minor_units: typeof o.minor_units === "number" ? Math.min(3, Math.max(0, Math.trunc(o.minor_units))) : 2,
      institution: typeof o.institution === "string" ? o.institution.slice(0, 40) : null,
    });
  }
  return out;
}
