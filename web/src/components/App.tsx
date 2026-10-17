// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { api, type Membership } from "@/lib/api";
import { configured, supabase } from "@/lib/supabase";
import { Main } from "./Main";
import { Onboarding } from "./Onboarding";
import { EmptyState } from "./Pieces";
import { SignIn } from "./SignIn";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [households, setHouseholds] = useState<Membership[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) return;
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const loadHouseholds = useCallback(async () => {
    try {
      const list = await api.myHouseholds();
      setHouseholds(list);
      const saved = localStorage.getItem("fulla:active-household");
      setActive(list.find((h) => h.household_id === saved)?.household_id ?? list[0]?.household_id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (session) void loadHouseholds();
    else {
      setHouseholds(null);
      setActive(null);
    }
  }, [session, loadHouseholds]);

  useEffect(() => {
    if (active) localStorage.setItem("fulla:active-household", active);
  }, [active]);

  if (!configured) {
    return <EmptyState title="Not connected" text="Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see web/README.md)." />;
  }
  if (session === undefined) return null;
  if (!session) return <SignIn />;
  if (error && !households) return <EmptyState title="Could not reach the household" text={error} />;
  if (!households) return null;
  if (!active) {
    return (
      <Onboarding
        email={session.user.email ?? ""}
        onJoined={async (id) => {
          await loadHouseholds();
          setActive(id);
        }}
      />
    );
  }
  return (
    <Main
      key={active}
      householdId={active}
      households={households}
      onSwitch={setActive}
      onSignOut={async () => {
        await supabase().auth.signOut();
      }}
      onAddHousehold={() => setActive(null)}
    />
  );
}
