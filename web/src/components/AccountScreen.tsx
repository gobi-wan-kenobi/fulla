// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronLeft } from "lucide-react";
import { useMemo } from "react";
import { accountMonths, accountRows, monthOf, signedAmount } from "@/lib/ledger";
import { ACCOUNT_TYPE_ICONS, accountTypeLabel, type Account, type Config } from "@/lib/model";
import { formatMoney } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { Icon } from "./Icon";
import { EmptyState, ScreenHeader, Section } from "./Pieces";

function monthLabel(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function dayLabel(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * One account, as Settings opens it: each month's fees, income and transfers
 * on it, then its transactions by month. An investment account's fees and
 * income are here, not in the household's figures.
 */
export function AccountScreen({ config, account, rows, onOpen, onClose }: {
  config: Config;
  account: Account;
  rows: LocalRow[];
  onOpen?: (row: LocalRow) => void;
  onClose: () => void;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const money = (n: number, signed = false) => formatMoney(n, currency, locale, signed);
  const months = useMemo(() => accountMonths(rows, account.id), [rows, account.id]);
  const list = useMemo(() => accountRows(rows, account.id), [rows, account.id]);
  const category = (id: string | null) => config.categories.find((c) => c.id === id)?.name;
  const accountName = (id: string | null) => config.accounts.find((a) => a.id === id)?.name ?? "?";
  const investment = account.type === "investment";

  return (
    <div data-testid="account-screen">
      <ScreenHeader
        title={account.name}
        end={<button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>}
      />
      <div className="px-5 flex items-center gap-2 t-secondary text-ink-muted">
        <Icon name={ACCOUNT_TYPE_ICONS[account.type] ?? "more_horiz"} size={18} />
        <span>{accountTypeLabel(account.type)}{account.institution ? ` · ${account.institution}` : ""}</span>
      </div>
      {investment && (
        <p className="t-secondary text-ink-muted px-5 pt-2" data-testid="account-outside">
          Fees and income here stay in the account: they change its value, not the household&apos;s spending or income.
        </p>
      )}
      {months.length === 0 ? (
        <EmptyState title="Nothing on this account yet" text="What you add or import on it shows up here." />
      ) : (
        <>
          <Section>By month</Section>
          {months.map((m) => (
            <div key={m.month} className="flex items-center gap-4 px-5 py-2 border-b border-line" data-testid="account-month">
              <div className="flex-1 min-w-0">
                <div className="t-body">{monthLabel(m.month, locale)}</div>
                <div className="t-secondary text-ink-muted truncate">
                  {m.count} transaction{m.count === 1 ? "" : "s"}{m.transfersMinor !== 0 ? ` · transfers ${money(m.transfersMinor, true)}` : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="t-secondary"><span className="text-ink-muted">Fees </span><span className="t-amount" data-testid="account-fees">{money(m.feesMinor)}</span></div>
                <div className="t-secondary"><span className="text-ink-muted">Income </span><span className="t-amount text-money-in" data-testid="account-income">{money(m.incomeMinor, true)}</span></div>
              </div>
            </div>
          ))}
          {months.map((m) => (
            <section key={`rows-${m.month}`}>
              <Section>{monthLabel(m.month, locale)}</Section>
              {list.filter((r) => monthOf(r.tx.date) === m.month).map((r) => {
                const t = r.tx;
                const title = t.note || category(t.category_id) || (t.kind === "transfer" ? "Transfer" : "");
                const context = t.kind === "transfer"
                  ? `${accountName(t.account_id)} → ${accountName(t.to_account_id)}`
                  : [t.note ? category(t.category_id) : null].filter(Boolean).join(" · ");
                const into = t.kind === "transfer" && t.to_account_id === account.id;
                const amount = t.kind === "transfer" ? (into ? t.amount_minor : -t.amount_minor) : signedAmount(t);
                return (
                  <button key={t.id} type="button" data-testid="account-row-tx" onClick={() => onOpen?.(r)} disabled={!onOpen}
                    className="w-full flex items-center gap-4 px-5 py-3 border-b border-line text-left yields">
                    <div className="w-12 shrink-0 t-label text-ink-muted">{dayLabel(t.date, locale)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="t-body truncate">{title}</div>
                      {context && <div className="t-secondary text-ink-muted truncate">{context}</div>}
                    </div>
                    <div className={`t-amount ${amount > 0 ? "text-money-in" : "text-ink"}`}>
                      {t.kind === "expense" ? money(t.amount_minor) : money(amount, amount > 0)}
                    </div>
                  </button>
                );
              })}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
