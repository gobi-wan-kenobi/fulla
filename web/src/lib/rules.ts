// SPDX-License-Identifier: GPL-3.0-or-later
import { randomId } from "./ids";
import type { CategorizationRule, Config } from "./model";

/** A new rule's sort: after every rule there is (deleted ones too), so older rules keep winning. */
export function nextSort(rules: CategorizationRule[]): number {
  return rules.reduce((m, r) => Math.max(m, r.sort), -1) + 1;
}

/** Rules, like the rest of a household's structure, are an admin's to change (fulla_rule_upsert). */
export function canManage(config: Config): boolean {
  const me = config.members.find((m) => m.id === config.me_member_id);
  return me?.role === "owner" || me?.role === "admin";
}

/** A new rule putting what contains pattern into a category. */
export function newRule(config: Config, pattern: string, categoryId: string | null): CategorizationRule {
  return { id: randomId(), pattern: pattern.trim().slice(0, 100), action: { category_id: categoryId }, sort: nextSort(config.categorization_rules ?? []), active: true, archived: false };
}

/** A rule deleted: archived and paused, so it never matches again (rows are never deleted, 0023). */
export function deletedRule(rule: CategorizationRule): CategorizationRule {
  return { ...rule, active: false, archived: true };
}

/** The rules a screen lists: not deleted, in the order they are tried. */
export function shownRules(rules: CategorizationRule[] | undefined): CategorizationRule[] {
  return (rules ?? []).filter((r) => !r.archived).sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1));
}
