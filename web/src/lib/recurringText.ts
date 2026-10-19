// SPDX-License-Identifier: GPL-3.0-or-later
/** How recurring items and paydays are put into words (the Insights payday card and the recurring list). */
import { type Payday, nextPayday, paydaysAfter } from "./period";
import type { RecurringItem } from "./recurring";

export function ordinal(n: number): string {
  if (n >= 31) return "last day";
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

export function dayLabel(date: string, locale: string, weekday = false): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { ...(weekday ? { weekday: "short" } : {}), day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function cadenceText(x: Pick<RecurringItem, "cadence" | "anchorDay" | "days" | "nextDate">, locale: string): string {
  const [y, m, d] = x.nextDate.split("-").map(Number);
  const wd = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
  switch (x.cadence) {
    case "weekly": return `Weekly, ${wd}s`;
    case "biweekly": return `Every 2 weeks, ${wd}s`;
    case "semimonthly": return x.days ? `Twice a month, the ${ordinal(x.days[0])} and ${ordinal(x.days[1])}` : "Twice a month";
    case "monthly": return `Monthly, the ${ordinal(x.anchorDay ?? d)}`;
    case "yearly": return `Yearly, ${dayLabel(x.nextDate, locale)}`;
  }
}

/** What to say about where an item stands: late, missed, expected but not imported yet, a new price. */
export function stateText(x: RecurringItem, money: (n: number) => string, day: (d: string) => string): { text: string; tone: "warning" | "danger" | "muted" } | null {
  if (x.state === "missed") return { text: `missed: nothing since ${x.lastDate ? day(x.lastDate) : "it started"}`, tone: "danger" };
  if (x.state === "late") return { text: `late by ${x.overdueDays} day${x.overdueDays === 1 ? "" : "s"}`, tone: "warning" };
  if (x.expected.length > 0) return { text: `expected ${x.expected.map(day).join(", ")} · not imported yet`, tone: "muted" };
  if (x.priceChange) return { text: `price ${x.priceChange.toMinor > x.priceChange.fromMinor ? "up" : "down"} from ${money(x.priceChange.fromMinor)}`, tone: "warning" };
  if (x.state === "due") return { text: "due now", tone: "muted" };
  return null;
}

export function evidenceText(evidence: RecurringItem["evidence"], count: number): string {
  if (evidence === "confirmed") return "";
  if (evidence === "regular") return `Suggested — seen ${count} times`;
  return "Suggested — needs more months or your OK";
}


/**
 * The payday card's lines. The next payday is the first after today; one
 * after the records' last day but not after today is expected, not imported yet.
 */
export function paydayLines(p: Payday, today: string, locale: string, money: (n: number) => string): { next: string; how: string; expected: string | null; then: string; evidence: string } {
  const next = nextPayday(p, today);
  return {
    next: `Next payday ${dayLabel(next, locale, true)}`,
    how: `${cadenceText({ ...p, nextDate: next }, locale)} · usually ${money(p.typicalMinor)} · ${p.name}`,
    expected: p.expected.length ? `Expected ${p.expected.map((d) => dayLabel(d, locale)).join(", ")} · not imported yet` : null,
    then: `Then ${paydaysAfter(p, next, 2).map((d) => dayLabel(d, locale)).join(", ")}`,
    evidence: p.confirmed ? "" : evidenceText(p.evidence, p.count),
  };
}
