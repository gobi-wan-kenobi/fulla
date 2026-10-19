// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Recurring items: what the household's rows show repeating, and the ones it
 * has confirmed (fulla.recurring_rules). Written for the web fork from first
 * principles; nothing here writes a transaction.
 *
 * Detection, per merchant (the statement text as cleanMerchant leaves it, so
 * "NETFLIX.COM 866-579" and "NETFLIX.COM 214-…" are one) and per kind (money
 * out, money in):
 *
 *  1. The rows that count: expenses and income, not deleted, not a trip's,
 *     not left out of the household's figures (anything on an investment
 *     account, grants). Transfers, settlements and refunds never repeat as a
 *     charge. Rows on one day are one occurrence.
 *  2. Cadence from the gaps between occurrences: their median names it
 *     (weekly 5–9 days, every two weeks 12–16, monthly 26–35, yearly
 *     350–380; twice a month when the days of the month fall in two steady
 *     groups, such as the 15th and the last, unless every occurrence is on
 *     the same weekday, which is every two weeks). At least three in four gaps
 *     must fit it, where a gap of two or three cycles is one or two missed
 *     occurrences, not a different cadence. Two occurrences need their one
 *     gap to fit. Of several rows on one day, the one nearest the usual
 *     amount is the occurrence.
 *  3. The amount: its median, with a tolerance of 5 % or one and a half times
 *     the median deviation, whichever is larger (at most 30 %). Amounts that
 *     scatter (a spread over a quarter; two occurrences over a third apart,
 *     a tenth for anything more often than monthly) are shopping, not a
 *     recurring charge.
 *  4. A price change: at least three occurrences, all but the last steady
 *     (within 2 %), and the last off by more than that. The typical amount
 *     is then the new one.
 *  5. The dates it falls on, stepping one cycle at a time from the last
 *     occurrence (monthly on its usual day, the month's last day when
 *     shorter). The first of them, measured to the day the records reach, is
 *     due (within a few days of grace), late, or missed (a whole cycle and
 *     nothing). Dates after the records' last day but not after today are
 *     expected, not imported yet: a statement not imported yet is not a
 *     missed payment. The next date is the first after today.
 *  6. One occurrence is suggested only when its row or category says it is a
 *     fixed cost; it is then taken to be monthly.
 *
 * Everything detected is a suggestion. With little history (fewer than three
 * occurrences, or one) it says it needs more months or the person's OK.
 */
import { cleanMerchant, words } from "./categorize";
import { addDays, addMonths, dayOfMonth, daysBetween, daysInMonth, median, weekday } from "./dates";
import { activeMembers, type Category, type Config, type OutsideTotals, type RecurringRule, type Schedule, type Transaction, nothingOutside } from "./model";

export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "yearly";
export const CADENCES: Cadence[] = ["weekly", "biweekly", "semimonthly", "monthly", "yearly"];
export const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30, yearly: 365 };
/** How many times a month each cadence falls, on average. */
export const PER_MONTH: Record<Cadence, number> = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, yearly: 1 / 12 };
const RANGE: Record<Cadence, [number, number]> = { weekly: [5, 9], biweekly: [12, 16], semimonthly: [12, 19], monthly: [26, 35], yearly: [350, 380] };
/** Days after its date an occurrence is still only "due", not late. */
export const GRACE: Record<Cadence, number> = { weekly: 2, biweekly: 3, semimonthly: 3, monthly: 5, yearly: 14 };

export type Evidence = "once" | "few" | "regular" | "confirmed";
/**
 * Where an item stands. due, late and missed only for a date on or before the
 * records' last day; expected for one after it but not after today (not
 * imported yet); upcoming when nothing falls before tomorrow.
 */
export type RecurringState = "upcoming" | "expected" | "due" | "late" | "missed";

export interface Seen { date: string; amountMinor: number; txId: string }

