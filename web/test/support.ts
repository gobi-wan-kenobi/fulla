// SPDX-License-Identifier: GPL-3.0-or-later
// Invented data only, as core's TestSupport Fixtures.
import type { Account, Category, Member } from "@/lib/model";

export const HOUSEHOLD = "00000000-0000-4000-8000-000000000001";
export const ALICE = "00000000-0000-4000-8000-00000000000a";
export const BOB = "00000000-0000-4000-8000-00000000000b";
export const GROCERIES = "00000000-0000-4000-8000-000000000101";
export const SALARY = "00000000-0000-4000-8000-000000000102";
export const LEISURE = "00000000-0000-4000-8000-000000000103";
export const SNACKS = "00000000-0000-4000-8000-000000000104";
export const MAIN = "00000000-0000-4000-8000-000000000201";
export const CASH = "00000000-0000-4000-8000-000000000202";

export function category(id: string, name: string, applies_to: Category["applies_to"], extra: Partial<Category> = {}): Category {
  return { id, name, applies_to, parent_id: null, icon: "label", color_index: 0, sort: 0, archived: false, ...extra };
}

function account(id: string, name: string, type: Account["type"]): Account {
  return { id, name, type, opening_balance_minor: 0, opening_balance_date: null, sort: 0, archived: false };
}

function member(id: string, display_name: string, initials: string, color_index: number, role: Member["role"]): Member {
  return { id, display_name, initials, color_index, role, status: "active", has_account: true };
}

export const config = {
  members: [member(ALICE, "Alice", "A", 0, "owner"), member(BOB, "Bob", "B", 1, "member")],
  accounts: [account(MAIN, "Main account", "checking"), account(CASH, "Cash", "cash")],
  categories: [
    category(GROCERIES, "Groceries", "expense"),
    category(SALARY, "Salary", "income"),
    category(LEISURE, "Leisure", "expense"),
    category(SNACKS, "Snacks", "expense", { parent_id: GROCERIES }),
  ],
};
