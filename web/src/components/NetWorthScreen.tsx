// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { AlertTriangle, ChevronLeft, ChevronRight, Scale } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { counted, today as todayOf } from "@/lib/ledger";
import { ACCOUNT_TYPE_ICONS, accountTypeLabel, type Config } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import { GROUP_LABEL, type NetWorthLine, type NetWorthPoint, netWorth } from "@/lib/networth";
import type { BalanceSnapshot } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { Icon } from "./Icon";
import { EmptyState, ScreenHeader, Section } from "./Pieces";

function dayLabel(date: string, today: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function monthShort(date: string, locale: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** The line over time: one point a month, in SVG, the zero line drawn when the line crosses it. */
function HistoryChart({ points, money, locale }: { points: NetWorthPoint[]; money: (n: number) => string; locale: string }) {
  const single = points.length === 1;
  const w = 340, h = single ? 84 : 150, pad = { l: 8, r: 8, t: 22, b: 22 };
  const values = points.map((p) => p.totalMinor);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => pad.l + (points.length === 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / (points.length - 1));
  const y = (v: number) => (single ? (h - pad.b + pad.t) / 2 : pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b));
  const last = points.length - 1;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.totalMinor).toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `${path} L${x(points.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z` : "";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" role="img" aria-label={`Net worth by month: ${points.map((p) => `${monthShort(p.date, locale)} ${money(p.totalMinor)}`).join(", ")}`} data-testid="networth-chart">
      <defs>
        <linearGradient id="nw-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--in-surface)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--in-surface)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {lo < 0 && hi > 0 && <line x1={pad.l} x2={w - pad.r} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeDasharray="3 3" />}
      {area && <path d={area} fill="url(#nw-fill)" />}
      {points.length > 1 && <path d={path} fill="none" stroke="var(--in-body)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      <text x={single ? x(last) : x(last) - 2} y={y(points[last].totalMinor) - 9} textAnchor={single ? "middle" : "end"} fontSize="11" fontWeight="600" fill="var(--ink)">{money(points[last].totalMinor)}</text>
      {points.map((p, i) => (
        <g key={p.date}>
          <circle cx={x(i)} cy={y(p.totalMinor)} r={i === points.length - 1 ? 4.5 : 3} fill={i === points.length - 1 ? "var(--highlight)" : "var(--in-body)"} stroke="var(--paper)" strokeWidth="1.5" />
          <text x={x(i)} y={h - 6} textAnchor="middle" fontSize="11" fill="var(--ink-muted)">{monthShort(p.date, locale)}</text>
        </g>
      ))}
    </svg>
  );
}

/**
 * Net worth: what the accounts hold less what is owed, by group (cash,
 * investments, cards and debt) and account, each as of its own statement and
 * flagged when that is old or missing; and the line month by month from the
 * statement balances. Figures from lib/networth.ts (on lib/balances.ts).
 */
