// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One transfer, however many statements show it. Money moved from account A
 * to account B appears twice: out on A's statement, in on B's. The first
 * statement imported makes the transfer, to the account its text names (or a
 * stand-in such as "Other account" or the card named in a bill payment), and
 * marks it unmatched (review.ts). When the other statement comes in, its line
 * is matched to that transfer instead of becoming a second one:
 *
 *  - same amount, the other direction, within MATCH_DAYS days;
 *  - the transfer's far end is the account being imported, or a stand-in
 *    account (one with nothing but transfers on it) that could be it: same
 *    type or "other", and no different last four digits;
 *  - the line's own far end is the transfer's statement account or such a
 *    stand-in.
 *
 * The transfer is then pointed at the real account, loses its unmatched mark,
 * and remembers the matched line's fingerprint (a leg tag), so importing that
 * statement again adds nothing. A card bill paid from the bank and the
 * "PAYMENT - THANK YOU" on the card's statement match the same way.
 *
 * Interac e-Transfers between the household's own accounts at two banks are
 * spending and income until matched: an e-Transfer out on one statement and
 * one in on another, same amount, within the window, naming the same person
 * (the account holder, on both), become one transfer.
 *
 * Runs on every import, over the new lines and every transfer still
 * unmatched, so pairs from statements imported before this existed are
 * joined too (the second row of such a pair is deleted, its fingerprint kept
 * as a leg tag on the first). Pure: the import screen writes what it returns.
 */
import type { Account, Transaction } from "./model";
import { UNMATCHED_TAG, hasTag, legTag, legTags, withTag, withoutTag } from "./review";
import { isPersonToPerson } from "./transfers";
import { normalizeName } from "./text";

export const MATCH_DAYS = 5;

export interface MatchInput {
  /** The account whose statement is being imported. */
  accountId: string;
  /** The rows the import would add, after every categorizing step. */
  fresh: Transaction[];
  /** The household's rows. */
  existing: Transaction[];
  /** The household's accounts, and any the import makes. */
  accounts: Account[];
}

export interface MatchResult {
  /** The import's rows still to add: transfers among them marked unmatched. */
  insert: Transaction[];
  /** Rows the household has, changed: a transfer pointed at its real account, spending turned into a transfer, a duplicate deleted. */
  update: Transaction[];
  /** How many lines of this import were matched to a transfer already there. */
  matched: number;
  /** How many pairs already in the household were joined. */
  joined: number;
  /** New transfers left unmatched. */
  unmatched: number;
}

const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** "Interac e-Transfer® Out to Example Person" → {"example", "person"}: the other party's name, as words. */
function party(note: string): Set<string> {
  const m = /\b(?:to|from)\s+(.+)$/i.exec(note);
  return new Set(normalizeName(m?.[1] ?? "").split(/[^\p{L}]+/u).filter((w) => w.length >= 3));
}

function sharesName(a: string, b: string): boolean {
  const x = party(a);
  for (const w of party(b)) if (x.has(w)) return true;
  return false;
}

