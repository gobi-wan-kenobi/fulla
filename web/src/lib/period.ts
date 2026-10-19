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
 */
import { monthOf, shiftMonth } from "./ledger";
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
  nextDate: string;
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
      lastDate: x.lastDate, nextDate: x.nextDate, confirmed: x.confirmed, evidence: x.evidence, count: x.seen.length,
    }));
}

/** The main payday, or null when no pay is seen repeating. */
export function payday(view: RecurringView): Payday | null {
  return paydays(view)[0] ?? null;
}

const step = (p: Payday, d: string, by: 1 | -1) => stepCadence(p.cadence, d, by, { day: p.anchorDay, days: p.days });

/** The next `count` paydays on or after `from`. */
export function paydaysFrom(p: Payday, from: string, count = 3): string[] {
  let d = p.lastDate ?? p.nextDate;
  for (let i = 0; i < 2000 && d < from; i++) d = step(p, d, 1);
  for (let i = 0; i < 2000 && step(p, d, -1) >= from; i++) d = step(p, d, -1);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(d);
    d = step(p, d, 1);
  }
  return out;
}

/**
 * The pay period a day falls in: from the payday on or before it to the day
 * before the next. The seam for a "start budgets on payday" setting.
 */
export function payPeriodOf(p: Payday, date: string): { from: string; to: string } {
  let start = p.lastDate ?? p.nextDate;
  for (let i = 0; i < 2000 && start > date; i++) start = step(p, start, -1);
  for (let i = 0; i < 2000 && step(p, start, 1) <= date; i++) start = step(p, start, 1);
  const next = step(p, start, 1);
  const [y, m, d] = next.split("-").map(Number);
  const before = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return { from: start, to: before };
}
