// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One function per database function (docs/api.md), as the Android client's
 * FullaApi: arguments named as the function's parameters, results the
 * database's JSON. Nothing reads or writes a table directly; PostgREST only
 * exposes the public.fulla_* functions.
 */
import type { Goal, GoalContribution } from "./goals";
import type { ModelAnswer, ModelItem } from "./categorizer";
import type { Account, Budget, CategorizationRule, Category, Config, RecurringRule, SavedImportProfile } from "./model";
import type { Mutation, PullPage, PushResult } from "./sync";
import { supabase } from "./supabase";

export class FullaError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
  }
}

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error, status } = await supabase().rpc(fn, args);
  if (error) {
    // The backend's own code is in `details` (docs/api.md, Errors).
    const code = typeof error.details === "string" && /^[a-z_]+$/.test(error.details) ? error.details : status === 401 ? "not_authenticated" : "validation_failed";
    throw new FullaError(code, error.message, status);
  }
  return data as T;
}

export interface Membership {
  household_id: string;
  name: string;
  currency: string;
  member_id: string;
  role: string;
}

export interface Joined {
  household_id: string;
  member_id: string;
  config: Config;
}

export interface GoalsBundle { goals: Goal[]; contributions: GoalContribution[] }

export const api = {
  myHouseholds: () => call<Membership[]>("fulla_my_households"),

  householdCreate: (p: { name: string; currency: string; locale: string; displayName: string; initials: string; colorIndex: number }) =>
    call<Joined>("fulla_household_create", {
      p_name: p.name, p_currency: p.currency, p_locale: p.locale, p_display_name: p.displayName, p_initials: p.initials, p_color_index: p.colorIndex,
    }),

  inviteCreate: (householdId: string, role: "member" | "admin", ttlHours = 72) =>
    call<{ code: string; expires_at: string; role: string }>("fulla_invite_create", {
      p_household_id: householdId, p_role: role, p_claim_member_id: null, p_ttl_hours: ttlHours,
    }),

  /** A bad code answers 200 {ok: false, error}, so the attempt is recorded and the next guess throttled. */
  inviteAccept: async (code: string, displayName: string, initials: string, colorIndex: number): Promise<Joined> => {
    const o = await call<{ ok?: boolean; error?: string } & Joined>("fulla_invite_accept", {
      p_code: code.trim(), p_display_name: displayName, p_initials: initials, p_color_index: colorIndex,
    });
    if (o.ok === false) throw new FullaError(o.error ?? "invite_invalid", INVITE_PROBLEMS[o.error ?? ""] ?? "That code did not work.");
    return o;
  },

  configGet: (householdId: string) => call<Config>("fulla_config_get", { p_household_id: householdId }),

  accountUpsert: (householdId: string, account: Account) => call<Config>("fulla_account_upsert", { p_household_id: householdId, p_account: account }),
  /** A statement's closing balance for one of the household's accounts (statements only, for now). */
  balanceSnapshotSave: (householdId: string, snapshot: { account_id: string; as_of: string; balance_minor: number }) =>
    call<{ id: string }>("fulla_balance_snapshot_save", { p_household_id: householdId, p_snapshot: snapshot }),
  balanceSnapshots: (householdId: string) =>
    call<{ id: string; account_id: string; as_of: string; balance_minor: number; source: string }[]>("fulla_balance_snapshots", { p_household_id: householdId }),
  categoryUpsert: (householdId: string, category: Category) => call<Config>("fulla_category_upsert", { p_household_id: householdId, p_category: category }),
  /** A category's limit, for every month (period null) or one; admins only. Saving 0 removes it (rows are never deleted). */
  budgetUpsert: (householdId: string, budget: Budget) => call<Config>("fulla_budget_upsert", { p_household_id: householdId, p_budget: budget }),
  /** Every category's limit of one month (its own or the default) as the other month's own; limits it already has stay. */
  budgetCopy: (householdId: string, from: string, to: string) => call<Config>("fulla_budget_copy", { p_household_id: householdId, p_from_period: from, p_to_period: to }),
  /** The household's goals and the contributions recorded against them (0033). */
  goals: (householdId: string) => call<GoalsBundle>("fulla_goals", { p_household_id: householdId }),
  /** Creates or changes a goal (admin); archived, never deleted. */
  goalUpsert: (householdId: string, goal: Goal) => call<GoalsBundle>("fulla_goal_upsert", { p_household_id: householdId, p_goal: goal }),
  /** Records, changes or voids a contribution towards a goal (any member). */
  goalContributionSave: (householdId: string, c: GoalContribution & { voided?: boolean }) => call<GoalsBundle>("fulla_goal_contribution_save", { p_household_id: householdId, p_contribution: c }),
  /** A recurring item (admin): a confirmed suggestion, an edit, or one archived. Returns the config. Never auto_create from the web. */
  recurringUpsert: (householdId: string, rule: RecurringRule) => call<Config>("fulla_recurring_upsert", { p_household_id: householdId, p_rule: rule }),
  /** The suggestion keys the household dismissed (0031). */
  recurringDismissals: (householdId: string) => call<string[]>("fulla_recurring_dismissals", { p_household_id: householdId }),
  /** Dismisses a suggestion, or offers it again with dismissed false (admin). Returns the dismissed keys. */
  recurringDismiss: (householdId: string, key: string, dismissed = true) =>
    call<string[]>("fulla_recurring_dismiss", { p_household_id: householdId, p_key: key, p_dismissed: dismissed }),
  ruleUpsert: (householdId: string, rule: CategorizationRule) => call<Config>("fulla_rule_upsert", { p_household_id: householdId, p_rule: rule }),
  importProfileUpsert: (householdId: string, profile: SavedImportProfile) =>
    call<Config>("fulla_import_profile_upsert", { p_household_id: householdId, p_profile: profile }),

  push: async (householdId: string, mutations: Mutation[]): Promise<PushResult[]> => {
    const o = await call<{ results: PushResult[] }>("fulla_sync_push", { p_household_id: householdId, p_mutations: mutations });
    return o.results ?? [];
  },

  pull: (householdId: string, since: number, configVersion: number, limit = 500) =>
    call<PullPage>("fulla_sync_pull", { p_household_id: householdId, p_since: since, p_config_version: configVersion, p_limit: limit }),
};

