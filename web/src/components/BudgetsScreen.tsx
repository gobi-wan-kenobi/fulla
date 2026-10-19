// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { type BudgetLine, budgetStatus, budgetToSave, budgetsForMonth, budgetsView, expectedMinor, fixedTone, categoryTone } from "@/lib/budgets";
import { randomId } from "@/lib/ids";
import { counted, today as todayOf } from "@/lib/ledger";
import { outsideTotals, type Config } from "@/lib/model";
import { formatMoney, parseTyped, requireCurrency } from "@/lib/money";
import { periodOf, shiftPeriod } from "@/lib/period";
import { canManage } from "@/lib/rules";
import type { LocalRow } from "@/lib/sync";
import { BudgetBar, ProgressLine, budgetWords, toneText } from "./BudgetBar";
import { Icon } from "./Icon";
import { Chip, EmptyState, PrimaryButton, ScreenHeader, Section, SecondaryButton, categoryColor, inputClass } from "./Pieces";

function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * Budgets, as the Android app's (Settings › Budgets, with its Fixed costs
 * folded in): each spending category's amount for the month, for every month
 * or this month only, and what used it. Fixed-cost categories are a group of
 * their own: expected (their budget, else what they usually are) against what
 * was paid. Figures from lib/budgets.ts.
 */