export function matchTransfers(input: MatchInput): MatchResult {
  const X = input.accountId;
  const live = input.existing.filter((t) => t.status === "active");
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const spends = new Set([...live, ...input.fresh].filter((t) => t.kind !== "transfer" && t.account_id).map((t) => t.account_id!));
  /** An account with nothing but transfers on it: a stand-in for one whose statement has not been imported. */
  const standIn = (id: string | null) => !!id && id !== X && !spends.has(id);
  /** Could the stand-in `end` be the account `real`? */
  const couldBe = (end: string | null, real: string) => {
    if (end === real) return true;
    if (!standIn(end)) return false;
    const e = byId.get(end!);
    const r = byId.get(real);
    if (!e || !r) return true;
    if (e.last4 && r.last4 && e.last4 !== r.last4) return false;
    const bank = (k: Account["type"]) => k === "checking" || k === "savings" || k === "cash";
    return e.type === "other" || r.type === "other" || e.type === r.type || (bank(e.type) && bank(r.type));
  };
  /** The end of a transfer its statement came from: the one that is not a stand-in. */
  const sideOf = (t: Transaction): string | null => (!standIn(t.account_id) ? t.account_id : !standIn(t.to_account_id) ? t.to_account_id : null);

  const changed = new Map<string, Transaction>();
  const current = (t: Transaction) => changed.get(t.id) ?? t;
  const used = new Set<string>();
  const insert: Transaction[] = [];
  let matched = 0;
  let joined = 0;

  /**
   * A transfer the line `t` on statement account `side` is the other leg of:
   * money out of `side` (to `far`) pairs with money into another account from
   * a stand-in or from `side` itself, and the other way round.
   */
  function partner(t: Transaction, side: string, far: string | null, pool: Transaction[], exclude: string): Transaction | null {
    const out = t.account_id === side;
    const fp = t.import_fingerprint;
    let best: { r: Transaction; score: number } | null = null;
    for (const r0 of pool) {
      const r = current(r0);
      if (r.id === exclude || used.has(r.id) || r.status !== "active" || r.kind !== "transfer" || r.amount_minor !== t.amount_minor) continue;
      const gap = days(r.date, t.date);
      if (gap > MATCH_DAYS) continue;
      // Already matched to this very line: importing the statement again.
      if (fp && legTags(r).includes(legTag(fp))) return r;
      if (!hasTag(r, UNMATCHED_TAG)) continue;
      const other = out ? r.to_account_id : r.account_id; // the end the money reached (or left)
      const mine = out ? r.account_id : r.to_account_id; // the end that should be `side`
      if (!other || other === side || !couldBe(mine, side)) continue;
      if (far && !couldBe(far, other)) continue;
      const score = (mine === side ? 0 : 10) + (far === other ? 0 : 5) + gap;
      if (!best || score < best.score) best = { r, score };
    }
    return best?.r ?? null;
  }

  /** Points `r` at `side` for the leg it was missing and remembers the matched line. */
  function join(r: Transaction, side: string, legOut: boolean, fp: string | null) {
    const base = withoutTag(current(r), UNMATCHED_TAG);
    const pointed = legOut ? { ...base, account_id: side } : { ...base, to_account_id: side };
    changed.set(r.id, fp ? withTag(pointed, legTag(fp)) : pointed);
    used.add(r.id);
  }

  // 1. The import's own lines.
  for (const t of input.fresh) {
    if (t.kind === "transfer") {
      const side = t.account_id === X || t.to_account_id === X ? X : null;
      if (!side) {
        insert.push(withTag(t, UNMATCHED_TAG));
        continue;
      }
      const far = t.account_id === X ? t.to_account_id : t.account_id;
      const r = partner(t, X, far, live, t.id);
      if (r) {
        const already = !!t.import_fingerprint && legTags(current(r)).includes(legTag(t.import_fingerprint));
        if (!already) join(r, X, t.account_id === X, t.import_fingerprint);
        else used.add(r.id);
        matched++;
      } else insert.push(withTag(t, UNMATCHED_TAG));
      continue;
    }
    // An e-Transfer between two of the household's own accounts at different banks.
    if ((t.kind === "expense" || t.kind === "income") && t.account_id === X && isPersonToPerson(t.note)) {
      const r = live.find((r0) => {
        const r = current(r0);
        return !used.has(r.id) && r.status === "active" && r.account_id && r.account_id !== X && !standIn(r.account_id) &&
          r.kind === (t.kind === "expense" ? "income" : "expense") && r.amount_minor === t.amount_minor &&
          days(r.date, t.date) <= MATCH_DAYS && isPersonToPerson(r.note) && sharesName(r.note, t.note);
      });
      if (r) {
        const from = t.kind === "expense" ? X : r.account_id!;
        const to = t.kind === "expense" ? r.account_id! : X;
        const tx: Transaction = {
          ...current(r), kind: "transfer", account_id: from, to_account_id: to, category_id: null,
          paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable",
        };
        changed.set(r.id, t.import_fingerprint ? withTag(withoutTag(tx, UNMATCHED_TAG), legTag(t.import_fingerprint)) : tx);
        used.add(r.id);
        matched++;
        continue;
      }
    }
    insert.push(t);
  }

  // 2. Pairs already in the household, both still unmatched.
  const waiting = live.filter((t) => hasTag(current(t), UNMATCHED_TAG) && !used.has(t.id));
  for (const t0 of waiting) {
    const t = current(t0);
    if (used.has(t.id) || !hasTag(t, UNMATCHED_TAG)) continue;
    const side = sideOf(t);
    if (!side) continue;
    const far = t.account_id === side ? t.to_account_id : t.account_id;
    const r = partner(t, side, far, waiting, t.id);
    if (!r) continue;
    used.add(t.id);
    join(r, side, t.account_id === side, t.import_fingerprint);
    // The joined transfer also carries any line `t` had already been matched with.
    for (const leg of legTags(t)) changed.set(r.id, withTag(changed.get(r.id)!, leg));
    changed.set(t.id, { ...t, status: "deleted" });
    joined++;
  }

  return {
    insert, update: [...changed.values()], matched, joined,
    unmatched: insert.filter((t) => t.kind === "transfer" && hasTag(t, UNMATCHED_TAG)).length,
  };
}
