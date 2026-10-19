// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Landmark } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { monthOf, shiftMonth, today } from "@/lib/ledger";
import type { Config } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import { type BalanceSnapshot, holdings, overview, wholePercents } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { categoryTone } from "@/lib/budgets";
import { BudgetBar, ProgressLine } from "./BudgetBar";
import { HeroJar } from "./HeroJar";
import { Icon } from "./Icon";
import { EmptyState, ScreenHeader, Section, categoryColor } from "./Pieces";

function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * The month at a glance, as the Android Overview: the month, what came in,
 * what went out and what is left, then where the spending went, one plain row
 * per category. Figures come from lib/overview.ts.
 */
export function OverviewScreen({ config, rows, snapshots: given, initialMonth, initialOpen, onTrend, onBudgets }: {
  config: Config; rows: LocalRow[]; snapshots?: BalanceSnapshot[]; initialMonth?: string; initialOpen?: string | null;
  /** A category tapped in "Where it went": its trend. */
  onTrend?: (categoryId: string) => void;
  /** The budget bar tapped: the Budgets screen. */
  onBudgets?: () => void;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const current = monthOf(today());
  const [month, setMonth] = useState(initialMonth ?? current);
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const [fetched, setFetched] = useState<BalanceSnapshot[]>([]);
  useEffect(() => {
    if (given) return;
    let live = true;
    api.balanceSnapshots(config.household.id).then((s) => live && setFetched(s), () => undefined);
    return () => { live = false; };
  }, [config.household.id, given]);
  const snapshots = given ?? fetched;

  const view = useMemo(
    () => overview(rows, config.categories, month, today(), config.accounts, { budgets: config.budgets, trips: config.trips }),
    [rows, config.categories, config.accounts, config.budgets, config.trips, month],
  );
  const held = useMemo(() => holdings(rows, config.accounts, snapshots, today()), [rows, config.accounts, snapshots]);
  const f = view.figures;
  const money = (n: number, signed = false) => formatMoney(n, currency, locale, signed);
  const category = (id: string | null) => (id ? config.categories.find((c) => c.id === id) : undefined);
  const percents = wholePercents(view.categories.map((c) => Math.max(0, c.amountMinor)));
  const openAccounts = config.accounts.filter((a) => !a.archived).length;
  const nothing = f.incomeMinor === 0 && view.categories.length === 0;

  return (
    <div>
      <ScreenHeader title="Overview" />
      <div className="flex items-center justify-between px-3" data-testid="period">
        <button type="button" aria-label="Previous month" className="yields p-2" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={22} /></button>
        <div className="t-section" data-testid="overview-month">{monthLabel(month, locale)}</div>
        <button type="button" aria-label="Next month" className="yields p-2 disabled:opacity-30" disabled={month >= current} onClick={() => setMonth(shiftMonth(month, 1))}>
          <ChevronRight size={22} />
        </button>
      </div>

      <div data-testid="overview-left">
        <HeroJar hero={view.hero} money={(n) => money(n)}
          description={`${monthLabel(month, locale)}: ${money(f.incomeMinor)} in, ${money(f.spentMinor)} out, ${money(f.leftMinor)} ${view.running ? "left so far" : f.leftMinor < 0 ? "overspent" : "saved"}.`} />
      </div>

      <div className="grid grid-cols-3 gap-2 px-5 py-3" data-testid="overview-figures">
        <div>
          <div className="t-label text-ink-muted">Money in</div>
          <div className="t-amount text-money-in truncate" data-testid="figure-in">{money(f.incomeMinor, true)}</div>
        </div>
        <div>
          <div className="t-label text-ink-muted">Money out</div>
          <div className="t-amount text-money-out truncate" data-testid="figure-out">{money(f.spentMinor)}</div>
        </div>
        <div>
          <div className="t-label text-ink-muted">{view.running ? "Left now" : "Saved"}</div>
          <div className="t-amount text-ink" data-testid="figure-rate">{f.savingsRate === null ? "—" : `${Math.round(f.savingsRate * 100)} %`}</div>
        </div>
      </div>
      {f.spentMinor !== 0 && (
        <p className="t-secondary text-ink-muted px-5" data-testid="overview-split">
          Fixed {money(f.fixedMinor)} · Flexible {money(f.flexibleMinor)} · transfers between your accounts are not counted
        </p>
      )}

      <BudgetBar status={view.budget} money={(n) => money(n)} onOpen={onBudgets} />

      {held && (
        <div className="flex items-center gap-4 px-5 py-3 mt-3 border-y border-line" data-testid="overview-holdings">
          <Landmark size={22} className="text-ink-muted shrink-0" aria-hidden />
          <div className="flex-1 min-w-0">
            <div className="t-body">What the accounts hold</div>
            <div className="t-secondary text-ink-muted">
              Today, from statement and opening balances{held.known < openAccounts ? ` · ${held.known} of ${openAccounts} accounts` : ""}
            </div>
          </div>
          <div className="t-amount">{money(held.totalMinor)}</div>
        </div>
      )}

      {nothing ? (
        <EmptyState title="Nothing this month yet" text="What you add or import shows up here: what came in, what went out, and where it went." />
      ) : view.categories.length > 0 && (
        <>
          <Section>Where it went</Section>
          {view.categories.map((row, i) => {
            const c = category(row.categoryId);
            const key = row.categoryId ?? "none";
            const expanded = open === key;
            const context = [
              `${percents[i]} %`,
              row.fixedMinor !== 0 && row.flexibleMinor !== 0 ? `fixed ${money(row.fixedMinor)}` : row.fixedMinor !== 0 ? "fixed" : null,
              row.budget ? `of ${money(row.budget.limitMinor)}` : row.usualMinor > 0 ? `usually ${money(row.usualMinor)}` : null,
            ].filter(Boolean).join(" · ");
            return (
              <div key={key}>
              <div data-testid="where-row" className="flex items-stretch border-b border-line">
                <button
                  type="button"
                  data-testid="where-open"
                  className="flex-1 min-w-0 flex items-center gap-4 pl-5 py-3 text-left yields"
                  onClick={() => (onTrend && row.categoryId ? onTrend(row.categoryId) : row.subs.length > 0 && setOpen(expanded ? null : key))}
                  aria-label={onTrend && row.categoryId ? `${c?.name ?? "Uncategorized"}: ${money(row.amountMinor)}, open its trend` : undefined}
                  aria-expanded={!onTrend && row.subs.length > 0 ? expanded : undefined}
                >
                  <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-paper-high">
                    <Icon name={c?.icon ?? "label"} color={categoryColor(c?.color_index ?? 0)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="t-body truncate">{c?.name ?? "Uncategorized"}</div>
                    <div className="t-secondary text-ink-muted truncate">{context}</div>
                    {row.budget ? (
                      <ProgressLine status={row.budget} tone={categoryTone(row.budget, c?.fixed)} testId="where-budget" />
                    ) : (
                      <div className="h-1 rounded-full bg-paper-high mt-1.5 overflow-hidden" aria-hidden>
                        <div className="h-full rounded-full" style={{ width: `${Math.round(row.share * 100)}%`, background: categoryColor(c?.color_index ?? 0) }} />
                      </div>
                    )}
                  </div>
                  <div className="t-amount">{money(row.amountMinor)}</div>
                </button>
                <button type="button" data-testid="where-expand" disabled={row.subs.length === 0}
                  className="w-[54px] shrink-0 flex items-center justify-center text-ink-muted yields disabled:pointer-events-none"
                  onClick={() => setOpen(expanded ? null : key)} aria-expanded={row.subs.length > 0 ? expanded : undefined}
                  aria-label={row.subs.length > 0 ? `${expanded ? "Hide" : "Show"} subcategories` : undefined} aria-hidden={row.subs.length === 0}>
                  {row.subs.length > 0 && (expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />)}
                </button>
              </div>
              {expanded && row.subs.map((s) => (
                  <button type="button" key={s.categoryId} onClick={() => onTrend?.(s.categoryId)} disabled={!onTrend}
                    className="w-full flex items-center gap-4 pl-[76px] pr-[54px] py-2 border-b border-line text-left yields" data-testid="where-sub">
                    <div className="flex-1 t-secondary truncate">{s.categoryId === row.categoryId ? "General" : category(s.categoryId)?.name ?? ""}</div>
                    <div className="t-amount text-ink-muted">{money(s.amountMinor)}</div>
                  </button>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
