// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Lines the household already has from another file. A statement's lines get
 * ids from their content (plan.ts), so the same file imported twice adds
 * nothing; but the same month brought in first as a CSV export (or read by an
 * earlier reader that wrote its text differently) has other ids. A line is
 * already there when the account has a row on the same day for the same
 * money (in or out), not yet claimed by another line of this import; a row
 * one or two days off counts only when the two texts share a word. Each row
 * answers for one line, so two equal coffees on one day stay two.
 */
import type { Transaction } from "../model";
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
const shareWord = (a: string, b: string) => {
  const x = words(a);
  for (const w of words(b)) if (x.has(w)) return true;
  return false;
};
const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** The proposals with those already in the household (by content, from another file) marked alreadyImported. */
export function markOverlap(proposals: ProposedTransaction[], rows: Transaction[], accountId: string): { proposals: ProposedTransaction[]; overlapped: number } {
  const live = rows.filter((r) => r.status === "active" && signedOn(r, accountId) !== null);
  const claimed = new Set(proposals.filter((p) => p.alreadyImported).map((p) => p.transaction.id));
  const out = [...proposals];
  let overlapped = 0;
  for (const near of [0, 2]) {
    out.forEach((p, i) => {
      if (p.alreadyImported) return;
      const want = p.line.amountMinor;
      const r = live.find((r) => !claimed.has(r.id) && signedOn(r, accountId) === want && gap(r.date, p.line.date) <= near &&
        (near === 0 || shareWord(r.note, p.line.description)));
      if (!r) return;
      claimed.add(r.id);
      out[i] = { ...p, alreadyImported: true };
      overlapped++;
    });
  }
  return { proposals: out, overlapped };
}
