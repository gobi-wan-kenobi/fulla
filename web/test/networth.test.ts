// SPDX-License-Identifier: GPL-3.0-or-later
// Net worth: the Balances figures, grouped, flagged and over time. Invented data.
import { describe, expect, it } from "vitest";
import { type Account, type Config, type Transaction } from "@/lib/model";
import { balancesView } from "@/lib/balances";
import { STALE_DAYS, groupOf, netWorth } from "@/lib/networth";
import type { BalanceSnapshot } from "@/lib/overview";
import { ALICE, config as base } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const acct = (n: number, name: string, type: Account["type"], extra: Partial<Account> = {}): Account =>
  ({ id: id(n), name, type, opening_balance_minor: 0, opening_balance_date: null, sort: n, archived: false, ...extra });
const CHQ = acct(1, "Chequing", "checking");
const SAV = acct(2, "Savings", "savings", { opening_balance_minor: 1000000, opening_balance_date: "2030-01-01" });
const TFSA = acct(3, "TFSA", "investment");
const RESP = acct(4, "Family RESP", "investment");
const CARD = acct(5, "Card", "credit_card");
const OLD = acct(6, "Old card", "credit_card");
const KID = acct(7, "Kid's cash", "other");
const STANDIN = acct(8, "Main account", "checking");
const GONE = acct(9, "Closed", "checking", { archived: true });
const accounts = [CHQ, SAV, TFSA, RESP, CARD, OLD, KID, STANDIN, GONE];
const config = { ...base, accounts, household: { money_mode: null }, budgets: [], recurring_rules: [] } as unknown as Config;

let n = 1;
function tx(date: string, kind: Transaction["kind"], amount: number, account: Account, extra: Partial<Transaction> = {}): Transaction {
  return { id: id(5000 + n++), kind, date, amount_minor: amount, category_id: null, account_id: account.id, to_account_id: null, paid_by_member_id: kind === "expense" ? ALICE : null,
    to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null,
    import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra };
}
const snap = (a: Account, as_of: string, balance_minor: number): BalanceSnapshot => ({ account_id: a.id, as_of, balance_minor });

const snapshots = [snap(CHQ, "2030-09-30", 500000), snap(TFSA, "2030-09-30", 2500000), snap(CARD, "2030-09-20", -120000), snap(OLD, "2030-07-01", -30000), snap(GONE, "2030-09-30", 99999)];
const txs = [
  tx("2030-10-02", "income", 300000, CHQ), tx("2030-10-05", "expense", 20000, CHQ),
  tx("2030-10-10", "transfer", 50000, CHQ, { to_account_id: TFSA.id }),
  tx("2030-10-11", "transfer", 10000, CHQ, { to_account_id: RESP.id }),
  tx("2030-10-01", "expense", 5000, CARD), tx("2030-10-02", "income", 2000, KID),
  tx("2030-10-03", "expense", 777, CHQ, { status: "deleted" }),
];

describe("net worth", () => {
  const nw = netWorth(config, txs, snapshots, "2030-10-18");
  const line = (a: Account) => nw.lines.find((l) => l.account.id === a.id)!;

  it("is the Balances figure of each known account, summed: cards negative, investments at the statement's market value", () => {
    const held = new Map(balancesView(config, txs.filter((t) => t.status === "active"), snapshots, "2030-10-18").accounts.map((l) => [l.account.id, l.balanceMinor]));
    for (const l of nw.lines) expect(l.balanceMinor).toBe(held.get(l.account.id));
    expect(line(CHQ)).toMatchObject({ balanceMinor: 720000, status: "current", basis: "statement", asOf: "2030-09-30", since: 4, counted: true, group: "cash" });
    expect(line(SAV)).toMatchObject({ balanceMinor: 1000000, basis: "opening", asOf: "2030-01-01", status: "current" });
    expect(line(TFSA)).toMatchObject({ balanceMinor: 2550000, group: "investments", since: 1 });
    expect(line(CARD)).toMatchObject({ balanceMinor: -125000, group: "debt" });
    expect(nw.groups.map((g) => [g.group, g.totalMinor])).toEqual([["cash", 1720000], ["investments", 2550000], ["debt", -155000]]);
    expect(nw).toMatchObject({ totalMinor: 4115000, assetsMinor: 4270000, debtsMinor: -155000, known: true });
  });

  it("leaves out what has no starting point (an RESP with no statement, a child's cash), flags it, and hides unused stand-ins", () => {
    expect(line(RESP)).toMatchObject({ status: "missing", counted: false, asOf: null, balanceMinor: 10000 });
    expect(line(KID)).toMatchObject({ status: "missing", counted: false, group: "cash" });
    expect(nw.missing.map((l) => l.account.name)).toEqual(["Family RESP", "Kid's cash"]);
    expect(nw.unused.map((a) => a.name)).toEqual(["Main account"]);
    expect(nw.lines.some((l) => l.account.id === GONE.id)).toBe(false);
    expect(nw.lines.slice(-2).map((l) => l.account.name)).toEqual(["Family RESP", "Kid's cash"]);
  });

  it("flags a statement older than the limit, and still counts it", () => {
    expect(line(OLD)).toMatchObject({ status: "stale", counted: true, ageDays: 109 });
    expect(STALE_DAYS).toBe(45);
    expect(nw.stale.map((l) => l.account.name)).toEqual(["Old card"]);
    expect(netWorth(config, txs, snapshots, "2030-08-10").stale).toEqual([]);
  });

  it("history: each month end, the accounts known by then, as they stood", () => {
    expect(nw.history[0]).toEqual({ date: "2030-01-31", totalMinor: 1000000, accounts: 1 });
    expect(nw.history.find((p) => p.date === "2030-07-31")).toEqual({ date: "2030-07-31", totalMinor: 970000, accounts: 2 });
    expect(nw.history.find((p) => p.date === "2030-09-30")).toEqual({ date: "2030-09-30", totalMinor: 3850000, accounts: 5 });
    expect(nw.history.at(-1)).toEqual({ date: "2030-10-18", totalMinor: 4115000, accounts: 5 });
    expect(nw.history).toHaveLength(10);
  });

  it("with one month of statements: one point; and with none, nothing to show", () => {
    const only = netWorth({ ...config, accounts: [CHQ, CARD, STANDIN] }, [], [snap(CHQ, "2030-09-30", 500000), snap(CARD, "2030-09-20", -120000)], "2030-09-30");
    expect(only.history).toEqual([{ date: "2030-09-30", totalMinor: 380000, accounts: 2 }]);
    const none = netWorth({ ...config, accounts: [CHQ, STANDIN] }, [tx("2030-09-01", "expense", 100, CHQ)], [], "2030-09-30");
    expect(none).toMatchObject({ known: false, totalMinor: 0, history: [] });
    expect(none.missing.map((l) => l.account.name)).toEqual(["Chequing"]);
  });

  it("groups: cards are debt, investment accounts investments, the rest cash", () => {
    expect([CHQ, SAV, TFSA, CARD, KID].map(groupOf)).toEqual(["cash", "cash", "investments", "debt", "cash"]);
  });
});
