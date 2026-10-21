// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The review queue by merchant: every line waiting for review (review.ts)
 * grouped under the merchant the categorizer and rules already name it by
 * (cleanMerchant, the pattern a new rule proposes), so one decision sorts
 * them all. An e-Transfer with a person is grouped per person instead, and
 * the person's name stays on the household's own screen: a group's id and
 * its public label never carry it, so nothing that logs them can either.
 *
 * Money out (spending and refunds) and money in are separate groups, since a
 * category is for one or the other.
 *
 * Each group suggests a category, with how sure it is:
 *  - a household rule or a shop Fulla knows that now matches (sure);
 *  - what the categorizer would have chosen had it been sure (the suggestion
 *    tag an import leaves, review.ts), at its confidence;
 *  - what the household itself chose for the same merchant before, at the
 *    share of those lines it chose it for.
 * Never a transfer: a model's transfer answer leaves no suggestion.
 */
import { cleanMerchant, isCatchAll, suggest, words } from "./categorize";
import { sourceOf } from "./examples";
import { sha256Hex } from "./ids";
import { merchantName } from "./insights";
import { recategorized } from "./ledger";
import { allows, isCategorised, type Category, type CategorizationRule, type Transaction } from "./model";
import { needsReview, REVIEW_TAG, suggestedId, withSuggestion, withoutTag } from "./review";
import { sortedBy } from "./examples";
import { normalizeName } from "./text";
import { isTransferWithPerson, personOf } from "./transfers";

export type SuggestionSource = "rule" | "merchant" | "debt" | "categorizer" | "history";

export interface GroupSuggestion {
  category: Category;
  /** 0 to 1. */
  confidence: number;
  source: SuggestionSource;
  /** How many of the group's lines this suggestion is for. */
  lines: number;
}

export interface ReviewGroup<R extends { tx: Transaction } = { tx: Transaction }> {
  /** Stable and anonymous: a hash of the merchant key, never the key itself. */
  id: string;
  side: "out" | "in";
  /** An e-Transfer with a person: a rule for it is offered unticked, and the name is never logged. */
  person: boolean;
  /** For the household's own screen: the merchant, or "e-Transfer to Name". */
  label: string;
  /** Safe for any log or report: the merchant, or "e-Transfer to/from a person". */
  publicLabel: string;
  rows: R[];
  count: number;
  /** Spending net of refunds for money out; the total in for money in. Positive. */
  totalMinor: number;
  firstDate: string;
  lastDate: string;
  suggestion: GroupSuggestion | null;
  /** The text a rule would match (every line of the group contains it), or null when none would. */
  rulePattern: string | null;
}

const sideOf = (t: Transaction): "out" | "in" => (t.kind === "income" ? "in" : "out");

/**
 * A line's merchant key: per person for an e-Transfer (one group for those
 * whose statement names nobody), else the merchant as rules name it.
 */
export function merchantKey(t: Pick<Transaction, "kind" | "note">): { key: string; withPerson: boolean; person: string | null; merchant: string } {
  const note = t.note ?? "";
  const side = t.kind === "income" ? "in" : "out";
  if (isTransferWithPerson(note)) {
    const person = personOf(note);
    const merchant = person ? words(person) : "";
    return { key: `${side}|p|${merchant}`, withPerson: true, person, merchant };
  }
  const merchant = cleanMerchant(note) || "";
  return { key: `${side}|m|${merchant}`, withPerson: false, person: null, merchant };
}

/** The longest run of the merchant's words that every note contains (as rules match, matchRule), or null. */
export function rulePatternFor(merchant: string, notes: string[]): string | null {
  const texts = notes.map(normalizeName);
  const ws = merchant.split(" ").filter(Boolean);
  for (let len = ws.length; len >= 1; len--) {
    for (let i = 0; i + len <= ws.length; i++) {
      const p = ws.slice(i, i + len).join(" ");
      if (p.length >= 3 && texts.every((t) => t.includes(p))) return p;
    }
  }
  return null;
}

interface LineSuggestion { categoryId: string; confidence: number; source: SuggestionSource }

/** The household's own past choices per merchant key: category id → lines, from rows not in review. */
function history(rows: Transaction[], categories: Category[]): Map<string, Map<string, number>> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<string, Map<string, number>>();
  for (const t of rows) {
    if (t.status !== "active" || !isCategorised(t.kind) || needsReview(t) || !t.category_id || !t.note) continue;
    const c = byId.get(t.category_id);
    if (!c || c.archived || isCatchAll(c)) continue;
    const k = merchantKey(t).key;
    const m = out.get(k) ?? new Map<string, number>();
    m.set(c.id, (m.get(c.id) ?? 0) + 1);
    out.set(k, m);
  }
  return out;
}

