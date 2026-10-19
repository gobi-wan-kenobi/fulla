// SPDX-License-Identifier: GPL-3.0-or-later
// Recurring items and payday: what repeats (cadence, usual amount and
// tolerance, next date, late or missed, a new price), what was confirmed,
// and the rules a confirmation saves. Every amount and name here is invented.
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { type Account, type Category, type Config, type Member, type RecurringRule, type Transaction, outsideTotals } from "@/lib/model";
import { payPeriodOf, payday, paydays, paydaysFrom } from "@/lib/period";
import { archived, detect, editFor, editProblem, nextOccurrence, recurringGroups, recurringKey, recurringView, rulesFor, stepCadence, stillToCome } from "@/lib/recurring";
import { category } from "./support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ANA = id(1);
const BEN = id(2);
const SUBS = category(id(901), "Subscriptions", "expense", { fixed: true });
const FOOD = category(id(902), "Groceries", "expense");
const PAY = category(id(903), "Salary", "income");
const INTEREST = category(id(904), "Interest", "income");
const GRANT = category(id(905), "Government grants", "income", { excluded_from_income: true });
const RENT = category(id(906), "Rent", "expense", { fixed: true });
const CATS: Category[] = [SUBS, FOOD, PAY, INTEREST, GRANT, RENT];
const CHQ: Account = { id: id(801), name: "Chequing", type: "checking", opening_balance_minor: 0, sort: 1, archived: false };
const TFSA: Account = { id: id(802), name: "TFSA", type: "investment", opening_balance_minor: 0, sort: 2, archived: false };
const OUT = outsideTotals(CATS, [CHQ, TFSA]);

let n = 1;
function tx(date: string, kind: Transaction["kind"], amount: number, note: string, cat: Category | null, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: id(5000 + n++), kind, date, amount_minor: amount, category_id: cat?.id ?? null, account_id: CHQ.id, to_account_id: null,
    paid_by_member_id: kind === "expense" ? ANA : null, to_member_id: null, split: null, recurrence: "variable", note, tags: [], extras: {},
    status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null, created_at: "", client_updated_at: "", ...extra,
  };
}
const member = (mid: string, name: string): Member => ({ id: mid, display_name: name, initials: name[0], color_index: 0, role: "owner", status: "active", has_account: true });
const cfg = (rules: RecurringRule[] = [], members = [member(ANA, "Ana")]) => ({ recurring_rules: rules, categories: CATS, members, me_member_id: ANA } as unknown as Config);
const months = (from: string, count: number, f: (d: string, i: number) => Transaction) => Array.from({ length: count }, (_, i) => f(addMonthsLocal(from, i), i));
function addMonthsLocal(date: string, by: number) {
  let d = date;
  for (let i = 0; i < by; i++) d = stepCadence("monthly", d, 1, { day: Number(date.slice(8)) });
  return d;
}
const one = (rows: Transaction[], through = "2030-06-30") => {
  const groups = recurringGroups(rows, OUT);
  expect(groups).toHaveLength(1);
  return detect(groups[0], through, CATS);
};