export interface RecurringItem {
  /** kind and merchant, "expense:netflix": how a suggestion is dismissed and a rule found again. */
  key: string;
  kind: "expense" | "income";
  name: string;
  cadence: Cadence;
  /** Monthly: the usual day; twice a month: the two days (31 for the last). */
  anchorDay?: number;
  days?: [number, number];
  typicalMinor: number;
  toleranceMinor: number;
  /** The amount moves from one time to the next (a bill, not a subscription). */
  varies: boolean;
  /** Oldest first. */
  seen: Seen[];
  lastDate: string | null;
  /** The first date after today it falls on. */
  nextDate: string;
  /** The first date after the last occurrence: what due, late and missed are about. */
  dueDate: string;
  /** Dates after the records' last day, on or before today: expected, not imported yet. */
  expected: string[];
  /** The dates after today in the next two months (nextDate first). */
  upcoming: string[];
  state: RecurringState;
  /** Days past nextDate (and its grace) as of the records' last day; 0 when upcoming or due. */
  overdueDays: number;
  /** Occurrences the history skipped (a gap of two cycles is one). */
  skipped: number;
  priceChange: { fromMinor: number; toMinor: number; date: string } | null;
  evidence: Evidence;
  confirmed: boolean;
  ruleIds: string[];
  categoryId: string | null;
  /** The row a confirmed rule is made from: the latest occurrence. */
  latest: Transaction | null;
  /** typicalMinor as a monthly amount. */
  monthlyMinor: number;
}

/** A suggestion's key: its kind and the merchant as the statement text cleans up to; "" when there is no name. */
export function recurringKey(kind: string, note: string): string {
  const m = words(cleanMerchant(note || ""));
  return m ? `${kind}:${m}`.slice(0, 120) : "";
}

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** One cycle on (or back, by -1) from date. */
export function stepCadence(c: Cadence, date: string, by: 1 | -1 = 1, anchor: { day?: number; days?: [number, number] } = {}): string {
  switch (c) {
    case "weekly": return addDays(date, 7 * by);
    case "biweekly": return addDays(date, 14 * by);
    case "monthly": return addMonths(date, by, anchor.day ?? dayOfMonth(date));
    case "yearly": return addMonths(date, 12 * by, anchor.day ?? dayOfMonth(date));
    case "semimonthly": {
      const [a, b] = anchor.days ?? [15, 31];
      const d = dayOfMonth(date);
      const [y, m] = date.split("-").map(Number);
      const late = Math.min(b, daysInMonth(y, m));
      if (by === 1) return d < late && d < b - 3 ? addMonths(date, 0, b) : addMonths(date, 1, a);
      return d > a + 3 ? addMonths(date, 0, a) : addMonths(date, -1, b);
    }
  }
}

type Timing = Pick<RecurringItem, "nextDate" | "dueDate" | "expected" | "upcoming" | "state" | "overdueDays">;

/**
 * Where an item stands, from the first date after its last occurrence and a
 * step to the one after: late or missed only as of the records' last day
 * (through); between that and today, expected; next, the first after today.
 */
function timing(c: Cadence, first: string, step: (d: string) => string | null, through: string, today: string): Timing {
  const end = today < through ? through : today;
  let state: RecurringState = "upcoming";
  let overdueDays = 0;
  if (first <= through) {
    const over = daysBetween(first, through);
    if (over <= GRACE[c]) state = "due";
    else { state = over >= CADENCE_DAYS[c] ? "missed" : "late"; overdueDays = over; }
  } else if (first <= end) state = "expected";
  const expected: string[] = [];
  const upcoming: string[] = [];
  const horizon = addMonths(end, 2);
  let d: string | null = first;
  for (let i = 0; d && i < 400 && (d <= end || (d <= horizon && upcoming.length < 10) || upcoming.length === 0); i++) {
    if (d > end) upcoming.push(d);
    else if (d > through) expected.push(d);
    const n = step(d);
    d = n && n > d ? n : null;
  }
  return { nextDate: upcoming[0] ?? first, dueDate: first, expected, upcoming, state, overdueDays };
}

/**
 * Days of the month in two steady groups (such as the 1st and the 16th, or
 * the 15th and the last), or null. End-of-month days count as 31. The groups
 * split at the widest gap between the days seen; each must hold within four
 * days, and their middles be 10 to 20 days apart.
 */
function twoGroups(dates: string[]): [number, number] | null {
  const ds = dates.map((d) => {
    const [y, m] = d.split("-").map(Number);
    const n = dayOfMonth(d);
    return n >= daysInMonth(y, m) - 1 ? 31 : n;
  }).sort((a, b) => a - b);
  let cut = -1;
  let widest = 0;
  for (let i = 1; i < ds.length; i++) if (ds[i] - ds[i - 1] > widest) { widest = ds[i] - ds[i - 1]; cut = i; }
  if (cut < 0) return null;
  const early = ds.slice(0, cut);
  const late = ds.slice(cut);
  if (early[early.length - 1] - early[0] > 4 || late[late.length - 1] - late[0] > 4) return null;
  const a = Math.round(median(early));
  const b = Math.round(median(late));
  return b - a >= 10 && b - a <= 20 ? [a, b] : null;
}

