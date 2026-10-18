// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which of the household's accounts a statement belongs to, from what the
 * statement says about itself: the bank, the kind of account and the last
 * four digits of its number (only those four are ever kept).
 */
import type { Account } from "./model";
import type { StatementAccountInfo } from "./importers/types";
import { accountIdFor } from "./importers/plan";
import { normalizeName } from "./text";

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && normalizeName(a) === normalizeName(b);

/**
 * The account the statement is for: the one with the statement's last four
 * digits. The digits decide; when two accounts share them, the same bank and
 * then the same kind of account break the tie. The account's name never
 * counts (a person may call their chequing "Cash"). Null when no account has
 * those digits, or the statement does not show them.
 */
export function findStatementAccount(accounts: Account[], info: StatementAccountInfo | null | undefined): Account | null {
  if (!info?.last4) return null;
  const candidates = accounts.filter((a) => !a.archived && a.last4 === info.last4);
  const score = (a: Account) => (same(a.institution, info.institution) ? 2 : 0) + (info.type && a.type === info.type ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a) || a.sort - b.sort);
  return candidates[0] ?? null;
}

const KIND: Record<string, string> = { checking: "chequing", savings: "savings", credit_card: "card", other: "account" };

/** A new account for the statement, ready to confirm: "Wealthsimple chequing ••1234". */
export function proposedStatementAccount(householdId: string, accounts: Account[], info: StatementAccountInfo): Account {
  const what = info.label?.trim() || [info.institution ?? "Bank", KIND[info.type ?? "other"]].join(" ");
  const base = what.slice(0, 33) + (info.last4 ? ` ••${info.last4}` : "");
  const taken = new Set(accounts.map((a) => normalizeName(a.name)));
  let name = base;
  for (let n = 2; taken.has(normalizeName(name)); n++) name = `${base} (${n})`;
  return {
    id: accountIdFor(householdId, `statement|${normalizeName(info.institution ?? "")}|${info.type ?? "other"}|${info.last4 ?? ""}`),
    name: name.slice(0, 40),
    type: info.type ?? "other",
    opening_balance_minor: 0, opening_balance_date: null, round_up_to: null, round_up_multiplier: null,
    sort: accounts.length, archived: false,
    institution: info.institution ? info.institution.slice(0, 40) : null,
    last4: info.last4,
  };
}

/**
 * The chosen account with the statement's bank and digits filled in where it
 * has none; null when there is nothing to add (or it already has other digits:
 * those are never overwritten). Its name and kind are never changed.
 */
export function linkedAccount(account: Account, info: StatementAccountInfo | null | undefined): Account | null {
  if (!info?.last4 || account.last4) return null;
  return { ...account, last4: info.last4, institution: account.institution ?? (info.institution ? info.institution.slice(0, 40) : null) };
}

/** True when the chosen account shows different digits from the statement's. */
export function digitsDiffer(account: Account | null | undefined, info: StatementAccountInfo | null | undefined): boolean {
  return !!account?.last4 && !!info?.last4 && account.last4 !== info.last4;
}