describe("detecting what repeats", () => {
  it("a monthly subscription: cadence, usual amount, next date, regular", () => {
    const rows = months("2030-01-15", 5, (d) => tx(d, "expense", 1649, `STREAMCO.COM ${d.replace(/-/g, "")} ON`, SUBS));
    const x = one(rows, "2030-05-31")!;
    expect(x).toMatchObject({ key: "expense:streamco", cadence: "monthly", typicalMinor: 1649, varies: false, lastDate: "2030-05-15", nextDate: "2030-06-15",
      state: "upcoming", evidence: "regular", priceChange: null, skipped: 0, monthlyMinor: 1649 });
    expect(x.toleranceMinor).toBe(Math.ceil(1649 * 0.05));
  });

  it("a new price: steady, then one more", () => {
    const rows = [1649, 1649, 1649, 1899].map((a, i) => tx(addMonthsLocal("2030-01-03", i), "expense", a, "STREAMCO", SUBS));
    const x = one(rows)!;
    expect(x.priceChange).toEqual({ fromMinor: 1649, toMinor: 1899, date: "2030-04-03" });
    expect(x.typicalMinor).toBe(1899);
  });

  it("weekly, every two weeks (same weekday), twice a month (1st and 16th) and yearly", () => {
    const weekly = [0, 7, 14, 21, 28].map((d) => tx(addDays("2030-03-02", d), "expense", 1500, "YOGA STUDIO", null));
    expect(one(weekly)).toMatchObject({ cadence: "weekly", nextDate: "2030-04-06", monthlyMinor: Math.round((1500 * 52) / 12) });
    const fortnight = [0, 14, 28, 42].map((d) => tx(addDays("2030-03-01", d), "income", 210000, "ACME PAYROLL", PAY));
    expect(one(fortnight)).toMatchObject({ cadence: "biweekly", nextDate: "2030-04-26" });
    const twice = ["2030-03-01", "2030-03-16", "2030-04-01", "2030-04-16"].map((d) => tx(d, "expense", 27500, "CITY CONDO FEES", RENT));
    expect(one(twice)).toMatchObject({ cadence: "semimonthly", days: [1, 16], nextDate: "2030-05-01", monthlyMinor: 55000 });
    const lastDay = ["2030-01-15", "2030-01-31", "2030-02-15", "2030-02-28", "2030-03-15"].map((d) => tx(d, "income", 180000, "EMPLOYER DEP", PAY));
    expect(one(lastDay)).toMatchObject({ cadence: "semimonthly", days: [15, 31], nextDate: "2030-03-31" });
    const yearly = ["2027-05-10", "2028-05-11", "2029-05-10"].map((d) => tx(d, "expense", 12000, "DOMAIN RENEWAL", SUBS));
    expect(one(yearly)).toMatchObject({ cadence: "yearly", nextDate: "2030-05-10" });
  });

  it("shopping is not recurring: scattered amounts, or no steady gaps", () => {
    const groceries = [0, 6, 7, 15, 19, 27].map((d, i) => tx(addDays("2030-03-01", d), "expense", [8432, 2310, 11950, 4600, 1999, 7300][i], "FRESH MARKET", FOOD));
    expect(one(groceries)).toBeNull();
    const twoBuys = [tx("2030-03-05", "expense", 3150, "HARDWARE", null), tx("2030-03-20", "expense", 4094, "HARDWARE", null)];
    expect(one(twoBuys)).toBeNull();
    const sameAmountAnyDay = ["2030-03-01", "2030-03-02", "2030-03-03", "2030-03-24", "2030-03-25"].map((d) => tx(d, "expense", 1700, "PARKING", null));
    expect(one(sameAmountAnyDay)).toBeNull();
  });

  it("a skipped month is one missed occurrence, not another cadence; several rows on a day are one occurrence", () => {
    const rows = ["2030-01-08", "2030-02-08", "2030-04-08", "2030-05-08"].map((d) => tx(d, "expense", 4500, "PHONECO", SUBS));
    rows.push(tx("2030-05-08", "expense", 899, "PHONECO", SUBS));
    const x = one(rows)!;
    expect(x).toMatchObject({ cadence: "monthly", skipped: 1, typicalMinor: 4500 });
    expect(x.seen).toHaveLength(4);
  });

  it("late and missed are measured to the records' last day, not to today", () => {
    const rows = months("2030-01-10", 3, (d) => tx(d, "expense", 8000, "GYM", SUBS));
    expect(one(rows, "2030-04-12")).toMatchObject({ nextDate: "2030-04-10", state: "due" });
    expect(one(rows, "2030-04-20")).toMatchObject({ state: "late", overdueDays: 10 });
    expect(one(rows, "2030-05-15")).toMatchObject({ state: "missed" });
    const view = recurringView([...rows, tx("2030-04-01", "expense", 1200, "LUNCH", FOOD)], cfg(), "2030-10-18", OUT);
    expect(view.through).toBe("2030-04-01");
    expect(view.suggested[0].state).toBe("upcoming");
  });

  it("seen once: suggested only when it is a fixed cost, as monthly, and saying so", () => {
    expect(one([tx("2030-03-03", "expense", 185000, "LANDLORD", RENT)])).toMatchObject({ cadence: "monthly", evidence: "once", nextDate: "2030-04-03" });
    expect(one([tx("2030-03-03", "expense", 5000, "PIZZA PLACE", FOOD)])).toBeNull();
    expect(one([tx("2030-03-03", "expense", 5000, "MUSIC APP", FOOD, { recurrence: "fixed" })])).toMatchObject({ evidence: "once" });
    expect(one(months("2030-01-03", 2, (d) => tx(d, "expense", 2000, "CLOUD", SUBS)))).toMatchObject({ evidence: "few" });
  });

  it("leaves out what the household's figures leave out: investment accounts, grants, transfers, refunds, trips", () => {
    const rows = [
      ...months("2030-01-05", 3, (d) => tx(d, "expense", 999, "BROKER FEE", SUBS, { account_id: TFSA.id })),
      ...months("2030-01-20", 3, (d) => tx(d, "income", 50000, "CESG", GRANT)),
      ...months("2030-01-01", 3, (d) => tx(d, "transfer", 100000, "TO SAVINGS", null)),
      ...months("2030-01-02", 3, (d) => tx(d, "refund", 500, "CASHBACK", SUBS)),
      ...months("2030-01-07", 3, (d) => tx(d, "expense", 3000, "HOTEL", null, { trip_id: id(77) })),
      ...months("2030-01-09", 3, (d) => tx(d, "expense", 1500, "DELETED", SUBS, { status: "deleted" })),
    ];
    expect(recurringGroups(rows, OUT)).toEqual([]);
    expect(recurringKey("expense", "")).toBe("");
  });
});

