// SPDX-License-Identifier: GPL-3.0-or-later
// Rule create, edit, pause and delete as the web sends them to fulla_rule_upsert
// (the RPC itself is tested in supabase/tests). The Supabase client is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@/lib/model";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: () => ({ rpc }) }));

const { api } = await import("@/lib/api");
const { canManage, deletedRule, newRule, shownRules } = await import("@/lib/rules");

const HH = "00000000-0000-4000-8000-000000000001";
const GROCERIES = "00000000-0000-4000-8000-000000000101";
const config = (role: "owner" | "admin" | "member", rules: Config["categorization_rules"] = []) => ({
  household: { id: HH }, me_member_id: "me",
  members: [{ id: "me", role, status: "active" }], categorization_rules: rules,
}) as unknown as Config;

describe("rule CRUD through fulla_rule_upsert", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(async (_fn: string, args: { p_rule: unknown }) => ({ data: { categorization_rules: [args.p_rule] }, error: null, status: 200 }));
  });

  it("creates a rule after the others, then edits, pauses and deletes it by saving it again", async () => {
    const r = newRule(config("owner", [{ id: "x", pattern: "old", action: {}, sort: 7, active: true }]), "  tim hortons  ", GROCERIES);
    expect(r).toMatchObject({ pattern: "tim hortons", action: { category_id: GROCERIES }, sort: 8, active: true, archived: false });
    await api.ruleUpsert(HH, r);
    expect(rpc).toHaveBeenLastCalledWith("fulla_rule_upsert", { p_household_id: HH, p_rule: r });

    const edited = { ...r, pattern: "tims" };
    await api.ruleUpsert(HH, edited);
    expect(rpc.mock.lastCall![1].p_rule).toMatchObject({ id: r.id, pattern: "tims" });

    await api.ruleUpsert(HH, { ...edited, active: false });
    expect(rpc.mock.lastCall![1].p_rule).toMatchObject({ id: r.id, active: false });

    const gone = deletedRule(edited);
    await api.ruleUpsert(HH, gone);
    expect(rpc.mock.lastCall![1].p_rule).toMatchObject({ id: r.id, active: false, archived: true });
  });

  it("a refused save surfaces the database's code", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Only admins.", details: "forbidden" }, status: 403 });
    await expect(api.ruleUpsert(HH, newRule(config("member"), "x y", GROCERIES))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lists rules that are not deleted, in the order they are tried", () => {
    const rules = [
      { id: "b", pattern: "b", action: {}, sort: 2, active: true },
      { id: "a", pattern: "a", action: {}, sort: 1, active: false },
      { id: "c", pattern: "c", action: {}, sort: 0, active: false, archived: true },
    ];
    expect(shownRules(rules).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("only owners and admins manage rules", () => {
    expect(canManage(config("owner"))).toBe(true);
    expect(canManage(config("admin"))).toBe(true);
    expect(canManage(config("member"))).toBe(false);
  });
});
