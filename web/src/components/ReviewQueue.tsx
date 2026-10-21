// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { categoriesFor } from "@/lib/ledger";
import type { Config, Transaction } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import { decideGroup, reviewGroups, type ReviewGroup, type SuggestionSource } from "@/lib/reviewQueue";
import { canManage, newRule } from "@/lib/rules";
import type { LocalRow } from "@/lib/sync";

const SOURCE: Record<SuggestionSource, string> = {
  rule: "by your rule",
  merchant: "Fulla's known-merchant list",
  debt: "a debt repayment",
  categorizer: "the categorizer's guess",
  history: "what you chose before",
};

function shortDate(date: string, locale: string, year: boolean): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function dateRange(first: string, last: string, locale: string): string {
  if (first === last) return shortDate(first, locale, true);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${shortDate(first, locale, !sameYear)} – ${shortDate(last, locale, true)}`;
}

/**
 * Review, one card per merchant (reviewQueue.ts): what it is, how many lines,
 * their total and dates, and a suggested category. One decision sorts every
 * line and saves a rule so the next ones are sorted; "just these lines" saves
 * none. For a person, a rule is only saved if you ask for one.
 */
export function ReviewQueue({ config, rows, allRows, onBulk, onConfig, onOpen }: {
  config: Config;
  rows: LocalRow[];
  allRows: LocalRow[];
  onBulk: (changes: { tx: Transaction; existing: LocalRow }[]) => Promise<number>;
  onConfig?: (c: Config) => void;
  onOpen: (row: LocalRow) => void;
}) {
  const groups = useMemo(
    () => reviewGroups(rows, config.categories, config.categorization_rules ?? [], allRows.map((r) => r.tx)),
    [rows, allRows, config.categories, config.categorization_rules],
  );
  const [note, setNote] = useState<string | null>(null);
  if (groups.length === 0) return note ? <p className="t-label text-ink-muted px-5 pt-2" data-testid="review-done">{note}</p> : null;
  const lines = groups.reduce((a, g) => a + g.count, 0);
  return (
    <div className="px-4 pt-2 grid gap-3" data-testid="review-queue">
      <div className="t-section text-ink-muted uppercase px-1" data-testid="review-summary">
        {lines} {lines === 1 ? "line" : "lines"} · {groups.length} {groups.length === 1 ? "merchant" : "merchants"}
      </div>
      {note && <p className="t-label text-ink-muted px-1" data-testid="review-done">{note}</p>}
      {groups.map((g) => (
        <GroupCard key={g.id} group={g} config={config} onBulk={onBulk} onConfig={onConfig} onOpen={onOpen} onDone={setNote} />
      ))}
    </div>
  );
}

function GroupCard({ group: g, config, onBulk, onConfig, onOpen, onDone }: {
  group: ReviewGroup<LocalRow>;
  config: Config;
  onBulk: (changes: { tx: Transaction; existing: LocalRow }[]) => Promise<number>;
  onConfig?: (c: Config) => void;
  onOpen: (row: LocalRow) => void;
  onDone: (note: string) => void;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = g.side === "in" ? "income" : "expense";
  const choices = categoriesFor(config, kind);
  const [chosen, setChosen] = useState(g.suggestion?.category.id ?? "");
  const category = config.categories.find((c) => c.id === chosen) ?? null;
  const ruleable = !!g.rulePattern && !!onConfig && canManage(config);
  const account = (id: string | null) => config.accounts.find((a) => a.id === id)?.name ?? "";
  const n = g.count;
  const linesWord = `${n} ${n === 1 ? "line" : "lines"}`;

  async function decide(withRule: boolean) {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      const { changes } = decideGroup(g, category);
      const saved = await onBulk(changes);
      let ruled = false;
      if (withRule && ruleable) {
        onConfig!(await api.ruleUpsert(config.household.id, newRule(config, g.rulePattern!, category.id)));
        ruled = true;
      }
      // Never the person's name: this note is about the group, whoever it is.
      const what = g.person ? "this person" : `“${g.rulePattern}”`;
      onDone(`Sorted ${saved} ${saved === 1 ? "line" : "lines"} into ${category.name}${ruled ? `; a rule now sorts ${what} next time` : ""}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const s = g.suggestion;
  const sure = s ? Math.round(s.confidence * 100) : 0;
  return (
    <section className="rounded-2xl border border-line bg-paper-high overflow-hidden" data-testid="review-group" data-group={g.id} data-person={g.person ? "yes" : "no"}>
      <button type="button" className="yields w-full text-left px-4 pt-4 pb-3 flex gap-3 items-start" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="review-group-toggle">
        <div className="flex-1 min-w-0">
          <div className="t-body font-semibold truncate" data-testid="review-group-label">{g.label}</div>
          <div className="t-secondary text-ink-muted">
            <span data-testid="review-group-count">{linesWord}</span> · {dateRange(g.firstDate, g.lastDate, locale)}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`t-amount ${g.side === "in" ? "text-money-in" : "text-ink"}`} data-testid="review-group-total">
            {formatMoney(g.totalMinor, currency, locale, g.side === "in")}
          </div>
          <div className="text-ink-muted inline-flex items-center gap-1 t-label">
            {open ? "Hide" : "Lines"} {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </div>
      </button>
      <div className="px-4 pb-3">
        {s ? (
          <div className="inline-flex items-center gap-1.5 rounded-lg bg-paper border border-line px-2.5 py-1 t-label" data-testid="review-group-suggestion">
            <Sparkles size={14} className="text-money-in" />
            <span className="text-ink font-semibold">{s.category.name}</span>
            <span className="text-ink-muted">· {sure}% sure · {SOURCE[s.source]}</span>
          </div>
        ) : (
          <div className="t-label text-ink-muted" data-testid="review-group-suggestion">No suggestion: pick a category.</div>
        )}
      </div>
      {open && (
        <div className="border-t border-line bg-paper" data-testid="review-group-lines">
          {g.rows.map((r) => (
            <button key={r.tx.id} type="button" onClick={() => onOpen(r)} className="yields w-full flex items-center gap-3 px-4 py-2.5 border-b border-line text-left last:border-b-0" data-testid="review-line">
              <div className="flex-1 min-w-0">
                <div className="t-secondary truncate">{r.tx.note}</div>
                <div className="t-label text-ink-muted">{shortDate(r.tx.date, locale, true)} · {account(r.tx.account_id)}</div>
              </div>
              <div className={`t-secondary ${r.tx.kind === "expense" ? "text-ink" : "text-money-in"}`}>
                {formatMoney(r.tx.amount_minor, currency, locale, r.tx.kind !== "expense")}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="px-4 py-3 border-t border-line grid gap-2">
        <select data-testid="review-group-category" aria-label="Category" className="w-full h-11 px-3 rounded-xl border border-line bg-paper text-ink t-body" value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={busy}>
          <option value="">Choose a category…</option>
          {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {g.person ? (
          <>
            <button type="button" data-testid="review-group-lines-only" disabled={!category || busy} onClick={() => void decide(false)}
              className="yields h-11 rounded-xl bg-accent text-on-accent t-body font-semibold disabled:opacity-40">
              {busy ? "…" : `Sort ${n === 1 ? "this line" : `these ${n} lines`}`}
            </button>
            {ruleable && (
              <button type="button" data-testid="review-group-apply" disabled={!category || busy} onClick={() => void decide(true)}
                className="yields h-10 rounded-xl border border-line t-secondary text-ink disabled:opacity-40">
                Sort and save a rule for this person
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" data-testid="review-group-apply" disabled={!category || busy} onClick={() => void decide(ruleable)}
              className="yields h-11 rounded-xl bg-accent text-on-accent t-body font-semibold disabled:opacity-40">
              {busy ? "…" : ruleable ? `Sort all ${n} and remember` : `Sort ${n === 1 ? "this line" : `all ${n}`}`}
            </button>
            {ruleable && (
              <button type="button" data-testid="review-group-lines-only" disabled={!category || busy} onClick={() => void decide(false)}
                className="yields h-10 rounded-xl border border-line t-secondary text-ink disabled:opacity-40">
                Just these lines, no rule
              </button>
            )}
          </>
        )}
        {ruleable && !g.person && category && (
          <p className="t-label text-ink-muted" data-testid="review-group-rule">Remember: lines containing “{g.rulePattern}” go to {category.name}.</p>
        )}
        {g.person && <p className="t-label text-ink-muted">Money with a person: no rule unless you ask, since each one can be for something different.</p>}
        {error && <p className="t-label text-danger">{error}</p>}
      </div>
    </section>
  );
}
