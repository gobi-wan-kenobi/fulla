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
const TIMEOUT_MS = 15000;

export interface CategorizerEnv {
  OPENAI_API_KEY?: string;
  FULLA_CATEGORIZER_MODEL?: string;
  OPENAI_BASE_URL?: string;
}

export function categorizerEnabled(env: CategorizerEnv): boolean {
  return !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0;
}

export interface Answered {
  results: Record<string, ModelAnswer>;
  /** Why some or all lines went unanswered, if any did: "off", "quota", "error". */
  stopped: "off" | "quota" | "error" | null;
}

type Fetch = typeof fetch;

/** Asks the model about each item (one request each, a few at a time). Never throws. */
export async function askModel(items: ModelItem[], env: CategorizerEnv, doFetch: Fetch = fetch): Promise<Answered> {
  if (!categorizerEnabled(env)) return { results: {}, stopped: "off" };
  const model = env.FULLA_CATEGORIZER_MODEL?.trim() || DEFAULT_CATEGORIZER_MODEL;
  const base = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const results: Record<string, ModelAnswer> = {};
  let stopped: Answered["stopped"] = null;
  const queue = items.slice(0, MAX_ITEMS);

  async function one(item: ModelItem) {
    if (stopped === "quota") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
        // 429 is a rate limit or, with insufficient_quota, no credit: stop asking either way.
        if (res.status === 429 || res.status === 401 || res.status === 403) stopped = "quota";
        else stopped ??= "error";
        console.warn(`categorizer: model answered ${res.status}; falling through`);
        return;
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const answer = parseAnswer(body.choices?.[0]?.message?.content ?? "");
      if (answer) results[item.id] = answer;
    } catch (e) {
      stopped ??= "error";
      console.warn(`categorizer: ${e instanceof Error ? e.name : "error"}; falling through`);
    } finally {
      clearTimeout(timer);
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
