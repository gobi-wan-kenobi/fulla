// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The household as the database's JSON has it (docs/api.md, docs/data-model.md).
 * Field names are the wire's own, so nothing is mapped: what a pull returns is
 * what a push sends.
 */

export type TransactionKind = "expense" | "income" | "refund" | "transfer" | "settlement";
export type AppliesTo = "expense" | "income" | "both";
export type Role = "member" | "admin" | "owner";

export type Split =
  | { mode: "equal"; members: string[] }
  | { mode: "shares"; shares: Record<string, number> }
  | { mode: "exact"; amounts: Record<string, number> };

export interface Transaction {
  id: string;
  kind: TransactionKind;
  date: string; // YYYY-MM-DD
  amount_minor: number;
  category_id: string | null;
  account_id: string | null;
  to_account_id: string | null;
  paid_by_member_id: string | null;
  to_member_id: string | null;
  split: Split | null;
  recurrence: "fixed" | "variable";
  note: string;
  tags: string[];
  extras: Record<string, unknown>;
  status: "active" | "deleted";
  recurring_rule_id: string | null;
  occurrence_date: string | null;
  import_fingerprint: string | null;
  original_amount_minor?: number | null;
  original_currency: string | null;
  trip_id?: string | null;
  created_at: string;
  client_updated_at: string;
  server_seq?: number;
  created_by_member_id?: string | null;
}

export interface Household {
  id: string;
  name: string;
  currency: string;
  locale: string;
  period_start_day: number;
  income_shift_day: number | null;
  week_start: number;
  member_limit: number;
  money_mode: "split" | "shared" | null;
}

export interface Member {
  id: string;
  display_name: string;
  initials: string;
  color_index: number;
  role: Role;
  status: "active" | "archived" | "removed";
  has_account: boolean;
}

/** Every account type the database takes (0001, investment since 0029), in the order they are listed. */
export const ACCOUNT_TYPES = ["cash", "checking", "savings", "credit_card", "investment", "other"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: "cash", checking: "checking", savings: "savings", credit_card: "credit card", investment: "investment", other: "other",
};
/** An account type's icon (a Material name, like the categories', drawn by Icon). */
export const ACCOUNT_TYPE_ICONS: Record<AccountType, string> = {
  cash: "payments", checking: "account_balance", savings: "savings", credit_card: "credit_card", investment: "trending_up", other: "more_horiz",
};
/** How an account's type reads next to its name ("credit card", "investment"). */
export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABELS[type as AccountType] ?? type.replace(/_/g, " ");
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  opening_balance_minor: number;
  opening_balance_date?: string | null;
  round_up_to?: string | null;
  round_up_multiplier?: number | null;
  sort: number;
  archived: boolean;
  /** Web: the bank, as a statement names it. */
  institution?: string | null;
  /** Web: the last four digits of the account number, from a statement. Never more. */
  last4?: string | null;
}

export interface Category {
  id: string;
  name: string;
  applies_to: AppliesTo;
  parent_id: string | null;
  icon: string;
  color_index: number;
  sort: number;
  archived: boolean;
  /** Spending here is usually the same every period (0023); the default a transaction's recurrence gets. */
  fixed?: boolean;
}

export interface CategorizationRule {
  id: string;
  pattern: string;
  action: { category_id?: string | null; kind?: TransactionKind | null; to_account_id?: string | null; tags?: string[] };
  sort: number;
  active: boolean;
  /** Deleted (0023): kept, never matches, not shown. */
  archived?: boolean;
}

export interface SavedImportProfile {
  id: string;
  name: string;
  format: string;
  account_id: string | null;
  mapping: Record<string, unknown>;
}

export interface Config {
  config_version: number;
  household: Household;
  me_member_id: string | null;
  members: Member[];
  accounts: Account[];
  categories: Category[];
  custom_fields: unknown[];
  budgets: unknown[];
  recurring_rules: unknown[];
  categorization_rules: CategorizationRule[];
  import_profiles: SavedImportProfile[];
  trips?: unknown[];
}

export function countsInTotals(kind: TransactionKind): boolean {
  return kind === "expense" || kind === "income" || kind === "refund";
}

export function isCategorised(kind: TransactionKind): boolean {
  return countsInTotals(kind);
}

/** Which kinds a category can be used for (core's AppliesTo.allows). */
export function allows(appliesTo: AppliesTo, kind: TransactionKind): boolean {
  if (kind === "expense" || kind === "refund") return appliesTo !== "income";
  if (kind === "income") return appliesTo !== "expense";
  return false;
}

export function activeMembers(config: Config): Member[] {
  return config.members.filter((m) => m.status === "active");
}

/**
 * A new transaction as this household stores it (core's SharedPot.forNew):
 * in one shared pot an expense or refund is its payer's alone.
 */
export function sharedPotForNew(t: Transaction, household: Household): Transaction {
  if (household.money_mode !== "shared" || !t.paid_by_member_id) return t;
  if (t.kind === "expense" || t.kind === "refund") return { ...t, split: { mode: "equal", members: [t.paid_by_member_id] } };
  return t;
}
