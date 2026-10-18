// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { Check, ChevronLeft, ChevronRight, CloudOff, ListChecks, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { byDay, categoriesFor, monthOf, monthSpendingSplit, monthTotals, recategorized, shiftMonth, signedAmount, today, withRecurrence } from "@/lib/ledger";
import { countsInTotals, outsideTotals, type Config, type Transaction } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { isUnmatchedTransfer, needsReview, UNMATCHED_TAG, withoutTag } from "@/lib/review";
import { normalizeName } from "@/lib/text";
import { Avatar, Chip, EmptyState, ScreenHeader } from "./Pieces";

type Filter = "all" | "spending" | "income" | "transfers" | "review";

function dayLabel(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d))).toUpperCase();
}

function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** The month's rows by day, as the Android History: search, filter chips, a row per transaction. */
export function HistoryScreen({ config, rows, syncing, error, onOpen, onRefresh, onBulk }: {
  config: Config;
  rows: LocalRow[];
  syncing: boolean;
  error: string | null;
  onOpen: (row: LocalRow) => void;
  onRefresh: () => void;
  onBulk?: (changes: { tx: Transaction; existing: LocalRow }[]) => Promise<number>;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const [month, setMonth] = useState(monthOf(today()));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const category = (id: string | null) => config.categories.find((c) => c.id === id);
  const account = (id: string | null) => config.accounts.find((a) => a.id === id)?.name;
  const member = (id: string | null) => config.members.find((m) => m.id === id);

  const filtered = useMemo(() => {
    const q = normalizeName(query);
    return rows.filter((r) => {
      const k = r.tx.kind;
      if (filter === "spending" && k !== "expense" && k !== "refund") return false;
      if (filter === "income" && k !== "income") return false;
      if (filter === "transfers" && k !== "transfer" && k !== "settlement") return false;
      if (filter === "review" && !needsReview(r.tx) && !isUnmatchedTransfer(r.tx)) return false;
      if (!q) return true;
      return normalizeName(`${r.tx.note} ${category(r.tx.category_id)?.name ?? ""}`).includes(q);
    });
  }, [rows, filter, query]); // eslint-disable-line react-hooks/exhaustive-deps
  // Review is every month at once: what is waiting should not hide in an earlier month.
  const days = useMemo(
    () => (filter === "review" ? [...new Set(filtered.map((r) => monthOf(r.tx.date)))].sort().reverse().flatMap((m) => byDay(filtered, m)) : byDay(filtered, month)),
    [filtered, month, filter],
  );
  const waiting = useMemo(() => ({
    review: rows.filter((r) => needsReview(r.tx)).length,
    unmatched: rows.filter((r) => isUnmatchedTransfer(r.tx)).length,
  }), [rows]);
  const outside = useMemo(() => outsideTotals(config.categories, config.accounts), [config.categories, config.accounts]);
  const totals = useMemo(() => monthTotals(rows, month, outside), [rows, month, outside]);
  const split = useMemo(() => monthSpendingSplit(rows, month, outside), [rows, month, outside]);
  const chosenRows = rows.filter((r) => selected.has(r.tx.id));
  const bulkKinds = new Set(chosenRows.map((r) => r.tx.kind));
  const bulkChoices = config.categories
    .filter((c) => !c.archived && [...bulkKinds].every((k) => categoriesFor(config, k).some((x) => x.id === c.id)))
    .sort((a, b) => a.sort - b.sort);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setBulkCategory("");
  };

  async function bulk(make: (t: Transaction) => Transaction | null, what: (n: string) => string) {
    if (!onBulk) return;
    setBulkBusy(true);
    try {
      const changes = chosenRows.map((r) => ({ tx: make(r.tx), existing: r })).filter((c): c is { tx: Transaction; existing: LocalRow } => !!c.tx);
      const n = await onBulk(changes);
      setBulkNote(what(`${n} transaction${n === 1 ? "" : "s"}`));
      stopSelecting();
    } finally {
      setBulkBusy(false);
    }
  }
  const pending = rows.filter((r) => r.state === "pending").length;

  return (
    <div>
      <ScreenHeader
        title="History"
        end={
          <div className="flex items-center gap-1 -mr-2">
            {onBulk && (
              <button type="button" onClick={() => (selecting ? stopSelecting() : setSelecting(true))} aria-label={selecting ? "Stop selecting" : "Select"} className="yields p-2 text-ink-muted" data-testid="select-mode">
                {selecting ? <X size={22} /> : <ListChecks size={22} />}
              </button>
            )}
            <button type="button" onClick={onRefresh} aria-label="Sync now" className="yields p-2 text-ink-muted" data-testid="sync">
              {error ? <CloudOff size={22} className="text-warning" /> : <RefreshCw size={22} className={syncing ? "animate-spin" : ""} />}
            </button>
          </div>
        }
      />
      <div className="px-5">
        <label className="flex items-center gap-3 h-14 px-4 rounded-xl border border-line">
          <Search size={22} className="text-ink-muted" />
          <input className="flex-1 bg-transparent outline-none t-body" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className="flex gap-2 px-5 py-3 overflow-x-auto">
        {(["all", "spending", "income", "transfers"] as Filter[]).map((f) => (
          <Chip key={f} label={f[0].toUpperCase() + f.slice(1)} selected={filter === f} onClick={() => setFilter(f)} />
        ))}
        {(waiting.review > 0 || waiting.unmatched > 0 || filter === "review") && (
          <Chip label={`Review (${waiting.review + waiting.unmatched})`} selected={filter === "review"} onClick={() => setFilter("review")} />
        )}
      </div>
      {filter === "review" && (
        <p className="t-secondary text-ink-muted px-5 pb-2" data-testid="review-help">
          {waiting.review} to sort: lines the categorizer was unsure of, and e-Transfers with people (only you know what they were for).
          Pick a category and they leave this list; for a person, Fulla offers a rule so their next one is sorted.
          {" "}{waiting.unmatched} unmatched {waiting.unmatched === 1 ? "transfer" : "transfers"}: seen on one statement only. They match when you
          import the other account&apos;s statement; if there is none, mark them fine.
        </p>
      )}
      <div className="flex items-center justify-between px-3">
        <button type="button" aria-label="Previous month" className="yields p-2" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={22} /></button>
        <div className="text-center">
          <div className="t-section" data-testid="month">{monthLabel(month, locale)}</div>
          <div className="t-secondary text-ink-muted" data-testid="month-totals">
            Spent {formatMoney(totals.spentMinor, currency, locale)} · In {formatMoney(totals.incomeMinor, currency, locale)}
          </div>
          <div className="t-label text-ink-muted" data-testid="month-split">
            Fixed {formatMoney(split.fixedMinor, currency, locale)} · Flexible {formatMoney(split.flexibleMinor, currency, locale)}
          </div>
        </div>
        <button type="button" aria-label="Next month" className="yields p-2" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={22} /></button>
      </div>
      {bulkNote && !selecting && <p className="t-label text-ink-muted px-5 pt-2" data-testid="bulk-done">{bulkNote}</p>}
      {(error || pending > 0) && (
        <p className="t-label text-warning px-5 pt-2">{error ? `Not synced: ${error}` : `${pending} waiting to sync`}</p>
      )}
      {days.length === 0 ? (
        <EmptyState title="Nothing this month" text="What you add or import shows up here." />
      ) : (
        days.map((d) => (
          <section key={d.date}>
            <div className="t-section text-ink-muted px-5 pt-5 pb-2 border-b border-line">{dayLabel(d.date, locale)}</div>
            {d.rows.map((r) => {
              const t = r.tx;
              const c = category(t.category_id);
              const who = member(t.paid_by_member_id) ?? member(t.created_by_member_id ?? null);
              const title = t.note || c?.name || (t.kind === "transfer" ? "Transfer" : "");
              const context =
                t.kind === "transfer"
                  ? `${account(t.account_id) ?? "?"} → ${account(t.to_account_id) ?? "?"}`
                  : [t.note ? c?.name : null, account(t.account_id)].filter(Boolean).join(" · ");
              const amount = signedAmount(t);
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid="history-row"
                  onClick={() => (selecting ? countsInTotals(t.kind) && toggle(t.id) : onOpen(r))}
                  aria-pressed={selecting ? selected.has(t.id) : undefined}
                  className={`w-full flex items-center gap-4 px-5 py-3 border-b border-line text-left yields ${selecting && !countsInTotals(t.kind) ? "opacity-40" : ""}`}
                >
                  {selecting ? (
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 shrink-0 ${selected.has(t.id) ? "bg-highlight border-highlight text-on-highlight" : "border-line"}`}>
                      {selected.has(t.id) && <Check size={20} strokeWidth={2.5} />}
                    </div>
                  ) : who ? <Avatar initials={who.initials} colorIndex={who.color_index} /> : <div className="w-10" />}
                  <div className="flex-1 min-w-0">
                    <div className="t-body truncate">{title}</div>
                    <div className="t-secondary text-ink-muted truncate">
                      {context}
                      {t.recurrence === "fixed" && countsInTotals(t.kind) && " · fixed"}
                      {needsReview(t) && <span className="text-warning" data-testid="row-review"> · to review</span>}
                      {isUnmatchedTransfer(t) && filter !== "all" && <span className="text-warning" data-testid="row-unmatched"> · unmatched</span>}
                      {r.state === "pending" && " · waiting to sync"}
                      {r.state === "rejected" && <span className="text-danger"> · refused</span>}
                    </div>
                  </div>
                  <div className={`t-amount ${amount > 0 && t.kind !== "transfer" ? "text-money-in" : "text-ink"}`}>
                    {formatMoney(t.kind === "expense" ? t.amount_minor : amount, currency, locale, t.kind === "income" || t.kind === "refund")}
                  </div>
                </button>
              );
            }).flatMap((el, i) => {
              const r = d.rows[i];
              if (filter !== "review" || !isUnmatchedTransfer(r.tx) || !onBulk) return [el];
              return [el, (
                <div key={`${r.tx.id}-fine`} className="px-5 pb-2 -mt-1 border-b border-line flex justify-end">
                  <button type="button" data-testid="transfer-fine" className="t-secondary underline text-ink-muted"
                    onClick={() => void onBulk([{ tx: withoutTag(r.tx, UNMATCHED_TAG), existing: r }])}>
                    It&apos;s fine, no other statement
                  </button>
                </div>
              )];
            })}
          </section>
        ))
      )}
      {selecting && (
        <div className="fixed inset-x-0 bottom-[76px] z-10" data-testid="bulk-bar">
          <div className="max-w-md mx-auto px-3">
            <div className="rounded-2xl bg-paper-high border border-line p-3 grid gap-2 shadow-lg">
              <div className="flex items-center justify-between t-secondary">
                <span data-testid="bulk-count">{selected.size} selected</span>
                <button type="button" className="underline text-ink" onClick={() => setSelected(new Set(days.flatMap((d) => d.rows).filter((r) => countsInTotals(r.tx.kind)).map((r) => r.tx.id)))}>
                  Select all this month
                </button>
              </div>
              <div className="flex gap-2">
                <select data-testid="bulk-category" className="flex-1 h-11 px-3 rounded-xl border border-line bg-paper text-ink t-body" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} disabled={selected.size === 0}>
                  <option value="">Move to category…</option>
                  {bulkChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" data-testid="bulk-apply" disabled={!bulkCategory || selected.size === 0 || bulkBusy}
                  onClick={() => { const c = config.categories.find((k) => k.id === bulkCategory); if (c) void bulk((t) => recategorized(t, c), (n) => `Moved ${n} to ${c.name}.`); }}
                  className="yields h-11 px-4 rounded-xl bg-accent text-on-accent t-body font-semibold disabled:opacity-40">
                  {bulkBusy ? "…" : "Move"}
                </button>
              </div>
              <div className="flex gap-2">
                <button type="button" data-testid="bulk-fixed" disabled={selected.size === 0 || bulkBusy} onClick={() => void bulk((t) => withRecurrence(t, true), (n) => `Marked ${n} fixed.`)} className="yields flex-1 h-10 rounded-xl border border-line t-secondary disabled:opacity-40">Mark fixed</button>
                <button type="button" data-testid="bulk-flexible" disabled={selected.size === 0 || bulkBusy} onClick={() => void bulk((t) => withRecurrence(t, false), (n) => `Marked ${n} flexible.`)} className="yields flex-1 h-10 rounded-xl border border-line t-secondary disabled:opacity-40">Mark flexible</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {selecting && <div className="h-44" />}
    </div>
  );
}