function classify(dates: string[]): { cadence: Cadence; skipped: number; days?: [number, number] } | null {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const m = median(gaps);
  const fits = (c: Cadence) => {
    const [lo, hi] = RANGE[c];
    let ok = 0;
    let skipped = 0;
    for (const g of gaps) {
      if (g >= lo && g <= hi) ok++;
      else if (gaps.length > 1 && [2, 3].some((k) => g >= lo * k && g <= hi * k)) { ok++; skipped += Math.round(g / CADENCE_DAYS[c]) - 1; }
    }
    return ok >= Math.ceil(gaps.length * 0.75) ? skipped : null;
  };
  if (m >= 12 && m <= 19) {
    const sameDay = new Set(dates.map(weekday)).size === 1;
    const groups = twoGroups(dates);
    if (!(sameDay && m <= 16) && groups) {
      const s = fits("semimonthly");
      if (s !== null) return { cadence: "semimonthly", skipped: s, days: groups };
    }
  }
  for (const c of ["weekly", "biweekly", "monthly", "yearly"] as Cadence[]) {
    const [lo, hi] = RANGE[c];
    if (m < lo || m > hi) continue;
    const s = fits(c);
    if (s !== null) return { cadence: c, skipped: s };
  }
  return null;
}

function toleranceOf(amounts: number[], typical: number): number {
  const med = median(amounts);
  const mad = median(amounts.map((a) => Math.abs(a - med)));
  return Math.max(1, Math.min(Math.round(typical * 0.3), Math.max(Math.ceil(typical * 0.05), Math.round(1.5 * mad))));
}

function priceChangeOf(seen: Seen[]): RecurringItem["priceChange"] {
  if (seen.length < 3) return null;
  const prev = seen.slice(0, -1).map((s) => s.amountMinor);
  const last = seen[seen.length - 1];
  const pm = median(prev);
  const band = Math.max(1, Math.round(pm * 0.02));
  if (prev.some((p) => Math.abs(p - pm) > band)) return null;
  if (Math.abs(last.amountMinor - pm) <= band) return null;
  return { fromMinor: Math.round(pm), toMinor: last.amountMinor, date: last.date };
}

interface Group { key: string; kind: "expense" | "income"; rows: Transaction[] }

/** The rows recurring detection reads, by merchant and kind. */
export function recurringGroups(txs: Transaction[], outside: OutsideTotals = nothingOutside): Group[] {
  const out = new Map<string, Group>();
  for (const t of txs) {
    if (t.status !== "active" || (t.kind !== "expense" && t.kind !== "income") || t.trip_id || outside(t)) continue;
    const key = recurringKey(t.kind, t.note);
    if (!key) continue;
    const g = out.get(key) ?? { key, kind: t.kind, rows: [] };
    g.rows.push(t);
    out.set(key, g);
  }
  return [...out.values()];
}

/**
 * One occurrence a day: of several rows on one day (a charge and something
 * else bought there), the one nearest the merchant's usual amount.
 */
