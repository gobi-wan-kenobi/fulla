// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar arithmetic on YYYY-MM-DD days, in UTC so no zone moves a day.

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function iso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function toTime(date: string): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, n: number): string {
  return iso(toTime(date) + n * 86_400_000);
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toTime(b) - toTime(a)) / 86_400_000);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The day `day` of the month `by` months after date's, on the month's last day when it is shorter. */
export function addMonths(date: string, by: number, day?: number): string {
  const [y, m, d] = parts(date);
  const first = new Date(Date.UTC(y, m - 1 + by, 1));
  const yy = first.getUTCFullYear();
  const mm = first.getUTCMonth() + 1;
  const dd = Math.min(day ?? d, daysInMonth(yy, mm));
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** ISO weekday: 1 Monday … 7 Sunday. */
export function weekday(date: string): number {
  const w = new Date(toTime(date)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function dayOfMonth(date: string): number {
  return parts(date)[2];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
