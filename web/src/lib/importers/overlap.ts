// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Lines the household already has from another file. A statement's lines get
 * ids from their content (plan.ts), so the same file imported twice adds
 * nothing; but the same month brought in first as a CSV export (or read by an
 * earlier reader that wrote its text differently) has other ids. A line is
 * already there when the account has a row on the same day for the same
 * money (in or out), not yet claimed by another line of this import; a row
 * one or two days off counts only when the two texts share a word. Each row
 * answers for one line, so two equal coffees on one day stay two. A transfer
 * still waiting for its other statement may be this line's other leg rather
 * than this line: when the statement it came from is known (its rows share a
 * statement tag, and one account is on all of them) that account decides;
 * otherwise the texts must share a word beyond the usual ones ("transfer",
 * "payment"). An other leg is left to transfer matching, which joins the two.
 */
import type { Transaction } from "../model";
import { STATEMENT_TAG_PREFIX } from "./pipeline";
import { UNMATCHED_TAG, hasTag } from "../review";
import { normalizeName } from "../text";
import type { ProposedTransaction } from "./plan";

/** What a row did to `accountId`, signed as a statement line is: negative for money out. */
export function signedOn(t: Transaction, accountId: string): number | null {
  if (t.kind === "transfer") {
    if (t.account_id === accountId) return -t.amount_minor;
    if (t.to_account_id === accountId) return t.amount_minor;
    return null;
  }
  if (t.account_id !== accountId) return null;
  return t.kind === "expense" ? -t.amount_minor : t.amount_minor;
}

const words = (s: string) => new Set(normalizeName(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
const USUAL = new Set(["transfer", "transfers", "payment", "payments", "paiement", "received", "thank", "you", "merci", "online", "bill", "from", "into", "the", "account", "for", "out", "and", "money", "interac"]);
const shareWord = (a: string, b: string, usual = false) => {
  const x = words(a);
  for (const w of words(b)) if (x.has(w) && (usual || !USUAL.has(w))) return true;
  return false;
};
const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** The proposals with those already in the household (by content, from another file) marked alreadyImported. */
export function markOverlap(proposals: ProposedTransaction[], rows: Transaction[], accountId: string): { proposals: ProposedTransaction[]; overlapped: number } {
  const live = rows.filter((r) => r.status === "active" && signedOn(r, accountId) !== null);
  // The account each statement's rows were read from: the one on all of them.
  const keyOf = (r: Transaction) => (r.tags ?? []).find((x) => x.startsWith(STATEMENT_TAG_PREFIX))?.replace(/:v\d+$/, "") ?? null;
  const ends = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.status === "active" ? keyOf(r) : null;
    if (!key) continue;
    const mine = new Set([r.account_id, r.to_account_id].filter((x): x is string => !!x));
    const had = ends.get(key);
    ends.set(key, had ? new Set([...had].filter((x) => mine.has(x))) : mine);
  }
  const origin = (r: Transaction): string | null => {
    const key = keyOf(r);
    const set = key ? ends.get(key) : null;
    return set && set.size === 1 ? [...set][0] : null;
  };
  /** Could the row be this very line, read before from another file? */
  const same = (r: Transaction, description: string, near: number): boolean => {
    if (r.kind === "transfer" && hasTag(r, UNMATCHED_TAG)) {
      const from = origin(r);
      if (from) return from === accountId && (near === 0 || shareWord(r.note, description, true));
      return shareWord(r.note, description);
    }
    return near === 0 || shareWord(r.note, description, true);
  };
  const claimed = new Set(proposals.filter((p) => p.alreadyImported).map((p) => p.transaction.id));
  const out = [...proposals];
  let overlapped = 0;
  for (const near of [0, 2]) {
    out.forEach((p, i) => {
      if (p.alreadyImported) return;
      const want = p.line.amountMinor;
      const r = live.find((r) => !claimed.has(r.id) && signedOn(r, accountId) === want && gap(r.date, p.line.date) <= near && same(r, p.line.description, near));
      if (!r) return;
      claimed.add(r.id);
      out[i] = { ...p, alreadyImported: true };
      overlapped++;
    });
  }
  return { proposals: out, overlapped };
}