function seenOf(rows: Transaction[]): Seen[] {
  const usual = median(rows.map((t) => t.amount_minor));
  const byDay = new Map<string, Transaction>();
  for (const t of rows) {
    const s = byDay.get(t.date);
    const better = !s || Math.abs(t.amount_minor - usual) < Math.abs(s.amount_minor - usual) || (Math.abs(t.amount_minor - usual) === Math.abs(s.amount_minor - usual) && t.id < s.id);
    if (better) byDay.set(t.date, t);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((t) => ({ date: t.date, amountMinor: t.amount_minor, txId: t.id }));
}

function nameOf(key: string): string {
  return titleCase(key.slice(key.indexOf(":") + 1));
}

/** What one merchant's rows say, or null when they do not repeat. */
export function detect(g: Group, through: string, categories: Category[] = [], today: string = through): RecurringItem | null {
  const seen = seenOf(g.rows);
  if (seen.length === 0) return null;
  const latest = [...g.rows].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const cat = categories.find((c) => c.id === latest.category_id);
  const base = { key: g.key, kind: g.kind, name: nameOf(g.key), seen, lastDate: seen[seen.length - 1].date, confirmed: false, ruleIds: [], categoryId: latest.category_id, latest };
  if (seen.length === 1) {
    if (latest.recurrence !== "fixed" && !cat?.fixed) return null;
    const typical = seen[0].amountMinor;
    const next = stepCadence("monthly", seen[0].date);
    return { ...base, cadence: "monthly", anchorDay: dayOfMonth(seen[0].date), typicalMinor: typical, toleranceMinor: Math.max(1, Math.ceil(typical * 0.05)), varies: false,
      ...timing("monthly", next, (d) => stepCadence("monthly", d, 1, { day: dayOfMonth(seen[0].date) }), through, today), skipped: 0, priceChange: null, evidence: "once", monthlyMinor: typical };
  }
  const shape = classify(seen.map((s) => s.date));
  if (!shape) return null;
  const amounts = seen.slice(-6).map((s) => s.amountMinor);
  const med = median(amounts);
  if (med <= 0) return null;
  const mad = median(amounts.map((a) => Math.abs(a - med)));
  const priceChange = priceChangeOf(seen);
  // Amounts that scatter are shopping, not a charge that comes back: a spread over a quarter, or two that differ by over a
  // third (a tenth for anything more often than monthly: two different amounts a fortnight apart are two purchases).
  const twoApart = seen.length === 2 ? Math.abs(amounts[0] - amounts[1]) / Math.max(amounts[0], amounts[1]) : 0;
  const short = shape.cadence === "weekly" || shape.cadence === "biweekly" || shape.cadence === "semimonthly";
  if (!priceChange && (seen.length === 2 ? twoApart > (short ? 0.1 : 0.35) : mad / med > 0.25)) return null;
  const typical = priceChange ? priceChange.toMinor : Math.round(med);
  const tolerance = toleranceOf(priceChange ? [typical] : amounts, typical);
  const anchorDay = shape.cadence === "monthly" || shape.cadence === "yearly" ? Math.round(median(seen.map((s) => dayOfMonth(s.date)))) : undefined;
  const last = seen[seen.length - 1].date;
  const next = stepCadence(shape.cadence, last, 1, { day: anchorDay, days: shape.days });
  const regular = seen.length >= 3 && daysBetween(seen[0].date, last) >= 2 * CADENCE_DAYS[shape.cadence] - GRACE[shape.cadence];
  return {
    ...base, cadence: shape.cadence, anchorDay, days: shape.days, typicalMinor: typical, toleranceMinor: tolerance, varies: tolerance > typical * 0.1,
    ...timing(shape.cadence, next, (d) => stepCadence(shape.cadence, d, 1, { day: anchorDay, days: shape.days }), through, today), skipped: shape.skipped, priceChange,
    evidence: regular ? "regular" : "few", monthlyMinor: Math.round(typical * PER_MONTH[shape.cadence]),
  };
}

// ── confirmed items (fulla.recurring_rules) ──────────────────────────────────

function mondayOf(date: string): string {
  return addDays(date, 1 - weekday(date));
}

/** The first day after `after` a rule falls due on, or null (Scheduler.occurrences' calendar). */
export function nextOccurrence(rule: RecurringRule, after: string): string | null {
  const s = rule.schedule;
  const interval = Math.max(1, s.interval ?? 1);
  const from = addDays(after, 1) > rule.start_date ? addDays(after, 1) : rule.start_date;
  const ok = (d: string) => !rule.end_date || d <= rule.end_date;
  if (s.freq === "daily") {
    const k = Math.max(0, Math.ceil(daysBetween(rule.start_date, from) / interval));
    const d = addDays(rule.start_date, k * interval);
    return ok(d) ? d : null;
  }
  if (s.freq === "weekly") {
    const days = s.by_weekday?.length ? s.by_weekday : [weekday(rule.start_date)];
    const week0 = mondayOf(rule.start_date);
    for (let i = 0; i < 7 * interval + 7; i++) {
      const d = addDays(from, i);
      const weeks = Math.round(daysBetween(week0, mondayOf(d)) / 7);
      if (weeks % interval === 0 && days.includes(weekday(d))) return ok(d) ? d : null;
    }
    return null;
  }
  const step = s.freq === "monthly" ? interval : 12 * interval;
  const dayIn = (y: number, m: number) => {
    const last = daysInMonth(y, m);
    const want = s.by_month_day ?? dayOfMonth(rule.start_date);
    return `${y}-${String(m).padStart(2, "0")}-${String(want === -1 || want > last ? last : want).padStart(2, "0")}`;
  };
  let [y, m] = rule.start_date.split("-").map(Number);
  if (s.freq === "yearly") {
    m = s.by_month ?? m;
    if (`${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}` < rule.start_date) y++;
  }
  for (let i = 0; i < 1200; i++) {
    const d = dayIn(y, m);
    const inCalendar = !s.by_months?.length || s.by_months.includes(m);
    if (inCalendar && d >= from && d >= rule.start_date) return ok(d) ? d : null;
    if (rule.end_date && d > rule.end_date) return null;
    m += step;
    while (m > 12) { m -= 12; y++; }
  }
  return null;
}

/** A schedule as a cadence, when it is one the detector names. */
export function cadenceOf(rules: RecurringRule[]): Cadence | null {
  const s = rules[0]?.schedule;
  if (!s) return null;
  if (rules.length === 2 && rules.every((r) => r.schedule.freq === "monthly")) return "semimonthly";
  if (s.freq === "weekly") return (s.interval ?? 1) === 1 ? "weekly" : (s.interval ?? 1) === 2 ? "biweekly" : null;
  if (s.freq === "monthly" && (s.interval ?? 1) === 1 && !s.by_months?.length) return "monthly";
  if (s.freq === "yearly" && (s.interval ?? 1) === 1) return "yearly";
  return null;
}

/** A confirmed item: the rule(s) of one key, and the rows that look like them. */
function confirmedItem(key: string, rules: RecurringRule[], g: Group | undefined, through: string, today: string): RecurringItem {
  const r = rules[0];
  const kind = r.template.kind === "income" ? "income" : "expense";
  const ids = new Set(rules.map((x) => x.id));
  const rows = [...(g?.rows ?? [])];
  const seen = seenOf(rows.filter((t) => !t.recurring_rule_id || ids.has(t.recurring_rule_id)));
  const cadence = cadenceOf(rules) ?? "monthly";
  const lastDate = seen.length ? seen[seen.length - 1].date : null;
  const after = lastDate ?? addDays(r.start_date, -1);
  const nexts = rules.map((x) => nextOccurrence(x, after)).filter((d): d is string => !!d).sort();
  const next = nexts[0] ?? r.start_date;
  const typical = rules.length === 2 ? Math.round((rules[0].template.amount_minor + rules[1].template.amount_minor) / 2) : r.template.amount_minor;
  const tolerance = toleranceOf(seen.slice(-6).map((s) => s.amountMinor).concat(typical), typical);
  const last = seen[seen.length - 1];
  const priceChange = last && Math.abs(last.amountMinor - typical) > Math.max(1, Math.round(typical * 0.02)) && Math.abs(last.amountMinor - typical) > tolerance
    ? { fromMinor: typical, toMinor: last.amountMinor, date: last.date } : null;
  const latest = rows.sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
  const perMonth = cadenceOf(rules) ? PER_MONTH[cadence] : rules.reduce((n, x) => n + perMonthOf(x.schedule), 0);
  return {
    key, kind, name: r.name, cadence,
    anchorDay: r.schedule.by_month_day ? monthDay(r) : undefined, days: rules.length === 2 ? [monthDay(rules[0]), monthDay(rules[1])].sort((a, b) => a - b) as [number, number] : undefined,
    typicalMinor: typical, toleranceMinor: tolerance, varies: tolerance > typical * 0.1, seen, lastDate,
    ...timing(cadence, next, (d) => rules.map((x) => nextOccurrence(x, d)).filter((x): x is string => !!x).sort()[0] ?? null, through, today),
    skipped: 0, priceChange, evidence: "confirmed", confirmed: true,
    ruleIds: rules.map((x) => x.id), categoryId: r.template.category_id ?? null, latest,
    monthlyMinor: Math.round(cadenceOf(rules) ? typical * perMonth : rules.reduce((n, x) => n + x.template.amount_minor * perMonthOf(x.schedule), 0)),
  };
}

function perMonthOf(s: Schedule): number {
  const n = Math.max(1, s.interval ?? 1);
  if (s.freq === "daily") return 365 / 12 / n;
  if (s.freq === "weekly") return ((s.by_weekday?.length || 1) * 52) / 12 / n;
  if (s.freq === "monthly") return s.by_months?.length ? s.by_months.length / 12 : 1 / n;
  return 1 / 12 / n;
}

/** A rule's day of the month, the last day (-1) as 31. */
function monthDay(r: RecurringRule): number {
  const d = r.schedule.by_month_day ?? 0;
  return d === -1 ? 31 : d;
}

export function ruleKey(r: RecurringRule): string {
  return recurringKey(r.template.kind, r.template.note || r.name) || recurringKey(r.template.kind, r.name);
}

export interface RecurringView {
  confirmed: RecurringItem[];
  suggested: RecurringItem[];
  /** Confirmed money out, as a monthly amount. */
  committedMinor: number;
  /** What the suggestions would add, as a monthly amount. */
  suggestedMinor: number;
  /** The last day the records reach (never after today): what "late" and "missed" are measured to. */
  through: string;
  today: string;
}

/** The household's recurring items: the confirmed ones, then what else repeats, as suggestions (dismissed ones left out). */
export function recurringView(txs: Transaction[], config: Pick<Config, "recurring_rules" | "categories">, today: string, outside: OutsideTotals = nothingOutside, dismissed: string[] = []): RecurringView {
  const active = txs.filter((t) => t.status === "active");
  const last = active.reduce((m, t) => (t.date > m ? t.date : m), "");
  const through = last && last < today ? last : today;
  const groups = new Map(recurringGroups(active, outside).map((g) => [g.key, g]));
  const byKey = new Map<string, RecurringRule[]>();
  for (const r of config.recurring_rules ?? []) {
    if (r.archived || !r.active) continue;
    const k = ruleKey(r);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), r].sort((a, b) => monthDay(a) - monthDay(b)));
  }
  const confirmed = [...byKey.entries()].map(([k, rules]) => confirmedItem(k, rules, groups.get(k), through, today));
  const skip = new Set([...byKey.keys(), ...dismissed]);
  const suggested = [...groups.values()].filter((g) => !skip.has(g.key))
    .map((g) => detect(g, through, config.categories, today)).filter((x): x is RecurringItem => !!x);
  const order = (a: RecurringItem, b: RecurringItem) => b.monthlyMinor - a.monthlyMinor || (a.key < b.key ? -1 : 1);
  confirmed.sort(order);
  suggested.sort(order);
  const out = (xs: RecurringItem[]) => xs.filter((x) => x.kind === "expense").reduce((n, x) => n + x.monthlyMinor, 0);
  return { confirmed, suggested, committedMinor: out(confirmed), suggestedMinor: out(suggested), through, today };
}