export function BudgetsScreen({ config, rows, onConfig, onClose, initialMonth, today: given }: {
  config: Config;
  rows: LocalRow[];
  onConfig: (c: Config) => void;
  onClose: () => void;
  initialMonth?: string;
  today?: string;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const money = (n: number) => formatMoney(n, currency, locale);
  const current = periodOf(given ?? todayOf());
  const [month, setMonth] = useState(initialMonth ?? current);
  const [editing, setEditing] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [scope, setScope] = useState<"every" | "month">("every");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manage = canManage(config);
  const outside = useMemo(() => outsideTotals(config.categories, config.accounts), [config.categories, config.accounts]);
  const txs = useMemo(() => counted(rows), [rows]);
  const view = useMemo(() => budgetsView(txs, config.categories, config.budgets, month, config.trips ?? [], outside), [txs, config.categories, config.budgets, config.trips, month, outside]);
  const previous = shiftPeriod(month, -1);
  const previousHas = budgetsForMonth(config.budgets, previous).size > 0;
  const hasAny = view.total !== null;
  const monthName = monthLabel(month, locale);

  function open(l: BudgetLine) {
    if (!manage) return;
    if (editing === l.category.id) {
      setEditing(null);
      return;
    }
    setEditing(l.category.id);
    setScope(l.source === "month" ? "month" : "every");
    const shown = l.source === "month" ? l.monthMinor : l.everyMinor;
    setTyped(shown ? (shown / 10 ** requireCurrency(currency).minorUnits).toFixed(requireCurrency(currency).minorUnits) : "");
    setError(null);
  }

  async function save(categoryId: string, amountMinor: number, what: string) {
    setBusy(true);
    setError(null);
    try {
      const b = budgetToSave(config.budgets, categoryId, scope === "every" ? "every" : month, amountMinor, randomId);
      onConfig(await api.budgetUpsert(config.household.id, b));
      setEditing(null);
      setNotice(what);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyPrevious() {
    setBusy(true);
    setError(null);
    try {
      onConfig(await api.budgetCopy(config.household.id, previous, month));
      setNotice(`Copied the budgets of ${monthLabel(previous, locale)} to ${monthName}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const editor = (l: BudgetLine) => {
    const minor = parseTyped(typed || "0", requireCurrency(currency), "dot");
    const name = l.category.name;
    return (
      <div className="px-5 py-3 bg-paper-high border-b border-line grid gap-3" data-testid="budget-editor">
        <label className="block">
          <span className="t-label text-ink-muted">{scope === "every" ? "Monthly budget" : `Budget for ${monthName} only`}</span>
          <input className={`${inputClass} mt-1`} inputMode="decimal" autoFocus value={typed} placeholder="0.00" data-testid="budget-amount"
            onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="flex gap-2">
          <Chip label="Every month" selected={scope === "every"} onClick={() => setScope("every")} testId="scope-every" />
          <Chip label={`${monthName} only`} selected={scope === "month"} onClick={() => setScope("month")} testId="scope-month" />
        </div>
        <p className="t-label text-ink-muted">
          Every month: {l.everyMinor ? money(l.everyMinor) : "none"} · {monthName}: {l.monthMinor !== null ? (l.monthMinor ? money(l.monthMinor) : "none this month") : "follows every month"}
          {l.category.parent_id ? " · a smaller limit inside its category" : l.subs.length ? " · includes its subcategories" : ""}
        </p>
        {minor === null && <p className="t-secondary text-danger">That is not an amount</p>}
        <div className="grid grid-cols-2 gap-2">
          <SecondaryButton onClick={() => void save(l.category.id, 0, scope === "every" ? `Removed the budget of ${name}.` : `No budget for ${name} in ${monthName}.`)}>
            {scope === "every" ? "Remove" : "None this month"}
          </SecondaryButton>
          <PrimaryButton busy={busy} disabled={minor === null || !(minor > 0)} testId="budget-save"
            onClick={() => minor !== null && void save(l.category.id, minor, `Saved ${money(minor)} for ${name}${scope === "every" ? " every month" : ` in ${monthName}`}.`)}>
            Save
          </PrimaryButton>
        </div>
        {error && <p className="t-secondary text-danger">{error}</p>}
      </div>
    );
  };

  const row = (l: BudgetLine, kind: "fixed" | "everyday" | "none", indent = false) => {
    const c = l.category;
    const expected = kind === "fixed" ? expectedMinor(l) : null;
    const status = kind === "fixed" ? (expected !== null ? budgetStatus(expected, l.usedMinor) : null) : l.status;
    const tone = kind === "fixed" ? fixedTone(l) : l.status ? categoryTone(l.status, l.category.fixed) : undefined;
    const context =
      kind === "fixed"
        ? expected !== null
          ? `${l.limitMinor === null ? "usually" : "expected"} ${money(expected)} · paid ${money(l.usedMinor)}${l.limitMinor === null && l.usedMinor > expected ? ", more than usual" : ""}`
          : `paid ${money(l.usedMinor)} · no budget`
        : l.status ? budgetWords(l.status, money) : l.usualMinor > 0 ? `usually ${money(l.usualMinor)}` : "no budget";
    return (
      <div key={c.id}>
        <button type="button" onClick={() => open(l)} disabled={!manage} data-testid={`budget-row-${kind}`} data-category={c.name}
          className={`w-full flex items-center gap-4 ${indent ? "pl-[76px]" : "pl-5"} pr-5 py-3 border-b border-line text-left yields disabled:cursor-default`}>
          {!indent && (
            <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-paper-high">
              <Icon name={c.icon} color={categoryColor(c.color_index)} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className={`${indent ? "t-secondary" : "t-body"} truncate`}>{c.name}</div>
            <div className={`t-secondary ${kind === "none" ? "text-ink-muted" : toneText(status, tone)}`}>
              {context}{l.source === "month" ? " · this month only" : ""}
            </div>
            {status && <ProgressLine status={status} tone={tone} muted={kind === "fixed" && l.limitMinor === null} testId="budget-row-line" />}
          </div>
          <div className={`t-amount shrink-0 ${l.limitMinor === null ? "text-ink-muted" : ""}`}>
            {l.limitMinor !== null ? money(l.limitMinor) : manage ? "Set" : "—"}
          </div>
        </button>
        {editing === c.id && editor(l)}
      </div>
    );
  };

  /** A category and its subcategories: those with a budget always, the rest while the family is open, to give one a smaller limit. */
  const family = (l: BudgetLine, kind: "fixed" | "everyday" | "none") => {
    const opened = editing === l.category.id || l.subs.some((s) => s.category.id === editing);
    return [
      row(l, kind),
      ...l.subs.filter((s) => s.limitMinor !== null || opened).map((s) => row(s, s.limitMinor !== null ? "everyday" : "none", true)),
    ];
  };

  return (
    <div data-testid="budgets-screen">
      <ScreenHeader title="Budgets" end={<button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>} />
      <div className="flex items-center justify-between px-3">
        <button type="button" aria-label="Previous month" className="yields p-2" onClick={() => { setMonth(shiftPeriod(month, -1)); setEditing(null); }}><ChevronLeft size={22} /></button>
        <div className="t-section" data-testid="budgets-month">{monthName}</div>
        <button type="button" aria-label="Next month" className="yields p-2 disabled:opacity-30" disabled={month > current} onClick={() => { setMonth(shiftPeriod(month, 1)); setEditing(null); }}>
          <ChevronRight size={22} />
        </button>
      </div>
      <p className="t-secondary text-ink-muted px-5 pt-2">
        A monthly amount per category, its subcategories included; a subcategory&apos;s budget is a smaller limit inside it. Transfers, investment accounts and grants are not spending.
      </p>
      {hasAny && <div className="pt-2"><BudgetBar status={view.total} money={money} /></div>}
      {notice && <p className="t-label text-ink-muted px-5 pt-2" data-testid="budgets-notice">{notice}</p>}
      {!manage && <p className="t-secondary text-ink-muted px-5 pt-2">Only the household&apos;s owners and admins can change budgets.</p>}
      {manage && previousHas && (
        <button type="button" onClick={() => void copyPrevious()} disabled={busy} data-testid="budgets-copy"
          className="w-full flex items-center gap-3 px-5 py-3 border-b border-line text-left yields">
          <Copy size={18} className="text-ink-muted" aria-hidden />
          <span className="t-body">Copy the budgets of {monthLabel(previous, locale)}</span>
        </button>
      )}
      {!hasAny && (
        <EmptyState title="No budgets yet" text="Tap a category below to give it a monthly amount. The Overview then shows how much of it is used: amber from 80 %, red once over." />
      )}
      {view.fixed.length > 0 && (
        <>
          <Section>Fixed costs</Section>
          {view.fixed.map((l) => family(l, "fixed"))}
        </>
      )}
      {view.everyday.length > 0 && (
        <>
          <Section>Everyday</Section>
          {view.everyday.map((l) => family(l, "everyday"))}
        </>
      )}
      {view.unbudgeted.length > 0 && (
        <>
          <Section>No budget yet</Section>
          {view.unbudgeted.map((l) => family(l, "none"))}
        </>
      )}
      <div className="h-8" />
    </div>
  );
}
