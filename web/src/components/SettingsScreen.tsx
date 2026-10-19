// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { api, type Membership } from "@/lib/api";
import { ACCOUNT_TYPE_ICONS, accountTypeLabel, type Config, type Transaction } from "@/lib/model";
import type { LocalRow } from "@/lib/sync";
import { Icon } from "./Icon";
import { Avatar, Chip, ScreenHeader, Section, SecondaryButton } from "./Pieces";
import { AccountScreen } from "./AccountScreen";
import { RulesScreen } from "./RulesScreen";

export function SettingsScreen({ config, households, rows, onConfig, onBulk, onSwitch, onSignOut, onAddHousehold, accountId, onAccount, onOpen, onBudgets, onBalances, onNetWorth, onInsights }: {
  config: Config;
  households: Membership[];
  rows: LocalRow[];
  onConfig: (c: Config) => void;
  onBulk: (changes: { tx: Transaction; existing: LocalRow }[]) => Promise<number>;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onAddHousehold: () => void;
  /** The account whose page is open, kept by Main so it is still open after a row is edited. */
  accountId?: string | null;
  onAccount?: (id: string | null) => void;
  onOpen?: (row: LocalRow) => void;
  onBudgets?: () => void;
  onBalances?: () => void;
  onNetWorth?: () => void;
  onInsights?: () => void;
}) {
  const [rules, setRules] = useState(false);
  const [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = config.members.find((m) => m.id === config.me_member_id);
  const canInvite = me?.role === "owner" || me?.role === "admin";
  const ruleCount = (config.categorization_rules ?? []).filter((r) => !r.archived).length;

  const [ownAccount, setOwnAccount] = useState<string | null>(null);
  const shown = accountId !== undefined ? accountId : ownAccount;
  const openAccount = onAccount ?? setOwnAccount;
  const page = shown ? config.accounts.find((a) => a.id === shown) : undefined;
  if (page) return <AccountScreen config={config} account={page} rows={rows} onOpen={onOpen} onConfig={onConfig} onClose={() => openAccount(null)} />;
  if (rules) return <RulesScreen config={config} rows={rows} onConfig={onConfig} onBulk={onBulk} onClose={() => setRules(false)} />;

  return (
    <div>
      <ScreenHeader title="Settings" />
      <Section>Household</Section>
      <div className="px-5 t-body" data-testid="household-name">{config.household.name}</div>
      <div className="px-5 t-secondary text-ink-muted" data-testid="household-currency">Counts in {config.household.currency}</div>
      {households.length > 1 && (
        <div className="flex gap-2 px-5 pt-3 overflow-x-auto">
          {households.map((h) => <Chip key={h.household_id} label={h.name} selected={h.household_id === config.household.id} onClick={() => onSwitch(h.household_id)} />)}
        </div>
      )}
      <Section>People</Section>
      {config.members.filter((m) => m.status === "active").map((m) => (
        <div key={m.id} className="flex items-center gap-4 px-5 py-2">
          <Avatar initials={m.initials} colorIndex={m.color_index} />
          <div>
            <div className="t-body">{m.display_name}{m.id === config.me_member_id ? " (you)" : ""}</div>
            <div className="t-secondary text-ink-muted">{m.role}</div>
          </div>
        </div>
      ))}
      {canInvite && (
        <div className="px-5 pt-3">
          {invite ? (
            <div className="rounded-2xl bg-paper-high p-4">
              <div className="t-label text-ink-muted">Invite code, valid until {new Date(invite.expires_at).toLocaleString()}</div>
              <div className="t-title tracking-widest pt-1 select-all" data-testid="invite-code">{invite.code}</div>
              <div className="t-secondary text-ink-muted pt-1">They sign up in Fulla, choose “I have an invite” and type it.</div>
            </div>
          ) : (
            <SecondaryButton
              onClick={async () => {
                try {
                  setInvite(await api.inviteCreate(config.household.id, "member"));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Invite someone
            </SecondaryButton>
          )}
        </div>
      )}
      <Section>Categories</Section>
      <button type="button" data-testid="open-rules" onClick={() => setRules(true)} className="w-full flex items-center justify-between px-5 py-3 text-left yields">
        <div>
          <div className="t-body">Rules, fixed and flexible</div>
          <div className="t-secondary text-ink-muted">{ruleCount} rule{ruleCount === 1 ? "" : "s"} · how imports are sorted</div>
        </div>
        <ChevronRight size={20} className="text-ink-muted" />
      </button>
      {onBudgets && (
        <button type="button" data-testid="open-budgets" onClick={onBudgets} className="w-full flex items-center justify-between px-5 py-3 text-left yields">
          <div>
            <div className="t-body">Budgets and fixed costs</div>
            <div className="t-secondary text-ink-muted">{config.budgets.filter((b) => b.amount_minor > 0).length ? "A monthly amount per category" : "None set yet"}</div>
          </div>
          <ChevronRight size={20} className="text-ink-muted" />
        </button>
      )}
      {onInsights && (
        <button type="button" data-testid="open-insights" onClick={onInsights} className="w-full flex items-center justify-between px-5 py-3 text-left yields">
          <div>
            <div className="t-body">Insights, recurring and payday</div>
            <div className="t-secondary text-ink-muted">{(config.recurring_rules ?? []).filter((r) => !r.archived && r.active).length ? "What repeats, confirmed and suggested" : "Suggestions from what repeats"}</div>
          </div>
          <ChevronRight size={20} className="text-ink-muted" />
        </button>
      )}
      {onNetWorth && (
        <button type="button" data-testid="open-networth" onClick={onNetWorth} className="w-full flex items-center justify-between px-5 py-3 text-left yields">
          <div>
            <div className="t-body">Net worth</div>
            <div className="t-secondary text-ink-muted">What the accounts hold less cards, month by month</div>
          </div>
          <ChevronRight size={20} className="text-ink-muted" />
        </button>
      )}
      {onBalances && (
        <button type="button" data-testid="open-balances" onClick={onBalances} className="w-full flex items-center justify-between px-5 py-3 text-left yields">
          <div>
            <div className="t-body">Balances</div>
            <div className="t-secondary text-ink-muted">{config.members.filter((m) => m.status === "active").length >= 2 && config.household.money_mode !== "shared" ? "Who owes whom, and what each account holds" : "What each account holds"}</div>
          </div>
          <ChevronRight size={20} className="text-ink-muted" />
        </button>
      )}
      <Section>Accounts</Section>
      {config.accounts.filter((a) => !a.archived).map((a) => (
        <button key={a.id} type="button" data-testid="account-row" onClick={() => openAccount(a.id)} className="w-full px-5 py-2 t-body flex items-center gap-3 text-left yields">
          <Icon name={ACCOUNT_TYPE_ICONS[a.type] ?? "more_horiz"} size={18} className="text-ink-muted shrink-0" />
          <span className="flex-1">{a.name} <span className="t-secondary text-ink-muted">· {accountTypeLabel(a.type)}</span></span>
          <ChevronRight size={18} className="text-ink-muted" />
        </button>
      ))}
      {error && <p className="t-secondary text-danger px-5 pt-3">{error}</p>}
      <div className="p-5 grid gap-3">
        <SecondaryButton onClick={onAddHousehold}>Another household</SecondaryButton>
        <SecondaryButton danger onClick={onSignOut}>Sign out</SecondaryButton>
      </div>
      <p className="t-label text-ink-muted px-5 pb-8">Fulla is free software (GPL-3.0-or-later). Accounts and category names are edited in the Android app for now.</p>
    </div>
  );
}
