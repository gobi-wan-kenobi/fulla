// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { BrandMark } from "./BrandMark";
import { Field, PrimaryButton, inputClass } from "./Pieces";

/**
 * Email and password, as the Android app signs in (client/.../Supabase.kt).
 * Fulla's projects turn off email confirmation (docs/self-hosting.md), so a
 * new account is signed in at once; signing up gives access to nothing until
 * an invite or a new household.
 */
export function SignIn() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const sb = supabase();
    const { data, error } =
      mode === "in"
        ? await sb.auth.signInWithPassword({ email: email.trim(), password })
        : await sb.auth.signUp({ email: email.trim(), password });
    setBusy(false);
    if (error) setMessage(error.message);
    else if (mode === "up" && !data.session) setMessage("Check your email to confirm the account, then sign in.");
  }

  return (
    <main className="max-w-md mx-auto min-h-dvh flex flex-col justify-center safe-top safe-bottom">
      <div className="flex flex-col items-center gap-3 pb-8">
        <BrandMark size={88} />
        <h1 className="t-screen-title">Fulla</h1>
        <p className="t-secondary text-ink-muted">Your household&apos;s money, together.</p>
      </div>
      <form onSubmit={submit}>
        <Field label="Email">
          <input data-testid="email" className={inputClass} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input
            data-testid="password"
            className={inputClass}
            type="password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            minLength={6}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {message && <p className="t-secondary text-danger px-5 py-2">{message}</p>}
        <div className="px-5 pt-4">
          <PrimaryButton type="submit" busy={busy} testId="sign-in">
            {mode === "in" ? "Sign in" : "Create account"}
          </PrimaryButton>
        </div>
      </form>
      <button type="button" className="t-secondary text-ink-muted py-6" onClick={() => setMode(mode === "in" ? "up" : "in")} data-testid="toggle-mode">
        {mode === "in" ? "New here? Create an account" : "I already have an account"}
      </button>
    </main>
  );
}