describe("confirmed items, dismissed ones, and the totals", () => {
  const stream = months("2030-01-15", 4, (d) => tx(d, "expense", 1649, "STREAMCO", SUBS));
  const yoga = [0, 7, 14, 21].map((d) => tx(addDays("2030-04-06", d), "expense", 1500, "YOGA STUDIO", null));

  it("a confirmation saves one tracked rule: never auto_create, starting on the next date, from the latest row", () => {
    const x = recurringView(stream, cfg(), "2030-04-30", OUT).suggested[0];
    const e = editFor(x);
    expect(editProblem(e)).toBeNull();
    const [r, ...rest] = rulesFor(x, e, cfg(), () => id(700));
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ id: id(700), name: "Streamco", auto_create: false, active: true, archived: false, start_date: "2030-05-15",
      schedule: { freq: "monthly", interval: 1, by_month_day: 15 } });
    expect(r.template).toMatchObject({ kind: "expense", amount_minor: 1649, category_id: SUBS.id, account_id: CHQ.id, paid_by_member_id: ANA, split: null, recurrence: "fixed", note: "STREAMCO" });
    expect(nextOccurrence(r, "2030-04-15")).toBe("2030-05-15");
    // With two people a split is needed (validate_transaction).
    const two = rulesFor(x, e, cfg([], [member(ANA, "Ana"), member(BEN, "Ben")]), () => id(701))[0];
    expect(two.template.split).toEqual({ mode: "equal", members: [ANA, BEN] });
  });

  it("once confirmed it is not suggested again; its next date comes from the schedule, and a new price shows", () => {
    const rule: RecurringRule = { id: id(700), name: "StreamCo Premium", template: { kind: "expense", amount_minor: 1649, note: "STREAMCO", category_id: SUBS.id },
      schedule: { freq: "monthly", interval: 1, by_month_day: 15 }, start_date: "2030-05-15", end_date: null, auto_create: false, active: true, archived: false };
    const rows = [...stream, tx("2030-05-15", "expense", 1899, "STREAMCO", SUBS)];
    const v = recurringView(rows, cfg([rule]), "2030-05-31", OUT);
    expect(v.suggested).toEqual([]);
    expect(v.confirmed).toHaveLength(1);
    expect(v.confirmed[0]).toMatchObject({ name: "StreamCo Premium", confirmed: true, evidence: "confirmed", nextDate: "2030-06-15", ruleIds: [id(700)],
      priceChange: { fromMinor: 1649, toMinor: 1899, date: "2030-05-15" } });
    expect(v.committedMinor).toBe(1649);
    // Stopped: archived, and suggested again unless dismissed.
    const [stopped] = archived(v.confirmed[0], cfg([rule]));
    expect(stopped).toMatchObject({ id: id(700), active: false, archived: true });
    expect(recurringView(rows, cfg([stopped]), "2030-05-31", OUT, ["expense:streamco"]).suggested).toEqual([]);
  });

  it("dismissed suggestions stay away; committed and suggested monthly totals; what is still to come", () => {
    const v = recurringView([...stream, ...yoga], cfg(), "2030-04-28", OUT);
    expect(v.suggested.map((x) => x.key)).toEqual(["expense:yoga studio", "expense:streamco"]);
    expect(v.suggestedMinor).toBe(Math.round((1500 * 52) / 12) + 1649);
    expect(v.committedMinor).toBe(0);
    expect(recurringView([...stream, ...yoga], cfg(), "2030-04-28", OUT, ["expense:yoga studio"]).suggested.map((x) => x.key)).toEqual(["expense:streamco"]);
    const left = stillToCome(v, "2030-04-28", "2030-04-30");
    expect(left.items.map((x) => x.key)).toEqual([]);
    const may = stillToCome(v, "2030-05-01", "2030-05-31");
    expect(may.items.map((x) => x.key).sort()).toEqual(["expense:streamco", "expense:yoga studio"]);
    expect(may.confirmedMinor).toBe(0);
  });

  it("every two weeks and twice a month become schedules the database takes; an edit keeps the ids and archives what is left over", () => {
    const pay = [0, 14, 28].map((d) => tx(addDays("2030-03-06", d), "income", 210000, "ACME PAYROLL", PAY));
    const x = recurringView(pay, cfg(), "2030-04-05", OUT).suggested[0];
    const [r] = rulesFor(x, editFor(x), cfg(), () => id(710));
    expect(r.schedule).toEqual({ freq: "weekly", interval: 2, by_weekday: [3] });
    expect(r.template).toMatchObject({ kind: "income", paid_by_member_id: null, split: null });
    expect(nextOccurrence(r, "2030-04-03")).toBe("2030-04-17");
    expect(nextOccurrence(r, "2030-04-17")).toBe("2030-05-01");
    let k = 720;
    const twice = rulesFor({ ...x, ruleIds: [] }, { ...editFor(x), cadence: "semimonthly", nextDate: "2030-04-15", otherDay: 31 }, cfg(), () => id(k++));
    expect(twice.map((t) => [t.id, t.schedule.by_month_day, t.start_date])).toEqual([[id(720), 15, "2030-04-15"], [id(721), -1, "2030-04-30"]]);
    const confirmed = recurringView(pay, cfg(twice), "2030-04-05", OUT).confirmed[0];
    expect(confirmed).toMatchObject({ cadence: "semimonthly", nextDate: "2030-04-15", ruleIds: [id(720), id(721)] });
    const back = rulesFor(confirmed, { ...editFor(confirmed), cadence: "monthly" }, cfg(twice), () => id(799));
    expect(back.map((t) => [t.id, t.archived])).toEqual([[id(720), false], [id(721), true]]);
    expect(editProblem({ ...editFor(confirmed), categoryId: null })).toBe("Choose a category");
  });
});

