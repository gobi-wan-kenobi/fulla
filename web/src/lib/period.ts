// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The household's period: for now the calendar month, named YYYY-MM as
 * fulla.budgets stores it. Budgets and their figures ask here, not monthOf,
 * so a later "start on payday" setting (the Android PeriodRule) changes
 * where a period begins and ends in this one place.
 *
 * Payday lives here too, for that setting: the household's main pay (the
 * recurring money in that comes to the most a month, from lib/recurring.ts),
 * its next dates, and the pay period around a day. Nothing uses the pay
 * period for budgets yet.
 *
 * A payday after the records' last day but not after today is expected, not
 * imported yet (most likely paid, the statement not in): it is not the next
 * payday, which is always the first after today. A payday on a weekend is
 * paid the Friday before unless the history shows otherwise (shift, from
 * lib/recurring.ts shiftOf); every date here is already moved.
 */
import { monthOf, shiftMonth } from "./ledger";
import { type WeekendShift, businessDay } from "./dates";
import { type Cadence, type Evidence, type RecurringView, stepCadence } from "./recurring";

export type Period = string;

/** The period a day belongs to. */
export function periodOf(date: string): Period {
  return monthOf(date);
}

/** Its first and last day, both included. */
export function periodBounds(period: Period): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

export function shiftPeriod(period: Period, by: number): Period {
  return shiftMonth(period, by);
}

// ── payday ───────────────────────────────────────────────────────────────────

export interface Payday {
  key: string;
  name: string;
  cadence: Cadence;
  anchorDay?: number;
  days?: [number, number];
  typicalMinor: number;
  monthlyMinor: number;
  lastDate: string | null;
  /** The first payday after today. */
  nextDate: string;
  /** Paydays after the records' last day, on or before today: expected, not imported yet. */
  expected: string[];
  /** How a payday on a weekend moves. */
  shift: WeekendShift;
  confirmed: boolean;
  evidence: Evidence;
  /** How many deposits it was seen in. */
  count: number;
}

/**
 * The household's pay: recurring money in, confirmed first, then the
 * largest a month. Small regular money in (interest, a cashback) is not a
 * payday: only what brings at least a fifth of the recurring income.
 * Grants and anything on an investment account never are (recurringView
 * already leaves them out).
 */
export function paydays(view: RecurringView): Payday[] {
  const income = [...view.confirmed, ...view.suggested].filter((x) => x.kind === "income");
  const total = income.reduce((n, x) => n + x.monthlyMinor, 0);
  return income
    .filter((x) => x.monthlyMinor > 0 && x.monthlyMinor * 5 >= total)
    .sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.monthlyMinor - a.monthlyMinor)
    .map((x) => ({
      key: x.key, name: x.name, cadence: x.cadence, anchorDay: x.anchorDay, days: x.days, typicalMinor: x.typicalMinor, monthlyMinor: x.monthlyMinor,
      lastDate: x.lastDate, nextDate: x.nextDate, expected: x.expected, shift: x.shift, confirmed: x.confirmed, evidence: x.evidence, count: x.seen.length,
    }));
}

/** The main payday, or null when no pay is seen repeating. */
export function payday(view: RecurringView): Payday | null {
  return paydays(view)[0] ?? null;
}

const step = (p: Payday, d: string, by: 1 | -1) => stepCadence(p.cadence, d, by, { day: p.anchorDay, days: p.days });

/** Where its calendar is anchored: the last deposit seen, else the next payday. */
const anchorOf = (p: Payday) => p.lastDate ?? p.nextDate;

const moved = (p: Payday, d: string) => businessDay(d, p.shift);

/** The next `count` paydays on or after `from` (moved off weekends). */
export function paydaysFrom(p: Payday, from: string, count = 3): string[] {
  // Walk the calendar's own dates (the usual day), comparing where each is paid.
  let d = anchorOf(p);
  for (let i = 0; i < 2000 && moved(p, d) < from; i++) d = step(p, d, 1);
  for (let i = 0; i < 2000 && moved(p, step(p, d, -1)) >= from; i++) d = step(p, d, -1);
  const out: string[] = [];
  for (let i = 0; out.length < count && i < count + 3; i++) {
    const m = moved(p, d);
    if (m >= from && (out.length === 0 || m > out[out.length - 1])) out.push(m);
    d = step(p, d, 1);
  }
  return out;
}

/** The next `count` paydays after `after` (after today: the next payday and the ones following it). */
export function paydaysAfter(p: Payday, after: string, count = 3): string[] {
  const [y, m, d] = after.split("-").map(Number);
  return paydaysFrom(p, new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10), count);
}

/** The next payday: the first after today, never one expected but not imported yet. */
export function nextPayday(p: Payday, today: string): string {
  return paydaysAfter(p, today, 1)[0];
}

/** Paydays after the records' last day (through) and on or before today: expected, not imported yet. */
export function expectedPaydays(p: Payday, through: string, today: string): string[] {
  const out: string[] = [];
  for (const d of paydaysAfter(p, through, 400)) {
    if (d > today) break;
    out.push(d);
  }
  return out;
}

/**
 * The pay period a day falls in: from the payday on or before it to the day
 * before the next. The seam for a "start budgets on payday" setting.
 */
export function payPeriodOf(p: Payday, date: string): { from: string; to: string } {
  let start = anchorOf(p);
  for (let i = 0; i < 2000 && moved(p, start) > date; i++) start = step(p, start, -1);
  for (let i = 0; i < 2000 && moved(p, step(p, start, 1)) <= date; i++) start = step(p, start, 1);
  const next = moved(p, step(p, start, 1));
  start = moved(p, start);
  const [y, m, d] = next.split("-").map(Number);
  const before = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return { from: start, to: before };
}
