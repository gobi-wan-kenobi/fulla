// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronLeft, ChevronRight, Flag, Plus, Scissors } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type GoalsBundle } from "@/lib/api";
import { type Goal, type GoalProgress, budgetFit, goalProblem, goalProgress, suggestions } from "@/lib/goals";
import { randomId } from "@/lib/ids";
import { counted, today as todayOf } from "@/lib/ledger";
import { accountTypeLabel, outsideTotals, type Config } from "@/lib/model";
import { formatMoney, parseTyped, requireCurrency } from "@/lib/money";
import type { BalanceSnapshot } from "@/lib/overview";
import { canManage } from "@/lib/rules";
import type { LocalRow } from "@/lib/sync";
import { Chip, EmptyState, Field, PrimaryButton, ScreenHeader, Section, SecondaryButton, inputClass } from "./Pieces";

function dayLabel(date: string, locale: string, year = true): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** A share as a whole percent; a small one reads "under 1 %" rather than 0. */
function percent(f: number): string {
  return f > 0 && f < 0.005 ? "<1 %" : `${Math.round(f * 100)} %`;
}
function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

const STATUS: Record<GoalProgress["status"], { text: string; tone: string }> = {
  done: { text: "Reached", tone: "bg-highlight text-on-highlight" },
  on_track: { text: "On track", tone: "bg-highlight/25 text-ink" },
  behind: { text: "Behind", tone: "bg-danger/15 text-danger" },
  new: { text: "Just started", tone: "bg-line text-ink" },
  no_balance: { text: "No balance yet", tone: "bg-warning/15 text-warning" },
};

function StatusChip({ p }: { p: GoalProgress }) {
  const s = STATUS[p.status];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 t-label ${s.tone}`} data-testid="goal-status">{s.text}</span>;
}

function Bar({ fraction }: { fraction: number }) {
  return (
    <div className="h-2.5 rounded-full bg-line overflow-hidden mt-2">
      <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.round(fraction * 100))}%`, background: "linear-gradient(90deg, var(--in-surface), var(--in-body))" }} />
    </div>
  );
}

/**
 * Goals: the list, one goal's page, and the editor. A goal's progress, pace
 * and monthly target, and where the household's discretionary spending could
 * give way, come from lib/goals.ts. Admins create and change goals; any member
 * records a contribution towards one with no account.
 */
