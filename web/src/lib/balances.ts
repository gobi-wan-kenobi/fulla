// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Balances screen's figures, ported from core's balance/Balances.kt,
 * split/Allocator.kt and the Android BalancesScreen: who owes whom between
 * the household's members, the fewest payments that would settle it, and
 * what is in each account.
 *
 *   expense A paid by P, split s     paid(P) += A    share(i) += s_i
 *   refund  A to P, split s          paid(P) -= A    share(i) -= s_i
 *   settlement A from X to Y         paid(X) += A    paid(Y) -= A
 *   income, transfer                 no effect
 *
 * The same rule is the database's fulla.member_balances view; all three pass
 * testdata/vectors/balance.json and allocate.json, so the web, the phones and
 * the server agree to the unit. Debts are about who paid for what, so they
 * are not filtered by the spending exclusions: a transfer or an income (a
 * grant included) never moves one anyway.
 */
import type { Account, Config, Member, Split, Transaction } from "./model";
import { activeMembers } from "./model";
import { accountBalances, type BalanceSnapshot } from "./overview";
import { randomId } from "./ids";

/**
 * Who owes what of an amount; the parts always add up to it. Equal and share
 * splits use the largest remainder method, leftover units going to the
 * largest remainders, ties by member id in byte order (fulla.split_shares).
 */
export function allocate(amountMinor: number, split: Split): Record<string, number> {
  if (split.mode === "exact") return { ...split.amounts };
  const weights: [string, bigint][] = split.mode === "equal"
    ? split.members.map((m) => [m, BigInt(1)])
    : Object.entries(split.shares).map(([m, w]) => [m, BigInt(w)]);
  if (weights.length === 0) throw new Error("A split needs at least one member");
  const amount = BigInt(amountMinor);
  const total = weights.reduce((a, [, w]) => a + w, BigInt(0));
  const parts = weights.map(([id, w]) => ({ id, base: (amount * w) / total, remainder: (amount * w) % total }));
  let leftover = amount - parts.reduce((a, p) => a + p.base, BigInt(0));
  const order = [...parts].sort((a, b) => (a.remainder === b.remainder ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.remainder > b.remainder ? -1 : 1));
  const bonus = new Set<string>();
  for (const p of order) {
    if (leftover <= BigInt(0)) break;
    bonus.add(p.id);
    leftover -= BigInt(1);
  }
  return Object.fromEntries(parts.map((p) => [p.id, Number(p.base) + (bonus.has(p.id) ? 1 : 0)]));
}

/** What a member has paid, what their share came to; balance > 0: the household owes them. */
export interface MemberBalance {
  memberId: string;
  paidMinor: number;
  shareMinor: number;
  balanceMinor: number;
}

type BalanceRow = Pick<Transaction, "kind" | "amount_minor" | "paid_by_member_id" | "to_member_id" | "split"> & { status?: Transaction["status"] };

export function memberBalances(txs: BalanceRow[], memberIds: string[]): MemberBalance[] {
  const paid = new Map<string, number>();
  const share = new Map<string, number>();
  const add = (m: Map<string, number>, id: string | null, n: number) => { if (id) m.set(id, (m.get(id) ?? 0) + n); };
  for (const t of txs) {
    if (t.status && t.status !== "active") continue;
    if (t.kind === "expense" || t.kind === "refund") {
      const sign = t.kind === "refund" ? -1 : 1;
      add(paid, t.paid_by_member_id, sign * t.amount_minor);
      const parts = t.split ? allocate(t.amount_minor, t.split) : t.paid_by_member_id ? { [t.paid_by_member_id]: t.amount_minor } : {};
      for (const [id, part] of Object.entries(parts)) add(share, id, sign * part);
    } else if (t.kind === "settlement") {
      add(paid, t.paid_by_member_id, t.amount_minor);
      add(paid, t.to_member_id, -t.amount_minor);
    }
  }
  const ids = [...new Set([...memberIds, ...paid.keys(), ...share.keys()])];
  return ids.map((id) => {
    const p = paid.get(id) ?? 0;
    const s = share.get(id) ?? 0;
    return { memberId: id, paidMinor: p, shareMinor: s, balanceMinor: p - s };
  });
}

