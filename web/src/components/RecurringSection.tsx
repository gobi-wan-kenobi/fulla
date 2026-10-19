// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { cadenceText, dayLabel, evidenceText, stateText } from "@/lib/recurringText";
import { useState } from "react";
import { api } from "@/lib/api";
import { randomId } from "@/lib/ids";
import { allows, type Config } from "@/lib/model";
import { formatMoney, parseTyped, requireCurrency } from "@/lib/money";
import { type Cadence, CADENCES, type RecurringEdit, type RecurringItem, type RecurringView, archived, editFor, editProblem, rulesFor } from "@/lib/recurring";
import { Chip, PrimaryButton, Section, SecondaryButton, inputClass } from "./Pieces";

export { cadenceText, dayLabel, evidenceText };

const CADENCE_LABEL: Record<Cadence, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly", yearly: "Yearly" };

/**
 * Recurring items, as the Android Settings › Recurring list and Insights'
 * "Looks recurring": the confirmed ones, then the suggestions, each with when
 * it is next, how it stands and its usual amount. An admin confirms, edits or
 * dismisses a suggestion, and edits or stops a confirmed one. Nothing here
 * writes a transaction: confirming saves a recurring item (auto_create off).
 */
export function RecurringSection({ config, view, onConfig, dismissed, onDismissed, manage, only, limit }: {
  config: Config;
  view: RecurringView;
  onConfig: (c: Config) => void;
  dismissed: string[];
  onDismissed: (keys: string[]) => void;
  manage: boolean;
  /** Only money in, or only money out. */
  only?: "income" | "expense";
  /** Show at most this many of each list. */
  limit?: number;
}) {
  const locale = config.household.locale || "en-CA";
  const currency = config.household.currency;
  const units = requireCurrency(currency).minorUnits;
  const money = (n: number, signed = false) => formatMoney(n, currency, locale, signed);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<RecurringEdit | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pick = (xs: RecurringItem[]) => (only ? xs.filter((x) => x.kind === only) : xs).slice(0, limit ?? Infinity);
  const confirmed = pick(view.confirmed);
  const suggested = pick(view.suggested);

  function start(x: RecurringItem) {
    if (open === x.key) { setOpen(null); return; }
    const e = editFor(x);
    setOpen(x.key);
    setEdit(e);
    setTyped((e.amountMinor / 10 ** units).toFixed(units));
    setError(null);
  }

  async function save(x: RecurringItem, e: RecurringEdit, what: string) {
    setBusy(true);
    setError(null);
    try {
      let c = config;
      for (const r of rulesFor(x, e, config, randomId)) c = await api.recurringUpsert(config.household.id, r);
      onConfig(c);
      if (dismissed.includes(x.key)) onDismissed(await api.recurringDismiss(config.household.id, x.key, false));
      setOpen(null);
      setNotice(what);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(x: RecurringItem) {
    setBusy(true);
    setError(null);
    try {
      if (x.confirmed) {
        let c = config;
        for (const r of archived(x, config)) c = await api.recurringUpsert(config.household.id, r);
        onConfig(c);
      }
      onDismissed(await api.recurringDismiss(config.household.id, x.key, true));
      setOpen(null);
      setNotice(x.confirmed ? `Stopped tracking ${x.name}.` : `Dismissed ${x.name}; it will not be suggested again.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const editor = (x: RecurringItem) => {
    if (!edit) return null;
    const minor = parseTyped(typed || "0", requireCurrency(currency), "dot");
    const e = { ...edit, amountMinor: minor ?? 0 };
    const problem = minor === null ? "That is not an amount" : editProblem(e);
    const cats = config.categories.filter((c) => !c.archived && allows(c.applies_to, x.kind));
    return (
      <div className="px-5 py-3 bg-paper-high border-b border-line grid gap-3" data-testid="recurring-editor">
        <label className="block">
          <span className="t-label text-ink-muted">Name</span>
          <input className={`${inputClass} mt-1`} value={edit.name} maxLength={60} onChange={(ev) => setEdit({ ...edit, name: ev.target.value })} data-testid="recurring-name" />
        </label>
        <label className="block">
          <span className="t-label text-ink-muted">{x.kind === "income" ? "Usual amount in" : "Usual amount"}</span>
          <input className={`${inputClass} mt-1`} inputMode="decimal" value={typed} onChange={(ev) => setTyped(ev.target.value)} data-testid="recurring-amount" />
        </label>
        <div className="flex flex-wrap gap-2">
          {CADENCES.map((c) => <Chip key={c} label={CADENCE_LABEL[c]} selected={edit.cadence === c} onClick={() => setEdit({ ...edit, cadence: c, otherDay: edit.otherDay ?? (Number(edit.nextDate.slice(8)) <= 16 ? 31 : 15) })} />)}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="t-label text-ink-muted">Next on</span>
            <input type="date" className={`${inputClass} mt-1`} value={edit.nextDate} onChange={(ev) => setEdit({ ...edit, nextDate: ev.target.value })} data-testid="recurring-next" />
          </label>
          {edit.cadence === "semimonthly" && (
            <label className="block">
              <span className="t-label text-ink-muted">And on day (31: the last)</span>
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={edit.otherDay ?? ""} onChange={(ev) => setEdit({ ...edit, otherDay: Number(ev.target.value) || undefined })} />
            </label>
          )}
        </div>
        <label className="block">
          <span className="t-label text-ink-muted">Category</span>
          <select className={`${inputClass} mt-1`} value={edit.categoryId ?? ""} onChange={(ev) => setEdit({ ...edit, categoryId: ev.target.value || null })} data-testid="recurring-category">
            <option value="">Choose…</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.parent_id ? `  ${c.name}` : c.name}</option>)}
          </select>
        </label>
        <p className="t-label text-ink-muted">Tracked only: Fulla never adds a transaction for it. It shows when it is next, and when it is late or its price changes.</p>
        {problem && <p className="t-secondary text-danger">{problem}</p>}
        <div className="grid grid-cols-2 gap-2">
          <SecondaryButton danger={x.confirmed} onClick={() => void dismiss(x)}>{x.confirmed ? "Stop tracking" : "Dismiss"}</SecondaryButton>
          <PrimaryButton busy={busy} disabled={!!problem} testId="recurring-save" onClick={() => void save(x, e, `${x.confirmed ? "Saved" : "Confirmed"} ${e.name}.`)}>
            {x.confirmed ? "Save" : "Confirm"}
          </PrimaryButton>
        </div>
        {error && <p className="t-secondary text-danger">{error}</p>}
      </div>
    );
  };

  const row = (x: RecurringItem) => {
    const st = stateText(x, money, (d) => dayLabel(d, locale));
    const income = x.kind === "income";
    return (
      <div key={x.key} data-testid={x.confirmed ? "recurring-confirmed" : "recurring-suggested"}>
        <button type="button" onClick={() => manage && start(x)} disabled={!manage} className="w-full flex items-start gap-4 px-5 py-3 border-b border-line text-left yields disabled:cursor-default">
          <div className="flex-1 min-w-0">
            <div className="t-body truncate">{x.name}</div>
            <div className="t-secondary text-ink-muted">{cadenceText(x, locale)} · next {dayLabel(x.nextDate, locale, true)}</div>
            {st && <div className={`t-secondary ${st.tone === "danger" ? "text-danger" : st.tone === "warning" ? "text-warning" : "text-ink-muted"}`} data-testid="recurring-state">{st.text}</div>}
            {!x.confirmed && <div className="t-label text-ink-muted mt-0.5" data-testid="recurring-evidence">{evidenceText(x.evidence, x.seen.length)}</div>}
          </div>
          <div className="text-right shrink-0">
            <div className={`t-amount ${income ? "text-money-in" : ""}`}>{income ? money(x.typicalMinor, true) : money(x.typicalMinor)}</div>
            {x.varies && <div className="t-label text-ink-muted">± {money(x.toleranceMinor)}</div>}
          </div>
        </button>
        {!x.confirmed && manage && open !== x.key && (
          <div className="flex gap-2 px-5 pb-3 -mt-1 border-b border-line">
            <button type="button" className="yields t-label px-3 h-8 rounded-full bg-accent text-on-accent" data-testid="recurring-confirm" disabled={busy}
              onClick={() => void save(x, editFor(x), `Confirmed ${x.name}.`)}>Confirm</button>
            <button type="button" className="yields t-label px-3 h-8 rounded-full border border-line" onClick={() => start(x)}>Edit</button>
            <button type="button" className="yields t-label px-3 h-8 rounded-full border border-line text-ink-muted" data-testid="recurring-dismiss" disabled={busy}
              onClick={() => void dismiss(x)}>Dismiss</button>
          </div>
        )}
        {open === x.key && editor(x)}
      </div>
    );
  };

  return (
    <div data-testid="recurring-section">
      {notice && <p className="t-label text-ink-muted px-5 pt-2" data-testid="recurring-notice">{notice}</p>}
      {error && !open && <p className="t-secondary text-danger px-5 pt-2">{error}</p>}
      {confirmed.length > 0 && (
        <>
          <Section>{only === "income" ? "Pay and money in" : "Recurring"}</Section>
          {confirmed.map(row)}
        </>
      )}
      {suggested.length > 0 && (
        <>
          <Section>Suggested</Section>
          {suggested.map(row)}
        </>
      )}
      {!manage && suggested.length > 0 && <p className="t-secondary text-ink-muted px-5 pt-2">Only the household&apos;s owners and admins can confirm or dismiss suggestions.</p>}
    </div>
  );
}
