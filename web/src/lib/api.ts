// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One function per database function (docs/api.md), as the Android client's
 * FullaApi: arguments named as the function's parameters, results the
 * database's JSON. Nothing reads or writes a table directly; PostgREST only
 * exposes the public.fulla_* functions.
 */
import type { Account, CategorizationRule, Category, Config, SavedImportProfile } from "./model";
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
  categoryUpsert: (householdId: string, category: Category) => call<Config>("fulla_category_upsert", { p_household_id: householdId, p_category: category }),
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

const INVITE_PROBLEMS: Record<string, string> = {
  invite_invalid: "That code is not valid.",
  invite_expired: "That code has expired. Ask for a new one.",
  invite_used: "That code has already been used.",
  already_member: "You are already in this household.",
  household_full: "This household is full.",
};