/** One payment of a settlement plan: from pays to. */
export interface Payment {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

/**
 * The fewest payments that bring every balance to zero: the largest debtor
 * pays the largest creditor the smaller of the two, repeatedly; at most N-1
 * payments, ties by member id (SettlementPlanner).
 */
export function settlementPlan(balances: MemberBalance[]): Payment[] {
  if (balances.reduce((a, b) => a + b.balanceMinor, 0) !== 0) throw new Error("Balances must add up to zero");
  const order = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const creditors: [string, number][] = balances.filter((b) => b.balanceMinor > 0).map((b) => [b.memberId, b.balanceMinor]);
  const debtors: [string, number][] = balances.filter((b) => b.balanceMinor < 0).map((b) => [b.memberId, -b.balanceMinor]);
  const out: Payment[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort(order);
    debtors.sort(order);
    const [creditor, owed] = creditors[0];
    const [debtor, owes] = debtors[0];
    const amount = Math.min(owed, owes);
    out.push({ fromMemberId: debtor, toMemberId: creditor, amountMinor: amount });
    if (owed === amount) creditors.shift(); else creditors[0] = [creditor, owed - amount];
    if (owes === amount) debtors.shift(); else debtors[0] = [debtor, owes - amount];
  }
  return out;
}

/** The settlement that records a payment of the plan: it moves the balances and no total. */
export function settlementFor(p: Payment, date: string, me: string | null, id = randomId()): Transaction {
  return {
    id, kind: "settlement", date, amount_minor: p.amountMinor,
    category_id: null, account_id: null, to_account_id: null,
    paid_by_member_id: p.fromMemberId, to_member_id: p.toMemberId, split: null,
    recurrence: "variable", note: "", tags: [], extras: {}, status: "active",
    recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, trip_id: null,
    created_at: "", client_updated_at: "", created_by_member_id: me,
  };
}

export interface AccountLine {
  account: Account;
  balanceMinor: number;
  /** Fulla knows where it started (an opening or a statement balance); otherwise the figure is only what was recorded on it. */
  known: boolean;
  /** The latest statement balance it counts from, if any. */
  statementAsOf: string | null;
}

export interface BalancesView {
  /** One shared pot: nobody owes anybody, and the accounts are shown with their total. */
  shared: boolean;
  /** Between members (two or more active), else null. */
  between: { member: Member | undefined; memberId: string; balanceMinor: number }[] | null;
  plan: Payment[];
  accounts: AccountLine[];
  /** All open accounts together; only in a shared pot, as the original (the Net worth screen will own totals). */
  totalMinor: number | null;
}

export function balancesView(config: Config, txs: Transaction[], snapshots: BalanceSnapshot[], asOf: string): BalancesView {
  const shared = config.household.money_mode === "shared";
  const active = activeMembers(config);
  const balances = memberBalances(txs, config.members.map((m) => m.id));
  const member = (id: string) => config.members.find((m) => m.id === id);
  const between = !shared && active.length >= 2
    ? balances
      .filter((b) => member(b.memberId)?.status === "active" || b.balanceMinor !== 0)
      .map((b) => ({ member: member(b.memberId), memberId: b.memberId, balanceMinor: b.balanceMinor }))
    : null;
  const plan = between ? settlementPlan(balances) : [];
  const open = config.accounts.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const held = accountBalances(txs, open, snapshots, asOf);
  const accounts = open.map((a) => {
    const statements = snapshots.filter((s) => s.account_id === a.id && s.as_of <= asOf).map((s) => s.as_of).sort();
    const statementAsOf = statements.at(-1) ?? null;
    return {
      account: a,
      balanceMinor: held.get(a.id) ?? 0,
      known: statementAsOf !== null || (a.opening_balance_minor ?? 0) !== 0 || !!a.opening_balance_date,
      statementAsOf,
    };
  });
  const totalMinor = shared ? accounts.reduce((n, l) => n + l.balanceMinor, 0) : null;
  return { shared, between, plan, accounts, totalMinor };
}
