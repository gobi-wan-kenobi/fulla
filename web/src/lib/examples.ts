// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Labelled examples: when someone moves a transaction to another category,
 * what Fulla had put it in (and how: a rule, a known shop, Jev...) and what
 * it really is. The browser sends the change to app/api/examples, which
 * scrubs the description (server/sanitize.ts) and keeps only what a
 * categorizer may read; the rest of the row never leaves.
 *
 * How a row was sorted travels with it as tags, so a later edit still knows:
 *   fulla:by:<rule|merchant|debt|file|jev|model|user>   and   fulla:conf:<0-100>
 */
import { supabase } from "./supabase";
import { isCategorised, type Transaction } from "./model";

export type ExampleSource = "rule" | "merchant" | "debt" | "file" | "jev" | "model" | "user" | "none";
export type ExampleVia = "edit" | "bulk" | "review" | "import";
const SOURCES = new Set<ExampleSource>(["rule", "merchant", "debt", "file", "jev", "model", "user"]);
export const BY_TAG_PREFIX = "fulla:by:";
export const CONF_TAG_PREFIX = "fulla:conf:";

/** The row marked as sorted by `source` (and how sure a categorizer was), replacing any earlier mark. */
export function sortedBy<T extends Transaction>(t: T, source: ExampleSource, confidence?: number | null): T {
  const tags = (t.tags ?? []).filter((x) => !x.startsWith(BY_TAG_PREFIX) && !x.startsWith(CONF_TAG_PREFIX));
  if (source !== "none") tags.push(BY_TAG_PREFIX + source);
  if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) tags.push(CONF_TAG_PREFIX + Math.round(confidence * 100));
  return { ...t, tags: tags.slice(0, 20) };
}

/** How the row was sorted, from its tags; "none" for a row without the mark (typed in, or from before it existed). */
export function sourceOf(t: Transaction): { source: ExampleSource; confidence: number | null } {
  const by = (t.tags ?? []).find((x) => x.startsWith(BY_TAG_PREFIX))?.slice(BY_TAG_PREFIX.length) as ExampleSource | undefined;
  const conf = Number((t.tags ?? []).find((x) => x.startsWith(CONF_TAG_PREFIX))?.slice(CONF_TAG_PREFIX.length));
  return { source: by && SOURCES.has(by) ? by : "none", confidence: Number.isFinite(conf) ? conf / 100 : null };
}

/** One change as the browser sends it; the server scrubs it before anything is kept. */
export interface ExampleChange {
  description: string;
  direction: "in" | "out";
  amount_minor: number;
  minor_units: number;
  date: string;
  from_category_id: string | null;
  from_source: ExampleSource;
  from_confidence: number | null;
  to_category_id: string;
  via: ExampleVia;
}

/** The examples a set of changes makes: only rows that moved to another category and have a description. */
export function examplesFor(changes: { before: Transaction; after: Transaction }[], via: ExampleVia, minorUnits = 2): ExampleChange[] {
  const out: ExampleChange[] = [];
  for (const { before, after } of changes) {
    if (!isCategorised(after.kind) || !after.category_id || before.category_id === after.category_id) continue;
    const description = (after.note || before.note).trim();
    if (!description) continue;
    const { source, confidence } = sourceOf(before);
    out.push({
      description: description.slice(0, 500), direction: after.kind === "expense" ? "out" : "in",
      amount_minor: after.amount_minor, minor_units: minorUnits, date: after.date,
      from_category_id: before.category_id, from_source: source, from_confidence: confidence,
      to_category_id: after.category_id, via,
    });
  }
  return out;
}

/** Sends examples to the server. Never throws: a lost example must never stop a save. */
export async function sendExamples(householdId: string, examples: ExampleChange[]): Promise<number> {
  if (examples.length === 0) return 0;
  try {
    const { data } = await supabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) return 0;
    let saved = 0;
    for (let i = 0; i < examples.length; i += 100) {
      const res = await fetch("/api/examples", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ household_id: householdId, examples: examples.slice(i, i + 100) }),
      });
      if (!res.ok) break;
      saved += ((await res.json()) as { saved?: number }).saved ?? 0;
    }
    return saved;
  } catch {
    return 0;
  }
}
