// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { useMemo, useState } from "react";
import { today as todayOf } from "@/lib/ledger";
import { outsideTotals, type Category, type Config } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { changePercent, chartScale, daysIn, rangeFor, trend, type Range, type RangeKind, type Trend } from "@/lib/trends";
import { Chip, EmptyState, ScreenHeader, Section, SecondaryButton, categoryColor, inputClass } from "./Pieces";

const RANGES: { key: RangeKind; label: string; previous: string }[] = [
  { key: "90d", label: "90 days", previous: "the 90 days before" },
  { key: "6m", label: "6 months", previous: "the 6 months before" },
  { key: "1y", label: "1 year", previous: "the year before" },
  { key: "custom", label: "Custom", previous: "" },
];

function dayLabel(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
function monthShort(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}
function monthLong(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** The spending categories to pick from: each top-level one, its subcategories under it. */
function choices(categories: Category[]): { id: string; label: string; top: string }[] {
  const shown = categories.filter((c) => !c.archived && c.applies_to !== "income").sort((a, b) => a.sort - b.sort);
  const ids = new Set(shown.map((c) => c.id));
  const tops = shown.filter((c) => !c.parent_id || !ids.has(c.parent_id));
  return tops.flatMap((t) => [
    { id: t.id, label: t.name, top: t.id },
    ...shown.filter((s) => s.parent_id === t.id).map((s) => ({ id: s.id, label: `\u2003${s.name}`, top: t.id })),
  ]);
}

function Chart({ t, color, money, locale }: { t: Trend; color: string; money: (n: number) => string; locale: string }) {
  const W = 360;
  const H = 190;
  const top = 18;
  const bottom = H - 26;
  const { max, min } = chartScale(t);
  const span = max - min || 1;
  const y = (v: number) => top + ((max - v) / span) * (bottom - top);
  const n = t.months.length;
  const slot = (W - 8) / n;
  const bar = Math.min(28, slot * 0.66);
  const every = n > 8 ? 2 : 1;
  const avgY = y(t.averageMinor);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" role="img" data-testid="trend-chart"
      aria-label={t.months.map((m) => `${monthLong(m.month, locale)}${m.partial ? " (partial)" : ""}: ${m.recorded ? money(m.amountMinor) : "not recorded"}`).join("; ")}>
      <defs>
        <pattern id="trend-partial" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={color} fillOpacity={0.18} />
          <rect width="2.5" height="6" fill={color} fillOpacity={0.55} />
        </pattern>
      </defs>
      <line x1={4} x2={W - 4} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth={1} />
      {t.months.map((m, i) => {
        const cx = 4 + slot * i + slot / 2;
        const y0 = y(0);
        const y1 = y(m.amountMinor);
        const h = Math.abs(y0 - y1);
        return (
          <g key={m.month} data-testid="trend-bar" data-partial={m.partial ? "true" : "false"}>
            {h > 0 && (
              <rect x={cx - bar / 2} y={Math.min(y0, y1)} width={bar} height={Math.max(h, 1)} rx={Math.min(6, bar / 3)}
                fill={m.partial ? "url(#trend-partial)" : color} stroke={m.partial ? color : "none"} strokeDasharray={m.partial ? "3 2" : undefined} strokeWidth={m.partial ? 1 : 0} />
            )}
            {(i % every === 0 || i === n - 1) && (
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--ink-muted)" fillOpacity={m.recorded ? 1 : 0.5}>{monthShort(m.month, locale)}{m.partial ? "*" : ""}</text>
            )}
          </g>
        );
      })}
      {t.count > 0 && (
        <g data-testid="trend-average">
          <line x1={4} x2={W - 4} y1={avgY} y2={avgY} stroke="var(--ink)" strokeWidth={1.25} strokeDasharray="5 4" />
          <text x={W - 6} y={Math.max(11, avgY - 5)} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--ink)"
            stroke="var(--paper)" strokeWidth={4} strokeLinejoin="round" paintOrder="stroke">avg {money(t.averageMinor)}</text>
        </g>
      )}
    </svg>
  );
}

/**
 * One category's spending, or all of it, month by month: bars, the average
 * a month, and the change against the period before. Figures from lib/trends.ts.
 */