/**
 * The optional model step (app/api/categorize): answers for the lines it could
 * read, nothing at all when it is off or failing. Never throws.
 */
export const categorizer = {
  enabled: async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/categorize", { cache: "no-store" });
      return res.ok && ((await res.json()) as { enabled?: boolean }).enabled === true;
    } catch {
      return false;
    }
  },
  ask: async (items: ModelItem[]): Promise<Record<string, ModelAnswer>> => {
    if (items.length === 0) return {};
    try {
      const { data } = await supabase().auth.getSession();
      const token = data.session?.access_token;
      if (!token) return {};
      const out: Record<string, ModelAnswer> = {};
      for (let i = 0; i < items.length; i += 40) {
        const res = await fetch("/api/categorize", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ items: items.slice(i, i + 40) }),
        });
        if (!res.ok) break;
        const body = (await res.json()) as { results?: Record<string, ModelAnswer>; stopped?: string | null };
        Object.assign(out, body.results ?? {});
        if (body.stopped === "quota" || body.stopped === "off") break;
      }
      return out;
    } catch (e) {
      console.warn("categorizer unavailable", e instanceof Error ? e.message : e);
      return {};
    }
  },
};

const INVITE_PROBLEMS: Record<string, string> = {
  invite_invalid: "That code is not valid.",
  invite_expired: "That code has expired. Ask for a new one.",
  invite_used: "That code has already been used.",
  already_member: "You are already in this household.",
  household_full: "This household is full.",
};