/**
 * Confirmed or suggested money out still to come in from..to: only dates
 * after today (one expected but not imported yet has, most likely, gone out
 * already), each time it falls (a weekly item four or five times a month).
 */
export function stillToCome(view: RecurringView, from: string, to: string): { items: RecurringItem[]; count: number; totalMinor: number; confirmedMinor: number } {
  const times = (x: RecurringItem) => x.upcoming.filter((d) => d > view.today && d >= from && d <= to).length;
  const items = [...view.confirmed, ...view.suggested].filter((x) => x.kind === "expense" && times(x) > 0);
  const sum = (xs: RecurringItem[]) => xs.reduce((n, x) => n + times(x) * x.typicalMinor, 0);
  return { items, count: items.reduce((n, x) => n + times(x), 0), totalMinor: sum(items), confirmedMinor: sum(items.filter((x) => x.confirmed)) };
}

// ── confirming ───────────────────────────────────────────────────────────────

export interface RecurringEdit {
  name: string;
  amountMinor: number;
  cadence: Cadence;
  /** The next day it falls due: the schedule is drawn from it. */
  nextDate: string;
  categoryId: string | null;
  /** Twice a month: the other day of the month (1–31; 31 is the last). */
  otherDay?: number;
}

export function editFor(item: RecurringItem): RecurringEdit {
  const other = item.days ? (dayOfMonth(item.nextDate) <= 16 ? item.days[1] : item.days[0]) : undefined;
  return { name: item.name.slice(0, 60), amountMinor: item.typicalMinor, cadence: item.cadence, nextDate: item.nextDate, categoryId: item.categoryId, otherDay: other };
}

