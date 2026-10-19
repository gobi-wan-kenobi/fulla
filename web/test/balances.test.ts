// SPDX-License-Identifier: GPL-3.0-or-later
// The Balances screen: who owes whom, the fewest payments that settle it,
// recording one, the shared pot, and what each account holds. The shared
// vectors keep the web, the phones and the database's member_balances in
// step. Every amount and name here is invented.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocate, balancesView, memberBalances, settlementFor, settlementPlan, type MemberBalance } from "@/lib/balances";
import type { Account, Config, Household, Member, Split, Transaction } from "@/lib/model";

const root = join(__dirname, "..", "..");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ANA, BEN, CARA, DEV] = [id(1), id(2), id(3), id(4)];

function member(mid: string, name: string, status: Member["status"] = "active"): Member {
  return { id: mid, display_name: name, initials: name[0], color_index: 0, role: "member", status, has_account: true };
}
const acct = (n: number, type: Account["type"], extra: Partial<Account> = {}): Account =>
  ({ id: id(n), name: `Example ${n}`, type, opening_balance_minor: 0, sort: n, archived: false, ...extra });

function cfg(members: Member[], accounts: Account[], money_mode: Household["money_mode"] = "split"): Config {
  const household = { id: id(99), name: "Example", currency: "CAD", locale: "en-CA", period_start_day: 1, income_shift_day: null, week_start: 1, member_limit: 10, money_mode };
  return { household, me_member_id: members[0]?.id ?? null, members, accounts, categories: [], budgets: [] } as unknown as Config;
}

let n = 1;
function tx(kind: Transaction["kind"], amount: number, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: id(1000 + n++), kind, date: "2030-03-10", amount_minor: amount, category_id: null, account_id: null, to_account_id: null,
    paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "", tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}

describe("shared vectors", () => {
  it("allocate passes allocate.json", () => {
    const v = JSON.parse(readFileSync(join(root, "testdata/vectors/allocate.json"), "utf8"));
    for (const c of v.vectors) expect(allocate(c.input.amount_minor, c.input.split), c.why).toEqual(c.expected);
  });

  it("member balances pass balance.json (the database's member_balances rule)", () => {
    const v = JSON.parse(readFileSync(join(root, "testdata/vectors/balance.json"), "utf8"));
    for (const c of v.vectors) {
      const txs = c.input.transactions.map((t: { kind: Transaction["kind"]; amount_minor: number; paid_by?: string; to_member?: string; split?: Split }) =>
        tx(t.kind, t.amount_minor, { paid_by_member_id: t.paid_by ?? null, to_member_id: t.to_member ?? null, split: t.split ?? null }));
      const got = Object.fromEntries(memberBalances(txs, c.input.members).map((b) => [b.memberId, { paid: b.paidMinor, share: b.shareMinor, balance: b.balanceMinor }]));
      expect(got, c.why).toEqual(c.expected);
    }
  });
});

