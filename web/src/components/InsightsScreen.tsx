// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { canManage } from "@/lib/rules";
import { type Report, merchantName, report } from "@/lib/insights";
import { counted, monthOf, shiftMonth, today as todayOf } from "@/lib/ledger";
import { outsideTotals, type Config } from "@/lib/model";
import { formatMoney, requireCurrency } from "@/lib/money";
import { wholePercents } from "@/lib/overview";
import { nextPayday, payday, paydays, periodBounds } from "@/lib/period";
import { type RecurringView, recurringView, stillToCome } from "@/lib/recurring";
import type { LocalRow } from "@/lib/sync";
import { EmptyState, ScreenHeader, Section, categoryColor } from "./Pieces";
import { RecurringSection } from "./RecurringSection";
import { cadenceText, dayLabel, paydayLines } from "@/lib/recurringText";

function monthLabel(month: string, locale: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, short ? { month: "short", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** A glass tile: a figure, what it is, and a level filled to what it measures. */
function Tile({ label, value, context, level, tone = "out", valueClass = "", testId }: {
  label: string; value: string; context?: string; level?: number | null; tone?: "in" | "out"; valueClass?: string; testId?: string;
}) {
  const fill = level === null || level === undefined ? null : Math.max(0, Math.min(1, level));
  return (
    <div className="relative overflow-hidden rounded-2xl bg-paper-high p-4 min-h-[112px]" data-testid={testId}>
      {fill !== null && (
        <div className="absolute inset-x-0 bottom-0 opacity-25" aria-hidden
          style={{ height: `${Math.round(fill * 100)}%`, background: `linear-gradient(var(--${tone}-surface), var(--${tone}-body))` }} />
      )}
      <div className="relative">
        <div className="t-label text-ink-muted">{label}</div>
        <div className={`t-title mt-1 ${valueClass}`} style={{ fontStretch: "88%" }}>{value}</div>
        {context && <div className="t-label text-ink-muted mt-1">{context}</div>}
      </div>
    </div>
  );
}

/** A row with a bar under it, scaled to the largest of its list. */
function BarRow({ title, amount, fraction, context, color, testId }: { title: string; amount: string; fraction: number; context?: string; color?: string; testId?: string }) {
  return (
    <div className="px-5 py-2.5 border-b border-line" data-testid={testId}>
      <div className="flex items-baseline gap-3">
        <div className="flex-1 min-w-0">
          <div className="t-body truncate">{title}</div>
          {context && <div className="t-secondary text-ink-muted">{context}</div>}
        </div>
        <div className="t-amount shrink-0">{amount}</div>
      </div>
      <div className="h-1.5 rounded-full bg-line mt-2 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.round(Math.max(0, Math.min(1, fraction)) * 100))}%`, background: color ?? "var(--out-body)" }} />
      </div>
    </div>
  );
}

/**
 * Insights, as the Android screen: one month at a time, the figures of the
 * month in tiles, payday and what is committed every month, where the money
 * went, the weekdays, the largest expenses, what was bought again and again,
 * what moved against the usual, who paid, month by month, and the recurring
 * items (confirmed and suggested). Figures from lib/insights.ts,
 * lib/recurring.ts and lib/period.ts.
 */
export function InsightsScreen({ config, rows, onConfig, onClose, initialMonth, today: given, dismissed: givenDismissed }: {
  config: Config;
  rows: LocalRow[];
  onConfig: (c: Config) => void;
  onClose?: () => void;
  initialMonth?: string;
  today?: string;
  dismissed?: string[];
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const unit = 10 ** requireCurrency(currency).minorUnits;
  const money = (n: number, signed = false) => formatMoney(n, currency, locale, signed);
  const today = given ?? todayOf();
  const current = monthOf(today);
  const [month, setMonth] = useState(initialMonth ?? current);
  const [fetched, setFetched] = useState<string[] | null>(null);
  useEffect(() => {
    if (givenDismissed) return;
    let live = true;
    api.recurringDismissals(config.household.id).then((k) => live && setFetched(k), () => live && setFetched([]));
    return () => { live = false; };
  }, [config.household.id, givenDismissed]);
  const [dismissedNow, setDismissedNow] = useState<string[] | null>(null);
  const dismissed = useMemo(() => dismissedNow ?? givenDismissed ?? fetched ?? [], [dismissedNow, givenDismissed, fetched]);
  const manage = canManage(config);
  const outside = useMemo(() => outsideTotals(config.categories, config.accounts), [config.categories, config.accounts]);
  const txs = useMemo(() => counted(rows), [rows]);
  const r: Report = useMemo(() => report(txs, config, month, today, outside, unit), [txs, config, month, today, outside, unit]);
  const rec: RecurringView = useMemo(() => recurringView(txs, config, today, outside, dismissed), [txs, config, today, outside, dismissed]);
  const pay = payday(rec);
  const otherPay = paydays(rec).slice(1);
  const payText = pay ? paydayLines(pay, today, locale, (n) => money(n)) : null;
  const bounds = periodBounds(current);
  const toCome = stillToCome(rec, today, bounds.to);
  const category = (id: string | null) => (id ? config.categories.find((c) => c.id === id) : undefined);
  const nothing = r.spentMinor === 0 && r.incomeMinor === 0 && r.count === 0;

  const vsPrevious = r.previousSpentMinor === null || r.previousSpentMinor <= 0 ? undefined
    : r.spentMinor === r.previousSpentMinor ? `same as ${r.running ? "by now last month" : "last month"}`
    : `${Math.round(Math.abs((r.spentMinor - r.previousSpentMinor) * 100 / r.previousSpentMinor))} % ${r.spentMinor > r.previousSpentMinor ? "more" : "less"} than ${r.running ? "by now last month" : "last month"}`;
  const both = r.fixedMinor + r.variableMinor;

  return (
    <div data-testid="insights-screen">
      <ScreenHeader title="Insights" end={onClose && <button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>} />
      <div className="flex items-center justify-between px-3">
        <button type="button" aria-label="Previous month" className="yields p-2" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={22} /></button>
        <div className="t-section" data-testid="insights-month">{monthLabel(month, locale)}</div>
        <button type="button" aria-label="Next month" className="yields p-2 disabled:opacity-30" disabled={month >= current} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={22} /></button>
      </div>

      {/* Payday first: when the money comes is what the rest is measured against. */}
      <div className="px-5 pt-3">
        <div className="rounded-2xl bg-paper-high p-4" data-testid="payday-card">
          <div className="flex items-center gap-2 t-label text-ink-muted"><CalendarClock size={16} aria-hidden /> Payday</div>
          {pay ? (
            <>
              <div className="t-title mt-1" data-testid="payday-next">{payText!.next}</div>
              <div className="t-secondary text-ink-muted mt-0.5">{cadenceText({ ...pay, nextDate: nextPayday(pay, today) }, locale)} · usually <span className="text-money-in">{money(pay.typicalMinor)}</span> · {pay.name}</div>
              {payText!.expected && <div className="t-secondary mt-1" data-testid="payday-expected">{payText!.expected}</div>}
              <div className="t-label text-ink-muted mt-1">{payText!.then}</div>
              {payText!.evidence && <div className="t-label text-warning mt-2" data-testid="payday-evidence">{payText!.evidence}</div>}
              {otherPay.length > 0 && <div className="t-label text-ink-muted mt-1">Also: {otherPay.map((p) => `${p.name} ${dayLabel(nextPayday(p, today), locale)}`).join(", ")}</div>}
            </>
          ) : (
            <p className="t-secondary text-ink-muted mt-1">No pay seen repeating yet. Once two deposits of your pay are recorded (or one marked fixed), the next payday shows here.</p>
          )}
        </div>
      </div>

      {nothing ? (
        <EmptyState title="Nothing this month yet" text="What you add or import shows up here: the month in figures, where it went, and what repeats." />
      ) : (
        <>
          <Section>{r.running ? "The month so far" : "The month in figures"}</Section>
          <div className="grid grid-cols-2 gap-3 px-5" data-testid="insights-tiles">
            <Tile label="Spent" value={money(r.spentMinor)} context={vsPrevious} level={r.incomeMinor > 0 ? r.spentMinor / r.incomeMinor : null} testId="tile-spent" />
            {r.savingsRate !== null && (
              <Tile label={r.running ? "Left now" : "Saved"} value={`${Math.round(r.savingsRate * 100)} %`} context={`of ${money(r.incomeMinor)} in`}
                level={r.savingsRate} tone="in" valueClass={r.savingsRate < 0 ? "text-money-out" : "text-money-in"} testId="tile-saved" />
            )}
            {r.days > 0 && <Tile label="A day, everyday" value={money(r.dailyMinor)} context={r.running ? `${r.days} of ${r.length} days` : `over ${r.days} days`} level={r.days / r.length} />}
            {r.count > 0 && <Tile label="Expenses" value={`${r.count}`} context={`${money(r.averageMinor)} each on average`} />}
            {both > 0 && <Tile label="Fixed share" value={`${Math.round((r.fixedMinor * 100) / both)} %`} context={`fixed ${money(r.fixedMinor)} · flexible ${money(r.variableMinor)}`} level={r.fixedMinor / both} />}
            {r.noSpendOf > 0 && <Tile label="Days without spending" value={`${r.noSpendDays}`} context={`of ${r.noSpendOf} days`} level={r.noSpendDays / r.noSpendOf} tone="in" />}
            {r.budgets > 0 && <Tile label="Budgets over" value={`${r.budgetsOver} of ${r.budgets}`} level={r.budgetsOver / r.budgets} valueClass={r.budgetsOver > 0 ? "text-danger" : ""} />}
          </div>
        </>
      )}

      <Section>Committed every month</Section>
      <div className="px-5" data-testid="recurring-summary">
        <div className="flex items-baseline justify-between">
          <div className="t-body">Recurring you confirmed</div>
          <div className="t-amount" data-testid="committed-total">{money(rec.committedMinor)}</div>
        </div>
        {rec.suggestedMinor > 0 && (
          <div className="flex items-baseline justify-between mt-1">
            <div className="t-secondary text-ink-muted">More, if the suggestions are right</div>
            <div className="t-secondary text-ink-muted" data-testid="suggested-total">+{money(rec.suggestedMinor)}</div>
          </div>
        )}
        {month === current && toCome.items.length > 0 && (
          <div className="flex items-baseline justify-between mt-1">
            <div className="t-secondary text-ink-muted">Still to come after today, to {dayLabel(bounds.to, locale)} ({toCome.count})</div>
            <div className="t-secondary text-ink-muted" data-testid="to-come-total">{money(toCome.totalMinor)}</div>
          </div>
        )}
        <p className="t-label text-ink-muted mt-2">Weekly and yearly items count as their monthly share. Recorded through {dayLabel(rec.through, locale)}.</p>
      </div>

      {!nothing && r.top.length > 0 && (() => {
        const percents = wholePercents(r.top.map((s) => s.amountMinor));
        const max = Math.max(...r.top.map((s) => s.amountMinor));
        return (
          <>
            <Section>Where it went</Section>
            {r.top.map((s, i) => {
              const c = category(s.categoryId);
              return <BarRow key={s.categoryId ?? "other"} title={s.categoryId === null ? "Everything else" : c?.name ?? "Uncategorized"} amount={money(s.amountMinor)}
                context={`${percents[i]} %`} fraction={s.amountMinor / max} color={c ? categoryColor(c.color_index) : undefined} testId="insights-top" />;
            })}
          </>
        );
      })()}

      {!nothing && r.weekdays.some((v) => v > 0) && (() => {
        const max = Math.max(...r.weekdays, 1);
        const percents = wholePercents(r.weekdays.map((v) => Math.max(0, v)));
        const names = [1, 2, 3, 4, 5, 6, 7].map((i) => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, i))));
        return (
          <>
            <Section>By weekday, everyday spending</Section>
            <div className="grid grid-cols-7 gap-2 px-5 items-end h-36" data-testid="insights-weekdays">
              {r.weekdays.map((v, i) => (
                <div key={i} className="flex flex-col items-center justify-end h-full gap-1" title={`${names[i]}, ${money(v)}`}>
                  <div className="t-label text-ink-muted">{percents[i]} %</div>
                  <div className="w-full rounded-t-lg" style={{ height: `${Math.max(3, Math.round((Math.max(0, v) / max) * 80))}px`, background: "linear-gradient(var(--out-surface), var(--out-body))" }} />
                  <div className="t-label">{names[i]}</div>
                </div>
              ))}
            </div>
          </>
        );
      })()}

      {!nothing && r.biggest.length > 0 && (
        <>
          <Section>Largest expenses</Section>
          {r.biggest.map((t) => {
            const c = category(t.category_id);
            const name = t.note ? merchantName(t.note) : c?.name ?? "Uncategorized";
            return <BarRow key={t.id} title={name} amount={money(t.amount_minor)} fraction={t.amount_minor / r.biggest[0].amount_minor}
              context={[t.note ? c?.name : null, dayLabel(t.date, locale)].filter(Boolean).join(" · ")} testId="insights-biggest" />;
          })}
        </>
      )}

      {!nothing && r.places.length > 0 && (
        <>
          <Section>Bought again and again</Section>
          {r.places.map((p) => <BarRow key={p.name} title={p.name} amount={money(p.totalMinor)} fraction={p.totalMinor / r.places[0].totalMinor} context={`${p.count} times`} />)}
        </>
      )}

      {!nothing && r.trends.length > 0 && (
        <>
          <Section>Against the usual</Section>
          {(() => {
            const max = Math.max(...r.trends.map((t) => Math.max(t.currentMinor, t.averageMinor)));
            return r.trends.map((t) => (
              <BarRow key={t.categoryId ?? "none"} title={category(t.categoryId)?.name ?? "Uncategorized"} amount={money(t.currentMinor)} fraction={t.currentMinor / max}
                context={`usually ${money(t.averageMinor)}${r.running ? " by now" : ""} · ${Math.round(Math.abs(t.change) * 100)} % ${t.currentMinor > t.averageMinor ? "more" : "less"}`} testId="insights-trend" />
            ));
          })()}
        </>
      )}

      {!nothing && r.byMember.length > 1 && config.household.money_mode !== "shared" && (
        <>
          <Section>Who paid</Section>
          {(() => {
            const max = Math.max(1, ...r.byMember.map((m) => m.paidMinor));
            return r.byMember.map((m) => (
              <BarRow key={m.memberId} title={config.members.find((x) => x.id === m.memberId)?.display_name ?? "?"} amount={money(m.paidMinor)} fraction={m.paidMinor / max} context={`their share ${money(m.shareMinor)}`} />
            ));
          })()}
        </>
      )}

      {r.series.length > 0 && (
        <>
          <Section>Month by month</Section>
          {r.series.map((s) => (
            <div key={s.month} className="flex items-center gap-4 px-5 py-2.5 border-b border-line" data-testid="insights-series">
              <div className="flex-1 min-w-0">
                <div className="t-body">{monthLabel(s.month, locale)}</div>
                <div className="t-secondary text-ink-muted">{s.month === current ? "so far · " : ""}in {money(s.incomeMinor)} · out {money(s.expenseMinor)}</div>
              </div>
              <div className={`t-amount ${s.savingsMinor < 0 ? "text-money-out" : "text-money-in"}`}>{money(s.savingsMinor, true)}</div>
            </div>
          ))}
        </>
      )}

      <RecurringSection config={config} view={rec} onConfig={onConfig} dismissed={dismissed} onDismissed={setDismissedNow} manage={manage} />
      {rec.confirmed.length === 0 && rec.suggested.length === 0 && (
        <EmptyState title="Nothing repeating yet" text="Charges that come back every week, fortnight, month or year show here as suggestions to confirm, edit or dismiss." />
      )}
      <div className="h-8" />
    </div>
  );
}
