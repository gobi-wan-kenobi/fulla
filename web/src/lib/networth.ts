// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Net worth: what the household's accounts hold, less what it owes.
 *
 * Each account's figure is the Balances one (lib/balances.ts balancesView,
 * itself overview.accountBalances): its latest statement balance (for an
 * investment account, the statement's market value) or its opening balance,
 * plus everything recorded on it since. Cards are stored as negatives, so the
 * total is a plain sum: assets (cash and investments) plus debts (negative).
 *
 * An account counts only once Fulla knows where it starts (a statement or an
 * opening balance). One with things recorded on it but no starting point (an
 * investment account with no statement yet, a child's cash, a stand-in from an
 * import) is listed as missing and left out of the total: its sum of flows is
 * not what it holds. One with nothing at all is an unused stand-in and is not
 * listed. An account marked exclude_from_net_worth (a child's) is left out
 * completely: not listed, not counted, not in any history point. A figure whose latest statement is older than STALE_DAYS is counted
 * but flagged.
 *
 * History: a point at the end of each month (today for this one), the sum of
 * the accounts known by that day, as each stood then (no market value is
 * guessed between statements).
 */
import { balancesView, type AccountLine } from "./balances";
import { daysBetween, daysInMonth } from "./dates";
import type { Account, Config, Transaction } from "./model";
import { type BalanceSnapshot, accountBalances } from "./overview";

export type NetWorthGroup = "cash" | "investments" | "debt";
export const GROUPS: NetWorthGroup[] = ["cash", "investments", "debt"];
export const GROUP_LABEL: Record<NetWorthGroup, string> = { cash: "Cash", investments: "Investments", debt: "Cards & debt" };
/** A statement older than this (in days, as of the day shown) is flagged stale. */
export const STALE_DAYS = 45;

export type NetWorthStatus = "current" | "stale" | "missing";

export interface NetWorthLine {
  account: Account;
  group: NetWorthGroup;
  /** What it holds as of the day shown; for a missing account, only what was recorded on it. */
  balanceMinor: number;
  status: NetWorthStatus;
  /** The statement (or opening balance) date the figure counts from; null when missing. */
  asOf: string | null;
  /** "statement" (market value for an investment account), "opening" or null. */
  basis: "statement" | "opening" | null;
  /** Days since asOf, as of the day shown. */
  ageDays: number | null;
  /** Rows recorded on it after asOf (already in balanceMinor). */
  since: number;
  /** In the total. */
  counted: boolean;
}

export interface NetWorthGroupTotal {
  group: NetWorthGroup;
  totalMinor: number;
  lines: NetWorthLine[];
}

export interface NetWorthPoint {
  /** The month's last day, or the day shown for its month. */
  date: string;
  totalMinor: number;
  /** Accounts known by then. */
  accounts: number;
}

export interface NetWorth {
  asOf: string;
  totalMinor: number;
  assetsMinor: number;
  debtsMinor: number;
  groups: NetWorthGroupTotal[];
  /** Counted accounts, then missing ones, in the accounts' order. */
  lines: NetWorthLine[];
  missing: NetWorthLine[];
  stale: NetWorthLine[];
  /** Open accounts with nothing on them at all: not listed. */
  unused: Account[];
  history: NetWorthPoint[];
  /** Anything known at all: else there is no net worth to show. */
  known: boolean;
}

export function groupOf(a: Account): NetWorthGroup {
  if (a.type === "credit_card") return "debt";
  if (a.type === "investment") return "investments";
  return "cash";
}

function touches(t: Transaction, id: string): boolean {
  return t.account_id === id || t.to_account_id === id;
}

function startOf(a: Account, snapshots: BalanceSnapshot[], on: string): { date: string; basis: "statement" | "opening" } | null {
  const s = snapshots.filter((x) => x.account_id === a.id && x.as_of <= on).map((x) => x.as_of).sort().at(-1);
  if (s) return { date: s, basis: "statement" };
  if (a.opening_balance_date && a.opening_balance_date <= on) return { date: a.opening_balance_date, basis: "opening" };
  if ((a.opening_balance_minor ?? 0) !== 0 && !a.opening_balance_date) return { date: "", basis: "opening" };
  return null;
}

/** The month ends from the first known start to asOf's month, asOf last. */
function monthEnds(first: string, asOf: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number);
  for (let i = 0; i < 600; i++) {
    const end = `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
    if (end >= asOf) { out.push(asOf); break; }
    out.push(end);
    m += 1;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function netWorth(config: Config, txs: Transaction[], snapshots: BalanceSnapshot[], asOf: string): NetWorth {
  const active = txs.filter((t) => t.status === "active");
  const view = balancesView(config, active, snapshots, asOf);
  view.accounts = view.accounts.filter((l) => !l.account.exclude_from_net_worth);
  const toLine = (l: AccountLine): NetWorthLine | null => {
    const a = l.account;
    const start = startOf(a, snapshots, asOf);
    const used = active.some((t) => touches(t, a.id) && t.date <= asOf);
    if (!start && !used) return null;
    const since = start ? active.filter((t) => touches(t, a.id) && t.date <= asOf && (start.date === "" || t.date > start.date)).length : 0;
    const age = start && start.date ? daysBetween(start.date, asOf) : null;
    const status: NetWorthStatus = !start ? "missing" : start.basis === "statement" && age !== null && age > STALE_DAYS ? "stale" : "current";
    return { account: a, group: groupOf(a), balanceMinor: l.balanceMinor, status, asOf: start?.date || null, basis: start?.basis ?? null, ageDays: age, since, counted: !!start };
  };
  const all = view.accounts.map((l) => ({ l, line: toLine(l) }));
  const lines = all.map((x) => x.line).filter((x): x is NetWorthLine => !!x);
  const unused = all.filter((x) => !x.line).map((x) => x.l.account);
  const counted = lines.filter((l) => l.counted);
  const groups = GROUPS.map((g) => {
    const ls = lines.filter((l) => l.group === g);
    return { group: g, lines: ls, totalMinor: ls.filter((l) => l.counted).reduce((n, l) => n + l.balanceMinor, 0) };
  });
  const totalMinor = counted.reduce((n, l) => n + l.balanceMinor, 0);
  const debtsMinor = counted.filter((l) => l.group === "debt").reduce((n, l) => n + l.balanceMinor, 0);

  // History: each month end, the accounts known by then.
  const open = config.accounts.filter((a) => !a.archived && !a.exclude_from_net_worth);
  const starts = open.map((a) => startOf(a, snapshots, asOf)?.date).filter((d): d is string => !!d).sort();
  const firstSnap = snapshots.filter((s) => open.some((a) => a.id === s.account_id) && s.as_of <= asOf).map((s) => s.as_of).sort()[0];
  const first = [starts[0], firstSnap].filter(Boolean).sort()[0];
  const history: NetWorthPoint[] = first ? monthEnds(first, asOf).map((date) => {
    const known = open.filter((a) => {
      const s = startOf(a, snapshots, date);
      return !!s;
    });
    const b = accountBalances(active, known, snapshots, date);
    return { date, totalMinor: [...b.values()].reduce((n, v) => n + v, 0), accounts: known.length };
  }).filter((p) => p.accounts > 0) : [];

  return {
    asOf, totalMinor, assetsMinor: totalMinor - debtsMinor, debtsMinor, groups,
    lines: [...counted, ...lines.filter((l) => !l.counted)],
    missing: lines.filter((l) => l.status === "missing"), stale: lines.filter((l) => l.status === "stale"),
    unused, history, known: counted.length > 0,
  };
}

