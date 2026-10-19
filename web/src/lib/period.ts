// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The household's period: for now the calendar month, named YYYY-MM as
 * fulla.budgets stores it. Budgets and their figures ask here, not monthOf,
 * so a later "start on payday" setting (the Android PeriodRule) changes
 * where a period begins and ends in this one place.
 */
import { monthOf, shiftMonth } from "./ledger";

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