describe("payday", () => {
  const salary = [0, 14, 28, 42].map((d) => tx(addDays("2030-03-06", d), "income", 210000, "ACME PAYROLL", PAY));
  const interest = months("2030-01-28", 3, (d) => tx(d, "income", 412, "SAVINGS INTEREST", INTEREST));
  const grant = months("2030-01-20", 3, (d) => tx(d, "income", 50000, "CESG", GRANT));

  it("the pay that brings the most, not interest, never a grant; the next paydays and the pay period", () => {
    const v = recurringView([...salary, ...interest, ...grant], cfg(), "2030-04-20", OUT);
    expect(paydays(v).map((p) => p.key)).toEqual(["income:acme payroll"]);
    const p = payday(v)!;
    expect(p).toMatchObject({ cadence: "biweekly", typicalMinor: 210000, lastDate: "2030-04-17", nextDate: "2030-05-01", confirmed: false, evidence: "regular", count: 4 });
    expect(paydaysFrom(p, "2030-04-20", 3)).toEqual(["2030-05-01", "2030-05-15", "2030-05-29"]);
    expect(paydaysFrom(p, "2030-03-01", 2)).toEqual(["2030-03-06", "2030-03-20"]);
    expect(payPeriodOf(p, "2030-04-20")).toEqual({ from: "2030-04-17", to: "2030-04-30" });
    expect(payPeriodOf(p, "2030-03-10")).toEqual({ from: "2030-03-06", to: "2030-03-19" });
  });

  it("one month of history: a single fixed pay deposit is a monthly suggestion; none at all is no payday", () => {
    const once = recurringView([tx("2030-09-14", "income", 546000, "EMPLOYER", PAY, { recurrence: "fixed" })], cfg(), "2030-10-18", OUT);
    expect(payday(once)).toMatchObject({ cadence: "monthly", evidence: "once", nextDate: "2030-10-14" });
    expect(payday(recurringView([], cfg(), "2030-10-18", OUT))).toBeNull();
  });
});
