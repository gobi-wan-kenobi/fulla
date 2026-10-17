// SPDX-License-Identifier: GPL-3.0-or-later
// What screens draw, worked out here and tested, so screens do no arithmetic on money (AGENTS.md).
import { randomId } from "./ids";
import { activeMembers, allows, countsInTotals, type Category, type Config, type Transaction, type TransactionKind } from "./model";
import type { LocalRow } from "./sync";

/** Today in the browser's own zone, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The rows every figure counts: not deleted, not refused by the server (SyncEngine.counted). */
export function counted(rows: LocalRow[]): Transaction[] {
  return rows.filter((r) => r.tx.status === "active" && r.state !== "rejected").map((r) => r.tx);
}

/** The rows a list shows: not deleted (a refused one is shown, so it can be fixed). */
export function visible(rows: LocalRow[]): LocalRow[] {
  return rows.filter((r) => r.tx.status === "active");
}

export interface MonthTotals {
  spentMinor: number;
  incomeMinor: number;
}

/** Spent (expenses less refunds) and income in one calendar month. */
export function monthTotals(rows: LocalRow[], month: string): MonthTotals {
  let spent = 0;
  let income = 0;
  for (const t of counted(rows)) {
    if (monthOf(t.date) !== month || !countsInTotals(t.kind)) continue;
    if (t.kind === "expense") spent += t.amount_minor;
    else if (t.kind === "refund") spent -= t.amount_minor;
    else if (t.kind === "income") income += t.amount_minor;
  }
  return { spentMinor: spent, incomeMinor: income };
}

/** A month's rows, newest day first, grouped by day. Within a day, the latest written first. */
export function byDay(rows: LocalRow[], month: string): { date: string; rows: LocalRow[] }[] {
  const inMonth = visible(rows)
    .filter((r) => monthOf(r.tx.date) === month)
    .sort((a, b) => (a.tx.date === b.tx.date ? (a.tx.created_at < b.tx.created_at ? 1 : -1) : a.tx.date < b.tx.date ? 1 : -1));
  const out: { date: string; rows: LocalRow[] }[] = [];
  for (const r of inMonth) {
    const last = out[out.length - 1];
    if (last && last.date === r.tx.date) last.rows.push(r);
    else out.push({ date: r.tx.date, rows: [r] });
  }
  return out;
}

/** The amount as a list shows it: money in signed +, money out plain (never colour alone). */
export function signedAmount(t: Transaction): number {
  return t.kind === "income" || t.kind === "refund" ? t.amount_minor : t.kind === "expense" ? -t.amount_minor : t.amount_minor;
}

export function categoriesFor(config: Config, kind: TransactionKind): Category[] {
  return config.categories.filter((c) => !c.archived && allows(c.applies_to, kind)).sort((a, b) => a.sort - b.sort);
}

/**
 * A new row with the household's defaults: paid by me, split between every
 * active member when there are two or more (the database requires a split
 * then), the first account.
 */
export function newTransaction(config: Config, kind: TransactionKind, date: string): Transaction {
  const members = activeMembers(config);
  const me = config.me_member_id ?? members[0]?.id ?? null;
  const accounts = config.accounts.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const spends = kind === "expense" || kind === "refund";
  return {
    id: randomId(),
    kind,
    date,
    amount_minor: 0,
    category_id: null,
    account_id: accounts[0]?.id ?? null,
    to_account_id: kind === "transfer" ? (accounts[1]?.id ?? null) : null,
    paid_by_member_id: spends ? me : null,
    to_member_id: null,
    split: spends && members.length >= 2 ? { mode: "equal", members: members.map((m) => m.id) } : null,
    recurrence: "variable",
    note: "",
    tags: [],
    extras: {},
    status: "active",
    recurring_rule_id: null,
    occurrence_date: null,
    import_fingerprint: null,
    original_currency: null,
    trip_id: null,
    created_at: "",
    client_updated_at: "",
  };
}

/** A row changed to another kind keeps what that kind can have and drops the rest (validate_transaction). */
export function withKind(config: Config, t: Transaction, kind: TransactionKind): Transaction {
  const fresh = newTransaction(config, kind, t.date);
  const keepCategory = t.category_id && categoriesFor(config, kind).some((c) => c.id === t.category_id);
  return {
    ...t,
    kind,
    category_id: kind === "transfer" ? null : keepCategory ? t.category_id : null,
    to_account_id: kind === "transfer" ? (t.to_account_id ?? fresh.to_account_id) : null,
    paid_by_member_id: kind === "expense" || kind === "refund" ? (t.paid_by_member_id ?? fresh.paid_by_member_id) : t.paid_by_member_id,
    split: kind === "expense" || kind === "refund" ? (t.split ?? fresh.split) : null,
    to_member_id: null,
  };
}

/** Why Save is held back, or null when the row can be saved. */
export function problem(t: Transaction): string | null {
  if (!(t.amount_minor > 0)) return "Type an amount";
  if ((t.kind === "expense" || t.kind === "income" || t.kind === "refund") && !t.category_id) return "Choose a category";
  if (t.kind === "transfer" && (!t.account_id || !t.to_account_id)) return "Choose both accounts";
  if (t.kind === "transfer" && t.account_id === t.to_account_id) return "Choose two different accounts";
  return null;
}