/** Why the edit cannot be saved, or null. */
export function editProblem(e: RecurringEdit): string | null {
  if (!e.name.trim()) return "Give it a name";
  if (!(e.amountMinor > 0)) return "Type an amount";
  if (!e.categoryId) return "Choose a category";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.nextDate)) return "Choose the next date";
  if (e.cadence === "semimonthly" && !(e.otherDay && e.otherDay >= 1 && e.otherDay <= 31)) return "Choose the other day of the month";
  return null;
}

function scheduleFor(c: Exclude<Cadence, "semimonthly">, next: string): Schedule {
  const [, m] = next.split("-").map(Number);
  switch (c) {
    case "weekly": return { freq: "weekly", interval: 1, by_weekday: [weekday(next)] };
    case "biweekly": return { freq: "weekly", interval: 2, by_weekday: [weekday(next)] };
    case "monthly": return { freq: "monthly", interval: 1, by_month_day: dayOfMonth(next) };
    case "yearly": return { freq: "yearly", interval: 1, by_month_day: dayOfMonth(next), by_month: m };
  }
}

/**
 * The rule(s) to save for a confirmed or edited item: one, or two monthly ones
 * for twice a month. Starts on the next date, so nothing already recorded is
 * an occurrence; auto_create is off, so the phones never write one either.
 * Rules the item had and no longer needs come back archived.
 */