export function NetWorthScreen({ config, rows, snapshots: given, today: givenToday, onAccount, onBalances, onClose }: {
  config: Config;
  rows: LocalRow[];
  snapshots?: BalanceSnapshot[];
  today?: string;
  onAccount?: (id: string) => void;
  onBalances?: () => void;
  onClose?: () => void;
}) {
  const locale = config.household.locale || "en-CA";
  const money = (n: number, signed = false) => formatMoney(n, config.household.currency, locale, signed);
  const today = givenToday ?? todayOf();
  const [fetched, setFetched] = useState<BalanceSnapshot[]>([]);
  useEffect(() => {
    if (given) return;
    let live = true;
    api.balanceSnapshots(config.household.id).then((s) => live && setFetched(s), () => undefined);
    return () => { live = false; };
  }, [config.household.id, given]);
  const snapshots = given ?? fetched;
  const nw = useMemo(() => netWorth(config, counted(rows), snapshots, today), [config, rows, snapshots, today]);
  const day = (d: string) => dayLabel(d, today, locale);

  const context = (l: NetWorthLine) => {
    if (l.status === "missing") return l.account.type === "investment" ? "No market value yet · import a statement" : "No balance yet · import a statement or set an opening balance";
    const basis = l.basis === "statement" ? (l.account.type === "investment" ? "market value" : "statement") : "opening balance";
    const parts = [accountTypeLabel(l.account.type), l.asOf ? `${basis} ${day(l.asOf)}` : basis];
    if (l.since > 0) parts.push(`+ ${l.since} recorded since`);
    return parts.join(" · ");
  };

  const row = (l: NetWorthLine) => {
    const body = (
      <>
        <span className={l.counted ? "" : "opacity-50"}><Icon name={ACCOUNT_TYPE_ICONS[l.account.type] ?? "more_horiz"} /></span>
        <div className="flex-1 min-w-0">
          <div className={`t-body truncate ${l.counted ? "" : "text-ink-muted"}`}>{l.account.name}</div>
          <div className="t-secondary text-ink-muted">{context(l)}</div>
          {l.status === "stale" && <div className="t-secondary text-warning flex items-center gap-1" data-testid="networth-stale"><AlertTriangle size={14} aria-hidden /> {l.ageDays} days old · import a newer statement</div>}
        </div>
        {l.counted
          ? <div className={`t-amount ${l.balanceMinor < 0 ? "text-money-out" : "text-ink"}`} data-testid="networth-account-balance">{money(l.balanceMinor)}</div>
          : <div className="t-secondary text-ink-muted text-right" data-testid="networth-missing">not counted</div>}
        {onAccount && <ChevronRight size={18} className="text-ink-muted shrink-0" />}
      </>
    );
    const cls = "w-full flex items-center gap-4 px-5 py-3 border-b border-line text-left";
    return onAccount
      ? <button key={l.account.id} type="button" data-testid="networth-account" data-status={l.status} onClick={() => onAccount(l.account.id)} className={`${cls} yields`}>{body}</button>
      : <div key={l.account.id} data-testid="networth-account" data-status={l.status} className={cls}>{body}</div>;
  };

  const latestKnown = nw.lines.filter((l) => l.asOf).map((l) => l.asOf!).sort();
  const sparse = nw.history.length < 3;

  return (
    <div data-testid="networth-screen">
      <ScreenHeader title="Net worth"
        end={onClose && <button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>} />

      {!nw.known ? (
        <EmptyState title="No balances yet" text="Import a statement (or set an opening balance on an account) and what you own, less what you owe, shows here." />
      ) : (
        <>
          <div className="px-5 pt-2 pb-4">
            <div className="t-label text-ink-muted">Today, from statements and opening balances</div>
            <div className={`text-[36px] leading-[42px] font-semibold mt-1 ${nw.totalMinor < 0 ? "text-money-out" : "text-ink"}`} style={{ fontStretch: "88%" }} data-testid="networth-total">{money(nw.totalMinor)}</div>
            <div className="t-secondary text-ink-muted mt-1">
              <span className="text-money-in" data-testid="networth-assets">{money(nw.assetsMinor)}</span> owned · <span data-testid="networth-debts">{money(-nw.debtsMinor)}</span> owed
            </div>
            {latestKnown.length > 0 && (
              <div className="t-label text-ink-muted mt-1">Balances dated {day(latestKnown[0])} to {day(latestKnown[latestKnown.length - 1])}</div>
            )}
            {(nw.missing.length > 0 || nw.stale.length > 0) && (
              <div className="mt-3 rounded-2xl bg-paper-high px-4 py-3 t-secondary flex gap-2" data-testid="networth-flags">
                <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" aria-hidden />
                <div>
                  {nw.missing.length > 0 && <div>{nw.missing.length} account{nw.missing.length === 1 ? "" : "s"} not counted: no statement or opening balance yet.</div>}
                  {nw.stale.length > 0 && <div>{nw.stale.length} counted from a statement over 45 days old.</div>}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 px-5" data-testid="networth-groups">
            {nw.groups.map((g) => (
              <div key={g.group} className="rounded-2xl bg-paper-high p-3" data-testid={`networth-group-${g.group}`}>
                <div className="t-label text-ink-muted">{GROUP_LABEL[g.group]}</div>
                <div className={`mt-1 text-[15px] leading-5 font-semibold tabular-nums ${g.totalMinor < 0 ? "text-money-out" : ""}`} style={{ fontStretch: "88%" }}>{money(g.totalMinor)}</div>
                <div className="t-label text-ink-muted mt-0.5">{g.lines.filter((l) => l.counted).length} of {g.lines.length}</div>
              </div>
            ))}
          </div>

          <Section>Month by month</Section>
          <div className="px-5" data-testid="networth-history">
            {nw.history.length > 0 && <HistoryChart points={nw.history} money={(n) => money(n)} locale={locale} />}
            {sparse && (
              <p className="t-secondary text-ink-muted mt-1" data-testid="networth-sparse">
                {nw.history.length <= 1 ? "Only this month so far." : "Only a couple of months so far."} The line fills in as each month&apos;s statements come in; each point counts the accounts known by then.
              </p>
            )}
          </div>

          {nw.groups.map((g) => g.lines.length > 0 && (
            <div key={g.group}>
              <Section>{GROUP_LABEL[g.group]} · {money(g.totalMinor)}</Section>
              {[...g.lines.filter((l) => l.counted), ...g.lines.filter((l) => !l.counted)].map(row)}
            </div>
          ))}
          {nw.unused.length > 0 && (
            <p className="t-label text-ink-muted px-5 py-3" data-testid="networth-unused">
              {nw.unused.length} account{nw.unused.length === 1 ? "" : "s"} with nothing on {nw.unused.length === 1 ? "it" : "them"} not shown. Archive {nw.unused.length === 1 ? "it" : "them"} in Settings if unused.
            </p>
          )}
        </>
      )}

      {onBalances && (
        <button type="button" onClick={onBalances} data-testid="networth-balances" className="w-full flex items-center gap-4 px-5 py-3 mt-2 border-y border-line text-left yields">
          <Scale size={22} className="text-ink-muted shrink-0" aria-hidden />
          <div className="flex-1 min-w-0">
            <div className="t-body">Balances</div>
            <div className="t-secondary text-ink-muted">Who owes whom, and settling up</div>
          </div>
          <ChevronRight size={18} className="text-ink-muted shrink-0" />
        </button>
      )}
    </div>
  );
}