export function GoalsScreen({ config, rows, snapshots: givenSnapshots, bundle: givenBundle, today: givenToday, initialGoal, initialEdit, onAccount, onClose }: {
  config: Config;
  rows: LocalRow[];
  snapshots?: BalanceSnapshot[];
  bundle?: GoalsBundle;
  today?: string;
  initialGoal?: string;
  initialEdit?: boolean;
  onAccount?: (id: string) => void;
  onClose?: () => void;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const units = requireCurrency(currency).minorUnits;
  const money = (n: number) => formatMoney(n, currency, locale);
  const today = givenToday ?? todayOf();
  const manage = canManage(config);
  const [snapshots, setSnapshots] = useState<BalanceSnapshot[]>(givenSnapshots ?? []);
  const [bundle, setBundle] = useState<GoalsBundle | null>(givenBundle ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (givenSnapshots && givenBundle) return;
    let live = true;
    if (!givenSnapshots) api.balanceSnapshots(config.household.id).then((s) => live && setSnapshots(s), () => undefined);
    if (!givenBundle) api.goals(config.household.id).then((b) => live && setBundle(b), (e) => live && (setBundle({ goals: [], contributions: [] }), setError(e instanceof Error ? e.message : String(e))));
    return () => { live = false; };
  }, [config.household.id, givenSnapshots, givenBundle]);
  const [selected, setSelected] = useState<string | null>(initialGoal ?? null);
  const [editing, setEditing] = useState<Goal | string | null>(initialEdit ? initialGoal ?? "new" : null);
  const txs = useMemo(() => counted(rows), [rows]);
  const outside = useMemo(() => outsideTotals(config.categories, config.accounts), [config.categories, config.accounts]);
  const goals = (bundle?.goals ?? []).filter((g) => !g.archived);
  const progress = (g: Goal) => goalProgress(g, config, txs, snapshots, bundle?.contributions ?? [], today);
  const editingGoal = editing === "new" ? null : typeof editing === "string" ? goals.find((g) => g.id === editing) ?? null : editing;

  if (editing) {
    return <GoalEditor config={config} goal={editingGoal} today={today} txs={txs} snapshots={snapshots}
      onSaved={(b, id) => { setBundle(b); setEditing(null); setSelected(id); }} onCancel={() => setEditing(null)} />;
  }

  const goal = selected ? goals.find((g) => g.id === selected) : undefined;
  if (goal) {
    const p = progress(goal);
    const sug = suggestions(txs, config.categories, p.requiredMonthlyMinor, today, outside);
    const fit = budgetFit(txs, config, p.requiredMonthlyMinor, today, outside);
    const account = goal.account_id ? config.accounts.find((a) => a.id === goal.account_id) : undefined;
    const contributions = (bundle?.contributions ?? []).filter((c) => c.goal_id === goal.id).slice().reverse();
    return (
      <div data-testid="goal-screen">
        <ScreenHeader title={goal.name} end={<button type="button" onClick={() => setSelected(null)} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>} />
        <div className="px-5">
          <div className="flex items-center gap-2"><StatusChip p={p} />
            <span className="t-secondary text-ink-muted">{goal.target_date ? `by ${dayLabel(goal.target_date, locale)}` : `${money(goal.monthly_minor ?? 0)} a month`}</span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-[36px] leading-[42px] font-semibold" style={{ fontStretch: "88%" }} data-testid="goal-saved">{money(p.savedMinor)}</span>
            <span className="t-secondary text-ink-muted">of {money(goal.target_minor)}</span>
          </div>
          <Bar fraction={p.fraction} />
          <div className="t-label text-ink-muted mt-1">{Math.round(p.fraction * 100)} % · {money(p.remainingMinor)} to go</div>
        </div>

        <div className="grid grid-cols-2 gap-2 px-5 mt-4">
          <div className="rounded-2xl bg-paper-high p-3" data-testid="goal-required">
            <div className="t-label text-ink-muted">{goal.target_date ? "Needed a month" : "Planned a month"}</div>
            <div className="t-title mt-1">{money(p.requiredMonthlyMinor)}</div>
            {p.monthsLeft !== null && p.remainingMinor > 0 && <div className="t-label text-ink-muted">{Math.max(0, Math.round(p.monthsLeft))} months left</div>}
          </div>
          <div className="rounded-2xl bg-paper-high p-3" data-testid="goal-pace">
            <div className="t-label text-ink-muted">Pace so far</div>
            <div className="t-title mt-1">{p.paceMinor === null ? "—" : `${money(p.paceMinor)}`}</div>
            <div className="t-label text-ink-muted">{p.paceMinor === null ? "after a month" : "a month since the start"}</div>
          </div>
        </div>
        <p className="t-secondary text-ink-muted px-5 mt-3" data-testid="goal-projection">
          {p.status === "done" ? "Reached. Well done."
            : p.status === "no_balance" ? `${account?.name ?? "The account"} has no statement or opening balance yet: import one and its balance is the progress.`
            : p.projectedDate ? `At this pace: ${dayLabel(p.projectedDate, locale)}${goal.target_date ? (p.projectedDate <= goal.target_date ? ", before the target date." : `, after the target date: ${money(p.requiredMonthlyMinor)} a month is what reaches it.`) : "."}`
            : p.paceMinor === null ? "The pace shows once a month has gone by since the start." : "No progress since the start yet, so no finish date."}
        </p>
        <p className="t-label text-ink-muted px-5 mt-1">
          {account ? <>Progress is {account.name} ({accountTypeLabel(account.type)}), as Balances shows it.</> : <>Progress is the start amount plus what is recorded below.</>}
          {" "}Started {dayLabel(goal.start_date, locale)} at {money(goal.start_minor)}.
        </p>

        {fit && (
          <>
            <Section>With your budgets</Section>
            <div className="px-5" data-testid="goal-budget-fit">
              {[["Income, a month", fit.incomeMinor], ["Budgets", -fit.budgetsMinor], ["Fixed costs without a budget", -fit.fixedMinor]].map(([k, v]) => (
                <div key={k as string} className="flex justify-between t-secondary py-0.5"><span className="text-ink-muted">{k}</span><span>{money(v as number)}</span></div>
              ))}
              <div className="flex justify-between t-body font-semibold border-t border-line mt-1 pt-1"><span>Left</span><span>{money(fit.leftMinor)}</span></div>
              <p className={`t-secondary mt-1 ${fit.fits ? "text-ink-muted" : "text-warning"}`}>
                {fit.fits ? `Room for the ${money(fit.requiredMonthlyMinor)} a month the goal needs.` : `${money(fit.requiredMonthlyMinor - fit.leftMinor)} a month short of what the goal needs.`}
              </p>
            </div>
          </>
        )}

        <Section>Where it could come from</Section>
        <div data-testid="goal-suggestions">
          {sug.items.length === 0 ? (
            <p className="t-secondary text-ink-muted px-5">Nothing to point at yet: no eating out, leisure or shopping recorded in the months used.</p>
          ) : (
            <>
              <p className={`t-secondary px-5 ${sug.rough ? "text-warning" : "text-ink-muted"}`} data-testid="goal-suggestions-basis">
                {sug.rough ? `Rough: from ${sug.months.map((m) => monthLabel(m, locale)).join(", ")} only.` : `From ${sug.months.length} months: ${sug.months.slice().reverse().map((m) => monthLabel(m, locale)).join(", ")}.`}
                {" "}Fixed costs, housing and debt payments are never counted.
              </p>
              {sug.items.map((s) => (
                <div key={s.categoryId} className="flex items-center gap-4 px-5 py-3 border-b border-line" data-testid="goal-suggestion">
                  <Scissors size={20} className="text-ink-muted shrink-0" aria-hidden />
                  <div className="flex-1 min-w-0">
                    <div className="t-body">{s.name}: {money(s.cutMinor)} less a month</div>
                    <div className="t-secondary text-ink-muted">{Math.round(s.share * 100)} % of the usual {money(s.averageMinor)}</div>
                  </div>
                  {s.covers !== null && <div className="t-amount text-money-in shrink-0">{percent(s.covers)}</div>}
                </div>
              ))}
              <p className="t-secondary text-ink-muted px-5 py-2" data-testid="goal-suggestions-total">
                Together {money(sug.totalCutMinor)} a month{sug.covers !== null ? `: ${percent(sug.covers)} of the ${money(p.requiredMonthlyMinor)} the goal needs` : ""}.
              </p>
            </>
          )}
        </div>

        {!account && <Contributions config={config} goal={goal} list={contributions} today={today} money={money} units={units} locale={locale} onSaved={setBundle} />}
        {account && onAccount && (
          <button type="button" onClick={() => onAccount(account.id)} className="w-full flex items-center gap-4 px-5 py-3 border-y border-line mt-3 text-left yields">
            <div className="flex-1 t-body">{account.name}</div><ChevronRight size={18} className="text-ink-muted" />
          </button>
        )}
        {manage && (
          <div className="px-5 py-4 grid gap-2">
            <SecondaryButton onClick={() => setEditing(goal)}>Edit goal</SecondaryButton>
            <SecondaryButton danger onClick={async () => {
              try { setBundle(await api.goalUpsert(config.household.id, { ...goal, archived: true })); setSelected(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            }}>Archive goal</SecondaryButton>
          </div>
        )}
        {error && <p className="t-secondary text-danger px-5">{error}</p>}
      </div>
    );
  }

  return (
    <div data-testid="goals-screen">
      <ScreenHeader title="Goals" end={onClose && <button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>} />
      {bundle === null ? <p className="t-secondary text-ink-muted px-5">Loading…</p> : goals.length === 0 ? (
        <EmptyState title="No goals yet" text="Set one, like $100,000 by a date or $500 a month, and Fulla works out the monthly amount and where your spending could give way.">
          {manage && <PrimaryButton onClick={() => setEditing("new")} testId="goal-new">Create a goal</PrimaryButton>}
        </EmptyState>
      ) : (
        <>
          {goals.map((g) => {
            const p = progress(g);
            return (
              <button key={g.id} type="button" onClick={() => setSelected(g.id)} data-testid="goal-row" className="w-full text-left px-5 py-4 border-b border-line yields">
                <div className="flex items-center gap-3">
                  <Flag size={20} className="text-ink-muted shrink-0" aria-hidden />
                  <div className="flex-1 min-w-0 t-body truncate">{g.name}</div>
                  <StatusChip p={p} />
                  <ChevronRight size={18} className="text-ink-muted shrink-0" />
                </div>
                <Bar fraction={p.fraction} />
                <div className="flex flex-wrap justify-between gap-x-3 t-secondary text-ink-muted mt-1">
                  <span className="whitespace-nowrap">{money(p.savedMinor)} of {money(g.target_minor)}</span>
                  <span className="whitespace-nowrap">{p.remainingMinor > 0 ? `${money(p.requiredMonthlyMinor)} a month${g.target_date ? ` · by ${dayLabel(g.target_date, locale, true)}` : ""}` : "reached"}</span>
                </div>
              </button>
            );
          })}
          {manage && (
            <button type="button" onClick={() => setEditing("new")} data-testid="goal-new" className="w-full flex items-center gap-3 px-5 py-4 text-left yields t-body">
              <Plus size={20} className="text-ink-muted" aria-hidden /> New goal
            </button>
          )}
        </>
      )}
      {error && <p className="t-secondary text-danger px-5">{error}</p>}
    </div>
  );
}

function Contributions({ config, goal, list, today, money, units, locale, onSaved }: {
  config: Config; goal: Goal; list: GoalsBundle["contributions"]; today: string; money: (n: number) => string; units: number; locale: string; onSaved: (b: GoalsBundle) => void;
}) {
  const [typed, setTyped] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const minor = parseTyped(typed, requireCurrency(config.household.currency), "dot");
    if (!minor) { setError("Type an amount"); return; }
    setBusy(true); setError(null);
    try {
      onSaved(await api.goalContributionSave(config.household.id, { id: randomId(), goal_id: goal.id, date, amount_minor: minor, note: "" }));
      setTyped("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <Section>Put towards it</Section>
      <div className="px-5 grid grid-cols-[1fr_auto] gap-2" data-testid="goal-contribute">
        <input className={inputClass} inputMode="decimal" placeholder={(0).toFixed(units)} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Amount" />
        <input className={`${inputClass} w-40`} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      </div>
      <div className="px-5 mt-2"><PrimaryButton onClick={add} busy={busy} testId="goal-contribute-add">Add</PrimaryButton></div>
      {error && <p className="t-secondary text-danger px-5 mt-1">{error}</p>}
      {list.map((c) => (
        <div key={c.id} className="flex justify-between px-5 py-2 border-b border-line t-secondary" data-testid="goal-contribution">
          <span className="text-ink-muted">{dayLabel(c.date, locale)}{c.note ? ` · ${c.note}` : ""}</span>
          <span className={c.amount_minor < 0 ? "text-money-out" : "text-money-in"}>{money(c.amount_minor)}</span>
        </div>
      ))}
    </>
  );
}

function GoalEditor({ config, goal, today, txs, snapshots, onSaved, onCancel }: {
  config: Config; goal: Goal | null; today: string; txs: ReturnType<typeof counted>; snapshots: BalanceSnapshot[];
  onSaved: (b: GoalsBundle, id: string) => void; onCancel: () => void;
}) {
  const currency = requireCurrency(config.household.currency);
  const show = (n: number | null | undefined) => (n ? (n / 10 ** currency.minorUnits).toFixed(currency.minorUnits) : "");
  const parse = (s: string) => (s.trim() ? parseTyped(s, currency, "dot") : null);
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(show(goal?.target_minor));
  const [byDate, setByDate] = useState(goal ? !!goal.target_date : true);
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? "");
  const [monthly, setMonthly] = useState(show(goal?.monthly_minor));
  const [accountId, setAccountId] = useState(goal?.account_id ?? "");
  const [start, setStart] = useState(show(goal?.start_minor));
  const [startDate, setStartDate] = useState(goal?.start_date ?? today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = config.accounts.filter((a) => !a.archived && a.type !== "credit_card");
  const draft: Goal = {
    id: goal?.id ?? "", name: name.trim(), target_minor: parse(target) ?? 0, target_date: byDate ? targetDate || null : null,
    monthly_minor: byDate ? null : parse(monthly), account_id: accountId || null, start_minor: parse(start) ?? 0, start_date: startDate, archived: false,
  };
  const problem = goalProblem(draft);
  const pickAccount = (id: string) => {
    setAccountId(id);
    if (id && !goal) {
      const p = goalProgress({ ...draft, account_id: id, target_minor: 1, target_date: null, monthly_minor: 1 }, config, txs, snapshots, [], today);
      setStart(show(p.savedMinor));
    }
  };
  const save = async () => {
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    const id = goal?.id ?? randomId();
    try { onSaved(await api.goalUpsert(config.household.id, { ...draft, id }), id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div data-testid="goal-editor">
      <ScreenHeader title={goal ? "Edit goal" : "New goal"} end={<button type="button" onClick={onCancel} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>} />
      <Field label="Name"><input className={inputClass} value={name} maxLength={60} placeholder="House deposit" onChange={(e) => setName(e.target.value)} data-testid="goal-name" /></Field>
      <Field label="Target"><input className={inputClass} inputMode="decimal" value={target} placeholder="100000" onChange={(e) => setTarget(e.target.value)} data-testid="goal-target" /></Field>
      <div className="px-5 py-2 flex gap-2">
        <Chip label="By a date" selected={byDate} onClick={() => setByDate(true)} testId="goal-by-date" />
        <Chip label="A monthly amount" selected={!byDate} onClick={() => setByDate(false)} testId="goal-by-month" />
      </div>
      {byDate
        ? <Field label="Target date"><input className={inputClass} type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} data-testid="goal-date" /></Field>
        : <Field label="Each month"><input className={inputClass} inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} data-testid="goal-monthly" /></Field>}
      <Field label="Progress from">
        <select className={inputClass} value={accountId} onChange={(e) => pickAccount(e.target.value)} data-testid="goal-account">
          <option value="">What I record towards it</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({accountTypeLabel(a.type)})</option>)}
        </select>
      </Field>
      <Field label={accountId ? "The account held, at the start" : "Already saved"}><input className={inputClass} inputMode="decimal" value={start} placeholder="0" onChange={(e) => setStart(e.target.value)} data-testid="goal-start" /></Field>
      <Field label="Start"><input className={inputClass} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
      <p className="t-label text-ink-muted px-5">Fulla never moves money or adds a transaction for a goal.</p>
      {error && <p className="t-secondary text-danger px-5 mt-1">{error}</p>}
      <div className="px-5 py-4"><PrimaryButton onClick={save} busy={busy} disabled={!!problem} testId="goal-save">{goal ? "Save" : "Create goal"}</PrimaryButton></div>
    </div>
  );
}
