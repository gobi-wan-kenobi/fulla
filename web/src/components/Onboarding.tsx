// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { DEFAULT_FOR_NEW_HOUSEHOLD, currencyOf } from "@/lib/money";
import { Chip, Field, PrimaryButton, ScreenHeader, inputClass } from "./Pieces";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** Create a household (fulla_household_create, Canadian dollars proposed) or join one with an invite code. */
export function Onboarding({ email, onJoined }: { email: string; onJoined: (householdId: string) => Promise<void> }) {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("Our household");
  const [currency, setCurrency] = useState(DEFAULT_FOR_NEW_HOUSEHOLD);
  const [displayName, setDisplayName] = useState(email.split("@")[0] ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const who = displayName.trim() || "Me";
      const joined =
        mode === "create"
          ? await api.householdCreate({
              name: name.trim(), currency: currency.toUpperCase(), locale: navigator.language || "en-CA",
              displayName: who, initials: initialsOf(who), colorIndex: 0,
            })
          : await api.inviteAccept(code, who, initialsOf(who), 1);
      await onJoined(joined.household_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="max-w-md mx-auto min-h-dvh safe-bottom">
      <ScreenHeader title="Your household" />
      <div className="flex gap-2 px-5 pb-2">
        <Chip label="Start a new one" selected={mode === "create"} onClick={() => setMode("create")} testId="mode-create" />
        <Chip label="I have an invite" selected={mode === "join"} onClick={() => setMode("join")} testId="mode-join" />
      </div>
      <form onSubmit={submit}>
        <Field label="Your name">
          <input data-testid="display-name" className={inputClass} required maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        {mode === "create" ? (
          <>
            <Field label="Household name">
              <input data-testid="household-name" className={inputClass} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Currency">
              <input
                data-testid="currency"
                className={inputClass}
                required
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
              {!currencyOf(currency) && <p className="t-secondary text-danger mt-1">Not a currency Fulla knows.</p>}
            </Field>
          </>
        ) : (
          <Field label="Invite code">
            <input data-testid="invite-code" className={inputClass} required value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
          </Field>
        )}
        {error && <p className="t-secondary text-danger px-5 py-2">{error}</p>}
        <div className="px-5 pt-4">
          <PrimaryButton type="submit" busy={busy} disabled={mode === "create" && !currencyOf(currency)} testId="onboarding-submit">
            {mode === "create" ? "Create household" : "Join"}
          </PrimaryButton>
        </div>
      </form>
    </main>
  );
}
