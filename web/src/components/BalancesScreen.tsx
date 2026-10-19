// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { balancesView, settlementFor, type Payment } from "@/lib/balances";
import { counted, today as todayOf } from "@/lib/ledger";
import { ACCOUNT_TYPE_ICONS, accountTypeLabel, type Config, type Transaction } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import type { BalanceSnapshot } from "@/lib/overview";
import type { LocalRow } from "@/lib/sync";
import { Icon } from "./Icon";
import { Avatar, EmptyState, PrimaryButton, ScreenHeader, Section, SecondaryButton } from "./Pieces";

function dayLabel(date: string, today: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Balances, as the Android tab: who owes whom between the household's
 * members, and the fewest payments that would settle it (tap one to record
 * it as paid: a settlement, which moves the balances and no total); then what
 * is in each account, each opening its own page. In one shared pot nobody
 * owes anybody: the screen says so and shows the accounts with their total.
 * Figures from lib/balances.ts.
 */
export function BalancesScreen({ config, rows, snapshots: given, today: givenToday, onSave, onAccount, onClose }: {
  config: Config;
  rows: LocalRow[];
  snapshots?: BalanceSnapshot[];
  today?: string;
  onSave: (tx: Transaction) => Promise<void>;
  onAccount?: (id: string) => void;
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
  const view = useMemo(() => balancesView(config, counted(rows), snapshots, today), [config, rows, snapshots, today]);
  const name = (id: string) => config.members.find((m) => m.id === id)?.display_name ?? "?";
  const [confirming, setConfirming] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async (p: Payment) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(settlementFor(p, today, config.me_member_id));
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="balances-screen">
      <ScreenHeader
        title="Balances"
        end={onClose && <button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>}
      />

      {view.shared && (
        <EmptyState title="Shared pot" text="Everything goes into one pot, so nobody owes anybody." />
      )}

      {view.between && (
        <>
          <Section>Between you</Section>
          {view.between.map((b) => (
            <div key={b.memberId} className="flex items-center gap-4 px-5 py-2 border-b border-line" data-testid="member-balance">
              <Avatar initials={b.member?.initials ?? "?"} colorIndex={b.member?.color_index ?? 0} />
              <div className="flex-1 min-w-0">
                <div className="t-body">{b.member?.display_name ?? "?"}{b.memberId === config.me_member_id ? " (you)" : ""}</div>
                <div className="t-secondary text-ink-muted">{b.balanceMinor > 0 ? "Is owed" : b.balanceMinor < 0 ? "Owes" : "Settled"}</div>
              </div>
              <div className={`t-amount ${b.balanceMinor > 0 ? "text-money-in" : b.balanceMinor < 0 ? "text-money-out" : "text-ink-muted"}`} data-testid="member-balance-amount">
                {b.balanceMinor === 0 ? money(0) : money(b.balanceMinor, true)}
              </div>
            </div>
          ))}

          <Section>To settle up</Section>
          {view.plan.length === 0 ? (
            <div className="flex flex-col items-center text-center px-8 py-8" data-testid="all-settled">
              <CheckCircle2 size={28} className="text-ink-muted" aria-hidden />
              <div className="t-title mt-2">All settled</div>
              <p className="t-secondary text-ink-muted mt-1">Nobody owes anybody anything.</p>
            </div>
          ) : view.plan.map((p) => {
            const key = `${p.fromMemberId}-${p.toMemberId}`;
            const open = confirming && `${confirming.fromMemberId}-${confirming.toMemberId}` === key;
            return (
              <div key={key} className="border-b border-line">
                <button type="button" data-testid="settle-row" onClick={() => { setConfirming(open ? null : p); setError(null); }}
                  aria-label={`Record a payment: ${name(p.fromMemberId)} pays ${name(p.toMemberId)}`}
                  className="w-full flex items-center gap-4 px-5 py-3 text-left yields">
                  <div className="flex-1 min-w-0">
                    <div className="t-body">{name(p.fromMemberId)} pays {name(p.toMemberId)}</div>
                    <div className="t-secondary text-ink-muted">Tap to record it as paid</div>
                  </div>
                  <div className="t-amount">{money(p.amountMinor)}</div>
                </button>
                {open && (
                  <div className="px-5 pb-4" data-testid="settle-confirm">
                    <div className="rounded-2xl bg-paper-high p-4">
                      <div className="t-body font-medium">Record a payment</div>
                      <p className="t-secondary text-ink-muted mt-1">{name(p.fromMemberId)} paid {money(p.amountMinor)} to {name(p.toMemberId)}?</p>
                      {error && <p className="t-secondary text-danger mt-2">{error}</p>}
                      <div className="grid grid-cols-2 gap-3 mt-4">
                        <SecondaryButton onClick={() => setConfirming(null)}>Cancel</SecondaryButton>
                        <PrimaryButton busy={busy} onClick={() => record(p)} testId="settle-record">Record</PrimaryButton>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <Section>Accounts</Section>
      {view.accounts.length === 0 ? (
        <EmptyState title="No accounts yet" text="Accounts you add or import show here, with what each one holds." />
      ) : view.accounts.map((l) => {
        const context = [
          accountTypeLabel(l.account.type),
          l.statementAsOf ? `statement ${dayLabel(l.statementAsOf, today, locale)}` : l.known ? "since its opening balance" : "recorded only",
        ].join(" · ");
        const body = (
          <>
            <Icon name={ACCOUNT_TYPE_ICONS[l.account.type] ?? "more_horiz"} />
            <div className="flex-1 min-w-0">
              <div className="t-body truncate">{l.account.name}</div>
              <div className="t-secondary text-ink-muted">{context}</div>
            </div>
            <div className={`t-amount ${l.balanceMinor < 0 ? "text-money-out" : "text-ink"} ${l.known ? "" : "opacity-60"}`} data-testid="account-balance">{money(l.balanceMinor)}</div>
            {onAccount && <ChevronRight size={18} className="text-ink-muted shrink-0" />}
          </>
        );
        return onAccount ? (
          <button key={l.account.id} type="button" data-testid="balance-account" onClick={() => onAccount(l.account.id)} className="w-full flex items-center gap-4 px-5 py-3 border-b border-line text-left yields">{body}</button>
        ) : (
          <div key={l.account.id} data-testid="balance-account" className="flex items-center gap-4 px-5 py-3 border-b border-line">{body}</div>
        );
      })}
      {view.totalMinor !== null && view.accounts.length > 0 && (
        <div className="flex items-center gap-4 px-5 py-3" data-testid="balances-total">
          <div className="flex-1 t-body">All accounts together</div>
          <div className={`t-amount ${view.totalMinor < 0 ? "text-money-out" : "text-ink"}`}>{money(view.totalMinor)}</div>
        </div>
      )}
    </div>
  );
}
