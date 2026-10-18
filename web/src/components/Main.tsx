// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { FileUp, History, PieChart, Plus, Settings } from "lucide-react";
import { useState } from "react";
import type { Membership } from "@/lib/api";
import { useHousehold } from "@/lib/store";
import type { LocalRow } from "@/lib/sync";
import { EntryScreen } from "./EntryScreen";
import { HistoryScreen } from "./HistoryScreen";
import { ImportScreen } from "./ImportScreen";
import { OverviewScreen } from "./OverviewScreen";
import { SettingsScreen } from "./SettingsScreen";

type Tab = "overview" | "add" | "history" | "import" | "settings";

const TABS: { key: Tab; label: string; icon: typeof Plus }[] = [
  { key: "overview", label: "Overview", icon: PieChart },
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
        ) : tab === "overview" ? (
          <OverviewScreen config={config} rows={household.rows} />
        ) : tab === "add" ? (
          <EntryScreen config={config} onSave={(tx) => household.saveTransaction(tx)} onConfig={household.setConfig} />
        ) : tab === "history" ? (
          <HistoryScreen config={config} rows={household.rows} syncing={household.syncing} error={household.error} onOpen={setEditing} onRefresh={household.sync} onBulk={household.saveTransactions} />
        ) : tab === "import" ? (
          <ImportScreen config={config} rows={household.rows} onImport={household.importTransactions} onConfig={household.setConfig} />
        ) : (
          <SettingsScreen config={config} households={props.households} rows={household.rows} onConfig={household.setConfig} onBulk={household.saveTransactions} onSwitch={props.onSwitch} onSignOut={props.onSignOut} onAddHousehold={props.onAddHousehold} accountId={accountId} onAccount={setAccountId} onOpen={setEditing} />
        )}
      </div>
      {!editing && (
        <nav className="fixed bottom-0 inset-x-0 bg-paper-high border-t border-line safe-bottom">
          <div className="max-w-md mx-auto grid grid-cols-5">
            {TABS.map(({ key, label, icon: I }) => (
              <button
                key={key}
                type="button"
                data-testid={`tab-${key}`}
                onClick={() => { setTab(key); setAccountId(null); }}
                className="yields flex flex-col items-center gap-1 py-2"
                aria-current={tab === key ? "page" : undefined}
              >
                <span className={`px-5 py-1 rounded-full ${tab === key ? "bg-highlight text-on-highlight" : "text-ink-muted"}`}>
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