export function rulesFor(item: RecurringItem, e: RecurringEdit, config: Pick<Config, "members" | "me_member_id" | "recurring_rules">, newId: () => string): RecurringRule[] {
  const t = item.latest;
  const members = activeMembers(config as Config);
  const expense = item.kind === "expense";
  const payer = t?.paid_by_member_id ?? (expense ? config.me_member_id ?? members[0]?.id ?? null : null);
  const template: RecurringRule["template"] = {
    kind: item.kind, amount_minor: e.amountMinor, category_id: e.categoryId, account_id: t?.account_id ?? null, to_account_id: null,
    paid_by_member_id: payer, to_member_id: null,
    split: expense && members.length >= 2 ? (t?.split ?? { mode: "equal", members: members.map((m) => m.id) }) : null,
    recurrence: "fixed", note: (t?.note || e.name).slice(0, 500), tags: [], extras: {}, trip_id: null,
  };
  const existing = (config.recurring_rules ?? []).filter((r) => item.ruleIds.includes(r.id));
  const base = (i: number, schedule: Schedule, start: string): RecurringRule => ({
    id: existing[i]?.id ?? newId(), name: e.name.trim().slice(0, 60), template, schedule, start_date: start, end_date: null, auto_create: false, active: true, archived: false,
  });
  let out: RecurringRule[];
  if (e.cadence === "semimonthly") {
    const day = dayOfMonth(e.nextDate);
    const other = e.otherDay!;
    const otherNext = other > day ? addMonths(e.nextDate, 0, other) : addMonths(e.nextDate, 1, other);
    const pair = [{ d: day, next: e.nextDate }, { d: other, next: otherNext }].sort((a, b) => a.d - b.d);
    out = pair.map((p, i) => base(i, { freq: "monthly", interval: 1, by_month_day: p.d >= 31 ? -1 : p.d }, p.next));
  } else {
    out = [base(0, scheduleFor(e.cadence, e.nextDate), e.nextDate)];
  }
  const stale = existing.filter((r) => !out.some((o) => o.id === r.id)).map((r) => ({ ...r, active: false, archived: true }));
  return [...out, ...stale];
}

/** Stopping a confirmed item: its rules archived (what they wrote, if anything, stays). */
export function archived(item: RecurringItem, config: Pick<Config, "recurring_rules">): RecurringRule[] {
  return (config.recurring_rules ?? []).filter((r) => item.ruleIds.includes(r.id)).map((r) => ({ ...r, active: false, archived: true }));
}

export function withRules(rules: RecurringRule[], saved: RecurringRule[]): RecurringRule[] {
  const ids = new Set(saved.map((r) => r.id));
  return [...rules.filter((r) => !ids.has(r.id)), ...saved];
}