function lineSuggestion(t: Transaction, key: string, rules: CategorizationRule[], categories: Category[], ids: string[], past: Map<string, Map<string, number>>): LineSuggestion | null {
  const usable = (id: string | null | undefined) => {
    const c = id ? categories.find((k) => k.id === id) : undefined;
    return c && !c.archived && allows(c.applies_to, t.kind) && !isCatchAll(c) ? c : null;
  };
  const s = suggest(t.note ?? "", t.kind, rules, categories);
  if (s && usable(s.category.id) && (s.source === "rule" || s.source === "merchant" || s.source === "debt")) {
    return { categoryId: s.category.id, confidence: 1, source: s.source };
  }
  const tagged = usable(suggestedId(t, ids));
  if (tagged) return { categoryId: tagged.id, confidence: sourceOf(t).confidence ?? 0.5, source: "categorizer" };
  const seen = past.get(key);
  if (seen) {
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    const [id, n] = [...seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (usable(id)) return { categoryId: id, confidence: n / total, source: "history" };
  }
  return null;
}

/**
 * The review queue as groups, most lines first, then the largest total.
 * Only lines that take a category are grouped; anything else in review
 * (and unmatched transfers) is listed as it is.
 */
export function reviewGroups<R extends { tx: Transaction }>(rows: R[], categories: Category[], rules: CategorizationRule[], all: Transaction[] = rows.map((r) => r.tx)): ReviewGroup<R>[] {
  const ids = categories.map((c) => c.id);
  const past = history(all, categories);
  const byKey = new Map<string, { rows: R[]; withPerson: boolean; person: string | null; merchant: string }>();
  for (const r of rows) {
    const t = r.tx;
    if (!needsReview(t) || !isCategorised(t.kind)) continue;
    const k = merchantKey(t);
    const g = byKey.get(k.key) ?? { rows: [], withPerson: k.withPerson, person: k.person, merchant: k.merchant };
    g.rows.push(r);
    byKey.set(k.key, g);
  }
  const groups: ReviewGroup<R>[] = [];
  for (const [key, g] of byKey) {
    const side = sideOf(g.rows[0].tx);
    const sorted = [...g.rows].sort((a, b) => (a.tx.date < b.tx.date ? 1 : a.tx.date > b.tx.date ? -1 : 0));
    const total = sorted.reduce((a, r) => a + (r.tx.kind === "refund" ? -r.tx.amount_minor : r.tx.amount_minor), 0);
    const tally = new Map<string, { n: number; conf: number; sources: Map<SuggestionSource, number> }>();
    for (const r of sorted) {
      const s = lineSuggestion(r.tx, key, rules, categories, ids, past);
      if (!s) continue;
      const e = tally.get(s.categoryId) ?? { n: 0, conf: 0, sources: new Map() };
      e.n++;
      e.conf += s.confidence;
      e.sources.set(s.source, (e.sources.get(s.source) ?? 0) + 1);
      tally.set(s.categoryId, e);
    }
    const best = [...tally.entries()].sort((a, b) => b[1].n - a[1].n || b[1].conf - a[1].conf || (a[0] < b[0] ? -1 : 1))[0];
    const suggestion: GroupSuggestion | null = best ? {
      category: categories.find((c) => c.id === best[0])!,
      // How sure, over the whole group: lines without this suggestion count as not sure.
      confidence: best[1].conf / sorted.length,
      source: [...best[1].sources.entries()].sort((a, b) => b[1] - a[1])[0][0],
      lines: best[1].n,
    } : null;
    const towards = side === "out" ? "to" : "from";
    const shop = merchantName(sorted[0].tx.note ?? "") || "No description";
    const label = !g.withPerson ? shop : g.person ? `e-Transfer ${towards} ${g.person}` : `e-Transfer ${side === "out" ? "sent" : "received"}, no name on the statement`;
    groups.push({
      id: sha256Hex(key).slice(0, 16),
      side,
      person: g.withPerson,
      label,
      publicLabel: g.withPerson ? "e-Transfer to/from a person" : shop,
      rows: sorted,
      count: sorted.length,
      totalMinor: Math.abs(total),
      firstDate: sorted[sorted.length - 1].tx.date,
      lastDate: sorted[0].tx.date,
      suggestion,
      // A rule for a person matches their name; with no name there is nothing safe to match (it would take every e-Transfer).
      rulePattern: g.withPerson ? (g.person && normalizeName(g.person).length >= 2 ? normalizeName(g.person) : null) : rulePatternFor(g.merchant, sorted.map((r) => r.tx.note ?? "")),
    });
  }
  return groups.sort((a, b) => b.count - a.count || b.totalMinor - a.totalMinor || (a.publicLabel < b.publicLabel ? -1 : a.publicLabel > b.publicLabel ? 1 : 0) || (a.id < b.id ? -1 : 1));
}

/**
 * One decision for a whole group: every line that can take the category gets
 * it and leaves review (sorted by you). Lines that cannot (a category for
 * money in on money out) are left as they are and counted.
 */
export function decideGroup<R extends { tx: Transaction }>(group: ReviewGroup<R>, category: Category): { changes: { tx: Transaction; existing: R }[]; skipped: number } {
  const changes: { tx: Transaction; existing: R }[] = [];
  let skipped = 0;
  for (const r of group.rows) {
    const moved = recategorized(r.tx, category);
    if (!moved) {
      skipped++;
      continue;
    }
    changes.push({ tx: sortedBy(withSuggestion(withoutTag(moved, REVIEW_TAG), null), "user"), existing: r });
  }
  return { changes, skipped };
}
