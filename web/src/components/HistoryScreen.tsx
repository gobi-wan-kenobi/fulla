// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronLeft, ChevronRight, CloudOff, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { byDay, monthOf, monthTotals, shiftMonth, signedAmount, today } from "@/lib/ledger";
import type { Config } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { normalizeName } from "@/lib/text";
import { Avatar, Chip, EmptyState, ScreenHeader } from "./Pieces";

type Filter = "all" | "spending" | "income" | "transfers";

function dayLabel(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d))).toUpperCase();
}

function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** The month's rows by day, as the Android History: search, filter chips, a row per transaction. */
export function HistoryScreen({ config, rows, syncing, error, onOpen, onRefresh }: {
  config: Config;
  rows: LocalRow[];
  syncing: boolean;
  error: string | null;
  onOpen: (row: LocalRow) => void;
  onRefresh: () => void;
}) {
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
      if (!q) return true;
      return normalizeName(`${r.tx.note} ${category(r.tx.category_id)?.name ?? ""}`).includes(q);
    });
  }, [rows, filter, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => byDay(filtered, month), [filtered, month]);
  const totals = useMemo(() => monthTotals(rows, month), [rows, month]);
  const pending = rows.filter((r) => r.state === "pending").length;

  return (
    <div>
      <ScreenHeader
        title="History"
        end={
          <button type="button" onClick={onRefresh} aria-label="Sync now" className="yields p-2 -mr-2 text-ink-muted" data-testid="sync">
            {error ? <CloudOff size={22} className="text-warning" /> : <RefreshCw size={22} className={syncing ? "animate-spin" : ""} />}
          </button>
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
      </div>
      <div className="flex items-center justify-between px-3">
        <button type="button" aria-label="Previous month" className="yields p-2" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={22} /></button>
        <div className="text-center">
          <div className="t-section" data-testid="month">{monthLabel(month, locale)}</div>
          <div className="t-secondary text-ink-muted" data-testid="month-totals">
            Spent {formatMoney(totals.spentMinor, currency, locale)} · In {formatMoney(totals.incomeMinor, currency, locale)}
          </div>
        </div>
        <button type="button" aria-label="Next month" className="yields p-2" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={22} /></button>
      </div>
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
                  onClick={() => onOpen(r)}
                  className="w-full flex items-center gap-4 px-5 py-3 border-b border-line text-left yields"
                >
                  {who ? <Avatar initials={who.initials} colorIndex={who.color_index} /> : <div className="w-10" />}
                  <div className="flex-1 min-w-0">
                    <div className="t-body truncate">{title}</div>
                    <div className="t-secondary text-ink-muted truncate">
                      {context}
                      {r.state === "pending" && " · waiting to sync"}
                      {r.state === "rejected" && <span className="text-danger"> · refused</span>}
                    </div>
                  </div>
                  <div className={`t-amount ${amount > 0 && t.kind !== "transfer" ? "text-money-in" : "text-ink"}`}>
                    {formatMoney(t.kind === "expense" ? t.amount_minor : amount, currency, locale, t.kind === "income" || t.kind === "refund")}
                  </div>
                </button>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}
