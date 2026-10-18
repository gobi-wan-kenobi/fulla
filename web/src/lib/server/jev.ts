// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Jev (TypeSafe System One) as Fulla's categorizer, server-side only. Each
 * line is scrubbed (sanitize.ts), described with facts computed in code
 * (categorize/facts.ts), and asked the question set in
 * categorize/jev/questions.v2.json: one Choice over the 19 parent categories
 * and one per parent over its subcategories, all in the same request.
 *
 * Decoding, as tuned in October 2026 on practice lines and scored on 300
 * held-out ones: the pair is argmax P(parent) × P(sub | parent); the
 * confidence is the parent question's. At 0.7 or more the answer is applied;
 * below, the line goes to review (about 1 in 10; 95.6% of applied lines
 * had the right category). The model is pinned so the cutoff stays valid.
 *
 * Off unless TYPESAFE_API_KEY is set (never NEXT_PUBLIC_). Only the status of
 * a failure is logged, never a line or an answer.
 */
import config from "../categorize/jev/questions.v2.json";
import type { ModelAnswer, ModelItem } from "../categorizer";
import { amountBand, dayOfMonth, isRound } from "../categorize/facts";
import { scrub } from "./sanitize";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const JEV_CUTOFF = 0.7;
export const JEV_TIMEOUT_MS = 30000;
const CONCURRENCY = 4;

export interface JevEnv { TYPESAFE_API_KEY?: string }

export function jevEnabled(env: JevEnv): boolean {
  return /^[A-Za-z0-9_\-.:]{20,}$/.test(env.TYPESAFE_API_KEY?.trim() ?? "");
}

type Questions = Record<string, { type: string; criteria: Record<string, unknown> }>;
export const QUESTIONS = (config as unknown as { questions: Questions }).questions;
export const PARENTS = Object.keys(QUESTIONS.flat.criteria);

/** The question id of a parent's subcategories: "Dining & Take-out" → "sub__dining___take_out". */
export function subId(parent: string): string {
  return "sub__" + [...parent.toLowerCase()].map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : "_")).join("").replace(/^_+|_+$/g, "");
}

/** What Jev reads about one line: no people, numbers or bank names; facts computed here. */
export function jevState(item: ModelItem): { transaction: Record<string, string> } {
  const units = item.minor_units ?? 2;
  const tx: Record<string, string> = { description: scrub(item.description).text };
  if (item.direction) tx.direction = item.direction === "in" ? "money in" : "money out";
  tx.amount_band_cad = amountBand(item.amount_minor, units);
  if (isRound(item.amount_minor, units)) tx.round_amount = "yes (a round number, typical of transfers and payments)";
  if (item.how_often_seen) tx.how_often_seen = item.how_often_seen.slice(0, 60);
  const day = dayOfMonth(item.date);
  if (day) tx.day_of_month = day;
  return { transaction: tx };
}

interface ChoiceAnswer { choice?: string; confidence?: number; probabilities?: Record<string, number> }

/** Jev's answers for one line as a category, a subcategory and how sure it is; null when it is not that. */
export function decodeJev(answers: Record<string, ChoiceAnswer> | undefined): ModelAnswer | null {
  const flat = answers?.flat;
  const pp = flat?.probabilities;
  if (!pp || typeof pp !== "object") return null;
  let best: { p: string; s: string | null; v: number } | null = null;
  for (const p of PARENTS) {
    const prob = pp[p] ?? 0;
    const sub = answers?.[subId(p)]?.probabilities ?? {};
    const subs = Object.entries(sub);
    if (subs.length === 0) {
      if (!best || prob > best.v) best = { p, s: null, v: prob };
      continue;
    }
    for (const [s, sp] of subs) if (!best || prob * sp > best.v) best = { p, s, v: prob * sp };
  }
  if (!best) return null;
  const confidence = typeof flat.confidence === "number" ? flat.confidence : Math.max(...Object.values(pp));
  return { parent: best.p, subcategory: best.s, spending: null, confidence, review: confidence < JEV_CUTOFF, by: "jev" };
}

type Fetch = typeof fetch;

export interface JevAnswered {
  results: Record<string, ModelAnswer>;
  stopped: "off" | "quota" | "error" | null;
}

export async function askJev(items: ModelItem[], env: JevEnv, doFetch: Fetch = fetch, opts: { timeoutMs?: number } = {}): Promise<JevAnswered> {
  if (!jevEnabled(env)) return { results: {}, stopped: "off" };
  const results: Record<string, ModelAnswer> = {};
  let stopped: JevAnswered["stopped"] = null;
  const key = env.TYPESAFE_API_KEY!.trim();

  async function one(item: ModelItem, tries = 0): Promise<void> {
    if (stopped === "quota") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? JEV_TIMEOUT_MS);
    try {
      const res = await doFetch(JEV_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: JEV_MODEL, state: jevState(item), questions: QUESTIONS }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`categorizer: jev answered ${res.status}; falling through`);
        if (res.status === 401 || res.status === 402 || res.status === 403) stopped = "quota";
        else if ((res.status === 429 || res.status >= 500) && tries < 2) {
          clearTimeout(timer);
          await new Promise((r) => setTimeout(r, 1000 * (tries + 1)));
          return one(item, tries + 1);
        } else stopped ??= "error";
        return;
      }
      const body = (await res.json()) as { answers?: Record<string, ChoiceAnswer> };
      const a = decodeJev(body.answers);
      if (a) results[item.id] = a;
    } catch (e) {
      console.warn(`categorizer: jev ${e instanceof Error ? e.name : "error"}; falling through`);
      if (tries < 1) {
        clearTimeout(timer);
        return one(item, tries + 1);
      }
      stopped ??= "error";
    } finally {
      clearTimeout(timer);
    }
  }

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await one(items[next++]);
  }));
  return { results, stopped };
}
