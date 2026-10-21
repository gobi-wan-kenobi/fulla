// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What an import writes, once every line is proposed (plan.ts): the
 * categorizer's answers and your changes applied, each row marked with how it
 * was sorted, the statement's version kept, and transfers matched to the
 * other statement's line (transferMatch.ts). Pure, so the import screen and
 * anything else that imports a statement write exactly the same rows.
 *
 * A statement's rows carry a tag naming its account and period and the
 * statement's version ("fulla:st:<12 hex>:v2"). Importing a later version of
 * the same statement replaces the earlier one: its rows that the new version
 * also has are kept (and tagged with the new version), the rest are removed.
 * An earlier version than the one imported already changes nothing.
 */
import { type ModelAnswer, modelOutcome } from "../categorizer";
import { sha256Hex } from "../ids";
import { type ExampleSource, sortedBy } from "../examples";
import type { Account, Category, Transaction } from "../model";
import { REVIEW_TAG, withSuggestion, withTag, withoutTag } from "../review";
import { matchTransfers, type MatchResult } from "../transferMatch";
import type { ProposedTransaction } from "./plan";
import type { StatementAccountInfo } from "./types";

export const STATEMENT_TAG_PREFIX = "fulla:st:";

/** The statement a row came from: its account and period, without its version ("fulla:st:<12 hex>"). */
export function statementKey(accountId: string, info: StatementAccountInfo | null | undefined): string | null {
  if (!info?.closingDate) return null;
  return STATEMENT_TAG_PREFIX + sha256Hex([accountId, info.periodStart ?? "", info.closingDate].join("|")).slice(0, 12);
}

const versionOf = (t: Transaction, key: string): number | null => {
  const tag = (t.tags ?? []).find((x) => x.startsWith(`${key}:v`));
  return tag ? Number(tag.slice(key.length + 2)) || 1 : null;
};
const withVersion = (t: Transaction, key: string, version: number): Transaction =>
  ({ ...t, tags: [...(t.tags ?? []).filter((x) => !x.startsWith(STATEMENT_TAG_PREFIX)), `${key}:v${version}`].slice(0, 20) });

export interface ImportInput {
  householdId: string;
  categories: Category[];
  accounts: Account[];
  /** Every row the household holds. */
  rows: Transaction[];
  /** Every line of the statement as proposed, those already imported included. */
  proposals: ProposedTransaction[];
  /** Accounts the proposals make (plan.ts newAccounts). */
  createdAccounts: Account[];
  /** The account the statement is for, and the new one when the import makes it. */
  accountId: string;
  proposedAccount: Account | null;
  statement: StatementAccountInfo | null;
  /** The categorizer's answers, by transaction id. */
  answers: Record<string, ModelAnswer>;
  /** Categories chosen by hand on the import screen, by transaction id. */
  overrides?: Record<string, string>;
}

export interface ImportOutput extends MatchResult {
  /** Accounts to write first: made by this import. */
  accounts: Account[];
  /** Your changes on the import screen, as before and after (examples.ts). */
  examples: { before: Transaction; after: Transaction }[];
  /** Rows of an earlier version of this statement removed. */
  replaced: number;
  /** True when a later version of this statement is already in: nothing is written. */
  older: boolean;
}

/** The rows an import writes. */
export function buildImport(input: ImportInput): ImportOutput {
  const { categories, answers, overrides = {} } = input;
  const fresh = input.proposals.filter((p) => !p.alreadyImported);
  const known = [...input.accounts, ...input.createdAccounts];

  // What Fulla writes for a line, marked with how it was sorted. A model never makes a
  // transfer (modelOutcome): what it is unsure of, or calls a transfer, goes to review.
  const auto = (p: ProposedTransaction): Transaction => {
    const t = p.transaction;
    if (p.source !== "fallback") return sortedBy(t, p.source === null ? "none" : (p.source as ExampleSource));
    const out = modelOutcome(categories, answers[t.id], t.kind, p.line.description);
    if (!out) return sortedBy(t, "none");
    if (out.review) return sortedBy(withSuggestion(withTag(t, REVIEW_TAG), out.suggestion?.id ?? null), "none", out.suggestion ? out.confidence : null);
    const c = out.category;
    if (!c) return sortedBy(t, "none", out.confidence);
    return sortedBy({ ...t, category_id: c.id, recurrence: c.fixed ? "fixed" : t.recurrence }, answers[t.id]!.by === "jev" ? "jev" : "model", out.confidence);
  };
  const examples: { before: Transaction; after: Transaction }[] = [];
  let txs = fresh.map((p) => {
    const chosen = overrides[p.transaction.id];
    if (!chosen) return auto(p);
    const c = categories.find((k) => k.id === chosen);
    const before = auto(p);
    const after = sortedBy({ ...withoutTag(p.transaction, REVIEW_TAG), category_id: chosen, recurrence: c?.fixed ? ("fixed" as const) : p.transaction.recurrence }, "user");
    examples.push({ before, after });
    return after;
  });

  // The statement's version.
  const key = statementKey(input.accountId, input.statement);
  const version = Math.max(1, input.statement?.version ?? 1);
  const replacing: Transaction[] = [];
  let older = false;
  let rows = input.rows;
  if (key) {
    const mine = input.rows.filter((r) => r.status === "active" && versionOf(r, key) !== null);
    const newest = Math.max(0, ...mine.map((r) => versionOf(r, key)!));
    if (newest > version) older = true;
    else if (newest > 0 && newest < version) {
      const keep = new Set(input.proposals.map((p) => p.transaction.id));
      for (const r of mine) replacing.push(keep.has(r.id) ? withVersion(r, key, version) : { ...r, status: "deleted" });
      const gone = new Set(replacing.filter((r) => r.status === "deleted").map((r) => r.id));
      rows = input.rows.filter((r) => !gone.has(r.id));
    }
    txs = txs.map((t) => withVersion(t, key, version));
  }
  if (older) {
    return { insert: [], update: [], matched: 0, joined: 0, unmatched: 0, accounts: [], examples: [], replaced: 0, older: true };
  }

  const m = matchTransfers({
    accountId: input.accountId, fresh: txs, existing: rows,
    accounts: [...known, ...(input.proposedAccount ? [input.proposedAccount] : [])],
  });
  const updated = new Map(replacing.map((t) => [t.id, t]));
  for (const u of m.update) updated.set(u.id, u);
  const used = new Set([...m.insert, ...updated.values()].flatMap((t) => [t.account_id, t.to_account_id]).filter(Boolean));
  const made = new Map(input.createdAccounts.map((a) => [a.id, a]));
  return {
    ...m, update: [...updated.values()], accounts: [...made.values()].filter((a) => used.has(a.id)), examples,
    replaced: replacing.filter((r) => r.status === "deleted").length, older: false,
  };
}
