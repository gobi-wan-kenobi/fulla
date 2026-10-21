// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { FileUp, History, PieChart, Plus, Settings, TrendingUp } from "lucide-react";
import { useState } from "react";
import type { Membership } from "@/lib/api";
import { useHousehold } from "@/lib/store";
import type { LocalRow } from "@/lib/sync";
import { AccountScreen } from "./AccountScreen";
import { BalancesScreen } from "./BalancesScreen";
import { BudgetsScreen } from "./BudgetsScreen";
import { EntryScreen } from "./EntryScreen";
import { HistoryScreen } from "./HistoryScreen";
import { ImportScreen } from "./ImportScreen";
import { InsightsScreen } from "./InsightsScreen";
import { GoalsScreen } from "./GoalsScreen";
import { NetWorthScreen } from "./NetWorthScreen";
import { OverviewScreen } from "./OverviewScreen";
import { SettingsScreen } from "./SettingsScreen";
import { TrendsScreen } from "./TrendsScreen";

type Tab = "overview" | "trends" | "add" | "history" | "import" | "settings";

const TABS: { key: Tab; label: string; icon: typeof Plus }[] = [
  { key: "overview", label: "Overview", icon: PieChart },
  { key: "trends", label: "Trends", icon: TrendingUp },
  { key: "add", label: "Add", icon: Plus },
  { key: "history", label: "History", icon: History },
  { key: "import", label: "Import", icon: FileUp },
  { key: "settings", label: "Settings", icon: Settings },
];

export function Main(props: {
  householdId: string;
  households: Membership[];
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onAddHousehold: () => void;
}) {
  const household = useHousehold(props.householdId);
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState<LocalRow | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  // Budgets opens over the tab it came from (Overview or Settings) and goes back to it.
  const [budgets, setBudgets] = useState(false);
  // Balances opens the same way, and an account tapped in it opens its page over it.
  const [balances, setBalances] = useState(false);
  const [balanceAccount, setBalanceAccount] = useState<string | null>(null);
  const [insights, setInsights] = useState(false);
  // Net worth opens over Overview or Settings; Balances and an account page open over it and go back to it.
  const [worth, setWorth] = useState(false);
  const [worthAccount, setWorthAccount] = useState<string | null>(null);
  const [goals, setGoals] = useState(false);
  // Trends opened from a category in the Overview: that category (a new key, so the screen starts from it).
  const [trendFrom, setTrendFrom] = useState<{ category: string | null; key: number }>({ category: null, key: 0 });
  const config = household.config;

  return (
    <div className="max-w-md mx-auto min-h-dvh flex flex-col">
      <div className="flex-1 pb-24">
        {!config ? (
          <div className="p-8 t-secondary text-ink-muted">{household.error ?? "Opening the household…"}</div>
        ) : editing ? (
          <EntryScreen
            key={editing.tx.id}
            config={config}
            existing={editing}
            onSave={async (tx) => {
              await household.saveTransaction(tx, editing);
              setEditing(null);
            }}
            onConfig={household.setConfig}
            onDelete={async () => {
              await household.deleteTransaction(editing);
              setEditing(null);
            }}
            onClose={() => setEditing(null)}
          />
        ) : insights ? (
          <InsightsScreen config={config} rows={household.rows} onConfig={household.setConfig} onClose={() => setInsights(false)} />
        ) : balances && balanceAccount && config.accounts.some((a) => a.id === balanceAccount) ? (
          <AccountScreen config={config} account={config.accounts.find((a) => a.id === balanceAccount)!} rows={household.rows} onOpen={setEditing} onConfig={household.setConfig} onClose={() => setBalanceAccount(null)} />
        ) : balances ? (
          <BalancesScreen config={config} rows={household.rows} onSave={(tx) => household.saveTransaction(tx)} onAccount={setBalanceAccount} onClose={() => setBalances(false)} />
        ) : goals && worthAccount && config.accounts.some((a) => a.id === worthAccount) ? (
          <AccountScreen config={config} account={config.accounts.find((a) => a.id === worthAccount)!} rows={household.rows} onOpen={setEditing} onConfig={household.setConfig} onClose={() => setWorthAccount(null)} />
        ) : goals ? (
          <GoalsScreen config={config} rows={household.rows} onAccount={setWorthAccount} onClose={() => setGoals(false)} />
        ) : worth && worthAccount && config.accounts.some((a) => a.id === worthAccount) ? (
          <AccountScreen config={config} account={config.accounts.find((a) => a.id === worthAccount)!} rows={household.rows} onOpen={setEditing} onConfig={household.setConfig} onClose={() => setWorthAccount(null)} />
        ) : worth ? (
          <NetWorthScreen config={config} rows={household.rows} onAccount={setWorthAccount} onBalances={() => setBalances(true)} onClose={() => setWorth(false)} />
        ) : budgets ? (
          <BudgetsScreen config={config} rows={household.rows} onConfig={household.setConfig} onClose={() => setBudgets(false)} />
        ) : tab === "overview" ? (
          <OverviewScreen config={config} rows={household.rows} onBudgets={() => setBudgets(true)} onNetWorth={() => setWorth(true)} onGoals={() => setGoals(true)} onInsights={() => setInsights(true)} onTrend={(category) => { setTrendFrom((t) => ({ category, key: t.key + 1 })); setTab("trends"); }} />
        ) : tab === "trends" ? (
          <TrendsScreen key={trendFrom.key} config={config} rows={household.rows} initialCategory={trendFrom.category} onImport={() => setTab("import")} />
        ) : tab === "add" ? (
          <EntryScreen config={config} onSave={(tx) => household.saveTransaction(tx)} onConfig={household.setConfig} />
        ) : tab === "history" ? (
          <HistoryScreen config={config} rows={household.rows} syncing={household.syncing} error={household.error} onOpen={setEditing} onRefresh={household.sync} onBulk={household.saveTransactions} onConfig={household.setConfig} />
        ) : tab === "import" ? (
          <ImportScreen config={config} rows={household.rows} onImport={household.importTransactions} onConfig={household.setConfig} />
        ) : (
          <SettingsScreen config={config} households={props.households} rows={household.rows} onConfig={household.setConfig} onBulk={household.saveTransactions} onSwitch={props.onSwitch} onSignOut={props.onSignOut} onAddHousehold={props.onAddHousehold} accountId={accountId} onAccount={setAccountId} onOpen={setEditing} onBudgets={() => setBudgets(true)} onBalances={() => setBalances(true)} onNetWorth={() => setWorth(true)} onGoals={() => setGoals(true)} onInsights={() => setInsights(true)} />
        )}
      </div>
      {!editing && (
        <nav className="fixed bottom-0 inset-x-0 bg-paper-high border-t border-line safe-bottom">
          <div className="max-w-md mx-auto grid grid-cols-6">
            {TABS.map(({ key, label, icon: I }) => (
              <button
                key={key}
                type="button"
                data-testid={`tab-${key}`}
                onClick={() => { setTab(key); setAccountId(null); setBudgets(false); setBalances(false); setBalanceAccount(null); setInsights(false); setWorth(false); setWorthAccount(null); setGoals(false); }}
                className="yields flex flex-col items-center gap-1 py-2 min-w-0"
                aria-current={tab === key ? "page" : undefined}
              >
                <span className={`px-3 py-1 rounded-full ${tab === key ? "bg-highlight text-on-highlight" : "text-ink-muted"}`}>
                  <I size={22} />
                </span>
                <span className={`t-label ${tab === key ? "text-ink" : "text-ink-muted"}`}>{label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