describe("allocation and balances", () => {
  it("allocation adds up, is within a unit of exact and ignores listing order", () => {
    let seed = 7;
    const rand = (k: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    const ids = Array.from({ length: 10 }, (_, i) => id(i + 1));
    for (let r = 0; r < 500; r++) {
      const members = ids.slice(0, 1 + rand(10));
      const shares = Object.fromEntries(members.map((m) => [m, 1 + rand(5)]));
      const amount = 1 + rand(10_000_000);
      const parts = allocate(amount, { mode: "shares", shares });
      expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(amount);
      const total = Object.values(shares).reduce((a, b) => a + b, 0);
      for (const m of members) expect(Math.abs(parts[m] - (amount * shares[m]) / total)).toBeLessThan(1);
      expect(allocate(amount, { mode: "shares", shares: Object.fromEntries(Object.entries(shares).reverse()) })).toEqual(parts);
    }
  });

  it("balances always add up to zero, and only active rows count", () => {
    const members = [ANA, BEN, CARA];
    const txs = [
      tx("expense", 9000, { paid_by_member_id: ANA, split: { mode: "equal", members } }),
      tx("expense", 1001, { paid_by_member_id: BEN, split: { mode: "shares", shares: { [ANA]: 2, [CARA]: 1 } } }),
      tx("refund", 300, { paid_by_member_id: ANA, split: { mode: "equal", members } }),
      tx("expense", 500, { paid_by_member_id: CARA }), // no split: all the payer's own
      tx("expense", 99999, { paid_by_member_id: ANA, split: { mode: "equal", members }, status: "deleted" }),
      tx("income", 50000, { paid_by_member_id: BEN }),
      tx("transfer", 20000, { paid_by_member_id: BEN, account_id: id(501), to_account_id: id(502) }),
    ];
    const b = memberBalances(txs, members);
    expect(b.reduce((a, x) => a + x.balanceMinor, 0)).toBe(0);
    const of = (m: string) => b.find((x) => x.memberId === m)!.balanceMinor;
    // Ana paid 9000 - 300, her share 3000 - 100 + 667 → 8700 - 3567.
    expect(of(ANA)).toBe(5133);
    expect(of(BEN)).toBe(1001 - 2900);
    expect(of(CARA)).toBe(500 - 2900 - 334 - 500);
  });
});

describe("settlement plan", () => {
  const bal = (m: string, x: number): MemberBalance => ({ memberId: m, paidMinor: Math.max(x, 0), shareMinor: Math.max(-x, 0), balanceMinor: x });

  it("settles everyone in at most n-1 payments, and the same plan whatever the order", () => {
    let seed = 13;
    const rand = (k: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    for (let r = 0; r < 300; r++) {
      const count = 2 + rand(9);
      const raw = Array.from({ length: count - 1 }, () => rand(100_000) - 50_000);
      const balances = raw.map((x, i) => bal(id(i + 1), x)).concat(bal(id(count), -raw.reduce((a, x) => a + x, 0)));
      const plan = settlementPlan(balances);
      expect(plan.length).toBeLessThanOrEqual(count - 1);
      const after = new Map(balances.map((x) => [x.memberId, x.balanceMinor]));
      for (const p of plan) {
        after.set(p.fromMemberId, after.get(p.fromMemberId)! + p.amountMinor);
        after.set(p.toMemberId, after.get(p.toMemberId)! - p.amountMinor);
      }
      expect([...after.values()].every((x) => x === 0)).toBe(true);
      expect(settlementPlan([...balances].reverse())).toEqual(plan);
    }
  });

  it("largest debtor pays largest creditor first; refuses balances that do not add up", () => {
    expect(settlementPlan([bal(ANA, 6000), bal(BEN, -4000), bal(CARA, -2000)])).toEqual([
      { fromMemberId: BEN, toMemberId: ANA, amountMinor: 4000 },
      { fromMemberId: CARA, toMemberId: ANA, amountMinor: 2000 },
    ]);
    expect(settlementPlan([bal(ANA, 0), bal(BEN, 0)])).toEqual([]);
    expect(() => settlementPlan([bal(ANA, 1), bal(BEN, 0)])).toThrow();
  });

  it("recording a payment is a settlement that clears it and touches no account", () => {
    const txs = [tx("expense", 4520 * 2, { paid_by_member_id: ANA, split: { mode: "equal", members: [ANA, BEN] } })];
    const [p] = settlementPlan(memberBalances(txs, [ANA, BEN]));
    expect(p).toEqual({ fromMemberId: BEN, toMemberId: ANA, amountMinor: 4520 });
    const s = settlementFor(p, "2030-03-12", ANA, id(777));
    expect(s).toMatchObject({ id: id(777), kind: "settlement", date: "2030-03-12", amount_minor: 4520, paid_by_member_id: BEN, to_member_id: ANA,
      account_id: null, to_account_id: null, category_id: null, split: null, created_by_member_id: ANA });
    expect(memberBalances([...txs, s], [ANA, BEN]).every((b) => b.balanceMinor === 0)).toBe(true);
  });
});

describe("the Balances view", () => {
  const CHQ = acct(501, "checking", { opening_balance_minor: 100_000, opening_balance_date: "2030-01-01" });
  const CARD = acct(502, "credit_card");
  const TFSA = acct(503, "investment");
  const OLD = acct(504, "savings", { archived: true, opening_balance_minor: 5_000 });
  const accounts = [TFSA, CARD, CHQ, OLD];
  const rows = [
    tx("expense", 6000, { paid_by_member_id: ANA, account_id: CARD.id, split: { mode: "equal", members: [ANA, BEN] } }),
    tx("income", 250_000, { account_id: CHQ.id }),
    tx("transfer", 40_000, { account_id: CHQ.id, to_account_id: CARD.id }),
    tx("expense", 1_000, { paid_by_member_id: ANA, account_id: CHQ.id, date: "2030-04-02" }), // after today
  ];

  it("between two members: who owes whom, the plan, and each open account in order", () => {
    const v = balancesView(cfg([member(ANA, "Ana"), member(BEN, "Ben")], accounts), rows, [], "2030-03-31");
    expect(v.shared).toBe(false);
    expect(v.between!.map((b) => [b.memberId, b.balanceMinor])).toEqual([[ANA, 3000], [BEN, -3000]]);
    expect(v.plan).toEqual([{ fromMemberId: BEN, toMemberId: ANA, amountMinor: 3000 }]);
    expect(v.accounts.map((l) => l.account.id)).toEqual([CHQ.id, CARD.id, TFSA.id]);
    const of = (a: Account) => v.accounts.find((l) => l.account.id === a.id)!;
    expect(of(CHQ)).toMatchObject({ balanceMinor: 100_000 + 250_000 - 40_000, known: true, statementAsOf: null });
    expect(of(CARD)).toMatchObject({ balanceMinor: -6000 + 40_000, known: false });
    expect(v.totalMinor).toBeNull();
  });

  it("a statement balance is where an account counts from", () => {
    const v = balancesView(cfg([member(ANA, "Ana")], accounts), rows, [{ account_id: TFSA.id, as_of: "2030-03-01", balance_minor: 1_234_500 }, { account_id: TFSA.id, as_of: "2030-05-01", balance_minor: 9 }], "2030-03-31");
    expect(v.accounts.find((l) => l.account.id === TFSA.id)).toMatchObject({ balanceMinor: 1_234_500, known: true, statementAsOf: "2030-03-01" });
  });

  it("one person: no one to owe, only the accounts", () => {
    const v = balancesView(cfg([member(ANA, "Ana"), member(BEN, "Ben", "removed")], accounts), [], [], "2030-03-31");
    expect(v.between).toBeNull();
    expect(v.plan).toEqual([]);
    expect(v.accounts).toHaveLength(3);
  });

  it("someone who left still shows while they owe, and not once settled", () => {
    const owing = balancesView(cfg([member(ANA, "Ana"), member(BEN, "Ben"), member(CARA, "Cara", "archived")], accounts),
      [tx("expense", 9000, { paid_by_member_id: ANA, split: { mode: "equal", members: [ANA, BEN, CARA] } })], [], "2030-03-31");
    expect(owing.between!.map((b) => b.memberId)).toEqual([ANA, BEN, CARA]);
    const settled = balancesView(cfg([member(ANA, "Ana"), member(BEN, "Ben"), member(DEV, "Dev", "archived")], accounts), [], [], "2030-03-31");
    expect(settled.between!.map((b) => b.memberId)).toEqual([ANA, BEN]);
    expect(settled.plan).toEqual([]);
  });

  it("in one shared pot nobody owes anybody, old debts stay hidden, and the accounts have a total", () => {
    const v = balancesView(cfg([member(ANA, "Ana"), member(BEN, "Ben")], accounts, "shared"), rows, [], "2030-03-31");
    expect(v.shared).toBe(true);
    expect(v.between).toBeNull();
    expect(v.plan).toEqual([]);
    expect(v.totalMinor).toBe(310_000 + 34_000);
  });

  it("no accounts and no one else: an empty screen", () => {
    const v = balancesView(cfg([member(ANA, "Ana")], []), [], [], "2030-03-31");
    expect(v).toEqual({ shared: false, between: null, plan: [], accounts: [], totalMinor: null });
  });
});