export function TrendsScreen({ config, rows, initialCategory = null, initialRange = "6m", today: given, onImport }: {
  config: Config;
  rows: LocalRow[];
  /** Opened from the Overview: that category. Null is all spending. */
  initialCategory?: string | null;
  initialRange?: RangeKind;
  today?: string;
  onImport?: () => void;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const money = (n: number, signed = false) => formatMoney(n, currency, locale, signed);
  const today = given ?? todayOf();
  const [choice, setChoice] = useState<string | null>(initialCategory);
  const [kind, setKind] = useState<RangeKind>(initialRange);
  const [custom, setCustom] = useState<Range>(() => rangeFor("90d", today));
  const range = useMemo(() => rangeFor(kind, today, custom), [kind, today, custom]);
  const options = useMemo(() => choices(config.categories), [config.categories]);
  const outside = useMemo(() => outsideTotals(config.categories, config.accounts), [config.categories, config.accounts]);
  const t = useMemo(() => trend(rows, config.categories, choice, range, outside), [rows, config.categories, choice, range, outside]);
  const picked = options.find((o) => o.id === choice);
  const top = picked ? config.categories.find((c) => c.id === picked.top) : undefined;
  const color = top ? categoryColor(top.color_index) : "var(--money-out)";
  const name = picked ? picked.label.trim() : "All spending";
  const previous = kind === "custom" ? `the ${daysIn(range)} days before` : RANGES.find((r) => r.key === kind)!.previous;
  const pct = changePercent(t.changeRatio);
  const startsInside = t.dataFrom !== null && t.dataFrom > range.from;

  return (
    <div>
      <ScreenHeader title="Trends" />
      <div className="px-5 grid gap-3">
        <label className="block">
          <span className="t-label text-ink-muted">Category</span>
          <select data-testid="trend-category" className={`${inputClass} mt-1`} value={choice ?? ""} onChange={(e) => setChoice(e.target.value || null)}>
            <option value="">All spending</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <div className="flex gap-2 overflow-x-auto" data-testid="trend-ranges">
          {RANGES.map((r) => <Chip key={r.key} label={r.label} selected={kind === r.key} onClick={() => setKind(r.key)} testId={`range-${r.key}`} />)}
        </div>
        {kind === "custom" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="t-label text-ink-muted">From</span>
              <input type="date" data-testid="trend-from" className={`${inputClass} mt-1`} value={custom.from} max={today} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label className="block"><span className="t-label text-ink-muted">To</span>
              <input type="date" data-testid="trend-to" className={`${inputClass} mt-1`} value={custom.to} max={today} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
            </label>
          </div>
        )}
      </div>
      <p className="t-secondary text-ink-muted px-5 pt-3" data-testid="trend-range">{dayLabel(range.from, locale)} – {dayLabel(range.to, locale)} · {daysIn(range)} days</p>

      {t.count === 0 ? (
        <EmptyState title="Nothing to show yet"
          text={`No ${picked ? `spending in ${name}` : "spending"} in this range${t.dataFrom ? `; your records start on ${dayLabel(t.dataFrom, locale)}` : ""}. Import older statements to see how it changes over time.`}>
          {onImport && <SecondaryButton onClick={onImport}>Import statements</SecondaryButton>}
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 px-5 pt-4" data-testid="trend-figures">
            <div>
              <div className="t-label text-ink-muted">{name}</div>
              <div className="t-amount" data-testid="trend-total">{money(t.totalMinor)}</div>
            </div>
            <div>
              <div className="t-label text-ink-muted">Average a month</div>
              <div className="t-amount" data-testid="trend-avg">{money(t.averageMinor)}</div>
            </div>
          </div>
          <p className="t-secondary px-5 pt-2" data-testid="trend-change">
            {t.changeMinor !== null ? (
              <><span className="t-amount">{money(t.changeMinor, true)}</span>{pct ? ` (${pct})` : " (nothing spent then)"} vs {previous}</>
            ) : t.previousCoverage === "partial" && t.dataFrom ? (
              <span className="text-ink-muted">Not compared: {previous} {kind === "1y" ? "is" : "are"} only partly recorded (from {dayLabel(t.dataFrom, locale)})</span>
            ) : (
              <span className="text-ink-muted">Nothing recorded in {previous} to compare with</span>
            )}
          </p>
          <div className="px-3 pt-4"><Chart t={t} color={color} money={(n) => money(n)} locale={locale} /></div>
          <p className="t-label text-ink-muted px-5" data-testid="trend-legend">* partial month (striped) · dashed line: average a month</p>
          {(startsInside || t.monthsWithData < 3) && (
            <div className="mx-5 mt-3 rounded-2xl bg-paper-high p-4 t-secondary" data-testid="trend-sparse">
              {t.monthsWithData < 3 ? `Only ${t.monthsWithData} month${t.monthsWithData === 1 ? "" : "s"} with spending here. ` : ""}
              {startsInside && t.dataFrom ? `Your records start on ${dayLabel(t.dataFrom, locale)}: earlier months are not recorded, not zero. ` : ""}
              Import older statements for a fuller picture.
              {onImport && <div className="pt-3"><SecondaryButton onClick={onImport}>Import statements</SecondaryButton></div>}
            </div>
          )}
          <Section>By month</Section>
          {[...t.months].reverse().map((m) => (
            <div key={m.month} className="flex items-center justify-between px-5 py-2 border-b border-line" data-testid="trend-month">
              <div>
                <div className="t-body">{monthLong(m.month, locale)}</div>
                {m.partial && <div className="t-label text-ink-muted">partial · {m.days} day{m.days === 1 ? "" : "s"}</div>}
              </div>
              {m.recorded ? <div className="t-amount">{money(m.amountMinor)}</div> : <div className="t-secondary text-ink-muted">not recorded</div>}
            </div>
          ))}
          <p className="t-label text-ink-muted px-5 pt-3 pb-8">Expenses less refunds. Transfers, anything inside investment accounts and grants are not counted.</p>
        </>
      )}
    </div>
  );
}
