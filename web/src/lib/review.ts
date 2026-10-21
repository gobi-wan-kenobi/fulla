// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What waits for a person to look at it, kept as tags on the transaction so
 * it syncs like everything else and needs nothing new on the server:
 *
 *  - REVIEW_TAG: the categorizer was unsure (Jev below its cutoff), so the
 *    line went to Other instead of a guess. Choosing a category clears it.
 *  - UNMATCHED_TAG: a transfer seen on one statement only. Importing the
 *    other account's statement matches it (transferMatch.ts) and clears it;
 *    so does saying it is fine.
 *  - NO_STATEMENT_TAG: a transfer to or from an account that never has a
 *    statement of its own (a child's cash jar, a wallet). A household rule
 *    puts it on ("When a note contains …, it is a transfer to that account,
 *    no other statement"), so the transfer is never left unmatched.
 *  - SUGGEST_TAG_PREFIX + 21 hex: on a line in review, the category the
 *    categorizer would have chosen had it been sure (21 hex digits of a hash
 *    of the category's id: a tag is at most 30 characters). Review shows it as
 *    the suggestion; deciding clears it.
 *  - LEG_TAG_PREFIX + 16 hex: the statement line on the other account that a
 *    transfer was matched with, so importing that statement again adds nothing.
 *
 * The web app does not show tags; these are its bookkeeping.
 */
import { sha256Hex } from "./ids";
import type { Transaction } from "./model";

export const REVIEW_TAG = "fulla:review";
export const UNMATCHED_TAG = "fulla:unmatched-transfer";
export const LEG_TAG_PREFIX = "fulla:leg:";
export const NO_STATEMENT_TAG = "fulla:no-statement";
export const SUGGEST_TAG_PREFIX = "fulla:sg:";

export function hasTag(t: Pick<Transaction, "tags">, tag: string): boolean {
  return (t.tags ?? []).includes(tag);
}

export function withTag<T extends Transaction>(t: T, tag: string): T {
  return hasTag(t, tag) ? t : { ...t, tags: [...(t.tags ?? []), tag] };
}

export function withoutTag<T extends Transaction>(t: T, ...tags: string[]): T {
  return (t.tags ?? []).some((x) => tags.includes(x)) ? { ...t, tags: (t.tags ?? []).filter((x) => !tags.includes(x)) } : t;
}

export function legTag(fingerprint: string): string {
  return LEG_TAG_PREFIX + fingerprint.slice(0, 16);
}

export function legTags(t: Pick<Transaction, "tags">): string[] {
  return (t.tags ?? []).filter((x) => x.startsWith(LEG_TAG_PREFIX));
}

/** The tag naming a suggested category (see SUGGEST_TAG_PREFIX). */
export function suggestionTag(categoryId: string): string {
  return SUGGEST_TAG_PREFIX + sha256Hex(categoryId.toLowerCase()).slice(0, 21);
}

/** The row with its suggestion replaced (or removed, for null). */
export function withSuggestion<T extends Transaction>(t: T, categoryId: string | null): T {
  const rest = (t.tags ?? []).filter((x) => !x.startsWith(SUGGEST_TAG_PREFIX));
  return { ...t, tags: categoryId ? [...rest, suggestionTag(categoryId)] : rest };
}

/** The id of the category a row's suggestion tag names, among ids; null without one. */
export function suggestedId(t: Pick<Transaction, "tags">, ids: string[]): string | null {
  const tag = (t.tags ?? []).find((x) => x.startsWith(SUGGEST_TAG_PREFIX));
  if (!tag) return null;
  return ids.find((id) => suggestionTag(id) === tag) ?? null;
}

/** Tags a person sees as their own (everything but this bookkeeping). */
export function ownTags(tags: string[]): string[] {
  return tags.filter((x) => !x.startsWith("fulla:"));
}

/** A row the categorizer was unsure of. */
export function needsReview(t: Transaction): boolean {
  return t.status === "active" && hasTag(t, REVIEW_TAG);
}

/** A transfer seen on one statement only. */
export function isUnmatchedTransfer(t: Transaction): boolean {
  return t.status === "active" && t.kind === "transfer" && hasTag(t, UNMATCHED_TAG);
}

/**
 * A person saved a change to the row: what they chose is final, so it is no
 * longer for review. A transfer stays unmatched until it is matched or
 * someone says it is fine (that clears it explicitly).
 */
export function reviewed<T extends Transaction>(before: Transaction, after: T): T {
  const changed = before.category_id !== after.category_id || before.kind !== after.kind;
  return changed ? withoutTag(after, REVIEW_TAG) : after;
}
