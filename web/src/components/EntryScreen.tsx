// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { Check, ChevronDown, ChevronUp, Delete, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { cleanMerchant, suggest, type Suggestion } from "@/lib/categorize";
import { canManage, newRule } from "@/lib/rules";
import { needsReview } from "@/lib/review";
import { personOf } from "@/lib/transfers";
import { categoriesFor, newTransaction, problem, today, withKind } from "@/lib/ledger";
import { activeMembers, type Category, type Config, type Transaction, type TransactionKind } from "@/lib/model";
import { currencyOf, formatMoney, parseTyped } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { Icon } from "./Icon";
import { Chip, ScreenHeader, SecondaryButton, categoryColor, inputClass } from "./Pieces";


const KINDS: { key: TransactionKind; label: string }[] = [
  { key: "expense", label: "Expense" },
  { key: "income", label: "Income" },
  { key: "refund", label: "Refund" },
  { key: "transfer", label: "Transfer" },
];

function typedFrom(minor: number, units: number): string {
  if (!minor) return "";
  const s = (minor / 10 ** units).toFixed(units);
  return units > 0 ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Add and edit, laid out as the Android entry screen: kinds, the amount,
 * category tiles, one line of details, and the keypad with Save on it.
 */
export function EntryScreen({ config, existing, onSave, onDelete, onClose, onConfig }: {
  config: Config;
  existing?: LocalRow;
  onSave: (tx: Transaction) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose?: () => void;
  onConfig?: (c: Config) => void;
}) {
  const currency = currencyOf(config.household.currency) ?? { code: config.household.currency, minorUnits: 2 };
  const [tx, setTx] = useState<Transaction>(() => existing?.tx ?? newTransaction(config, "expense", today()));
  const [typed, setTyped] = useState(() => typedFrom(existing?.tx.amount_minor ?? 0, currency.minorUnits));
  const [allCategories, setAllCategories] = useState(false);
  const [details, setDetails] = useState(!!existing);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A category someone tapped is theirs; until then the note may suggest one (rules, then known shops).
  const [picked, setPicked] = useState(!!existing);
  const [suggested, setSuggested] = useState<Suggestion | null>(null);
  // An e-Transfer someone sorts from Review: a rule for that person is offered, ticked, so it is sorted next time too.
  const person = existing ? personOf(existing.tx.note) : null;
  const [remember, setRemember] = useState(!!person && !!existing && needsReview(existing.tx));
  const [rulePattern, setRulePattern] = useState(() => person ?? cleanMerchant(existing?.tx.note ?? ""));

  const amount = parseTyped(typed || "0", currency, "dot") ?? 0;
  const current = { ...tx, amount_minor: amount };
  const why = typed && parseTyped(typed, currency, "dot") === null ? "That is not an amount" : problem(current);
  const categories = useMemo(() => categoriesFor(config, tx.kind), [config, tx.kind]);
  const shown = allCategories ? categories : categories.slice(0, 7);
  const accounts = config.accounts.filter((a) => !a.archived);
  const members = activeMembers(config);
  const account = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "No account";
  const member = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? "";

  function key(k: string) {
    setError(null);
    if (k === "back") return setTyped((t) => t.slice(0, -1));
    if (k === ".") return setTyped((t) => (t.includes(".") || currency.minorUnits === 0 ? t : (t || "0") + "."));
    setTyped((t) => {
      const next = t === "0" ? k : t + k;
      const dot = next.indexOf(".");
      if (dot >= 0 && next.length - dot - 1 > currency.minorUnits) return t;
      return next.length > 12 ? t : next;
    });
  }

  const recategorizing = !!existing && !!tx.category_id && tx.category_id !== existing.tx.category_id && tx.note.trim().length > 0;
  const canRemember = recategorizing && !!onConfig && canManage(config);
  const chosenCategory = config.categories.find((c) => c.id === tx.category_id);

  function choose(c: Category) {
    setPicked(true);
    setSuggested(null);
    setTx({ ...tx, category_id: c.id, recurrence: c.fixed ? "fixed" : tx.category_id === c.id ? tx.recurrence : "variable" });
  }

  function typeNote(note: string) {
    const next = { ...tx, note };
    if (!picked && tx.kind !== "transfer") {
      const s = suggest(note, tx.kind, config.categorization_rules ?? [], config.categories);
      setSuggested(s);
      if (s) {
        next.category_id = s.category.id;
        next.recurrence = s.fixed ? "fixed" : "variable";
      }
    }
    setTx(next);
  }

  async function save() {
    if (why) return;
    setSaving(true);
    try {
      if (canRemember && remember && rulePattern.trim().length >= 2 && onConfig) {
        onConfig(await api.ruleUpsert(config.household.id, newRule(config, rulePattern, tx.category_id)));
      }
      await onSave(current);
      if (!existing) {
        setPicked(false);
        setSuggested(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 900);
        setTx(newTransaction(config, tx.kind, tx.date));
        setTyped("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col min-h-[calc(100dvh-6rem)]">
      <ScreenHeader
        title={existing ? "Edit" : "Add"}
        end={onClose && (
          <button type="button" onClick={onClose} aria-label="Close" className="yields p-2 -mr-2">
            <X size={24} />
          </button>
        )}
      />
      <div className="flex gap-2 px-5 overflow-x-auto no-scrollbar pb-1">
        {KINDS.map((k) => (
          <Chip key={k.key} label={k.label} selected={tx.kind === k.key} onClick={() => setTx(withKind(config, tx, k.key))} testId={`kind-${k.key}`} />
        ))}
      </div>
      <div className="px-5 pt-6 pb-4 text-right t-entry-amount" data-testid="amount">
        {formatMoney(amount, currency.code)}
      </div>

      {tx.kind === "transfer" ? (
        <div className="px-5 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="t-label text-ink-muted">From</span>
            <select className={inputClass} value={tx.account_id ?? ""} onChange={(e) => setTx({ ...tx, account_id: e.target.value })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="t-label text-ink-muted">To</span>
            <select className={inputClass} value={tx.to_account_id ?? ""} onChange={(e) => setTx({ ...tx, to_account_id: e.target.value })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div className="px-4 grid grid-cols-4 gap-2">
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              data-testid={`category-${c.name}`}
              onClick={() => choose(c)}
              className={`yields flex flex-col items-center justify-center gap-1.5 h-[84px] rounded-2xl px-1 ${
                tx.category_id === c.id ? "bg-highlight text-on-highlight" : "bg-paper-high text-ink"
              }`}
            >
              <Icon name={c.icon} color={tx.category_id === c.id ? "currentColor" : categoryColor(c.color_index)} />
              <span className="t-label text-center leading-tight line-clamp-2">{c.name}</span>
            </button>
          ))}
          {categories.length > 7 && (
            <button type="button" onClick={() => setAllCategories(!allCategories)} className="yields flex flex-col items-center justify-center gap-1.5 h-[84px] rounded-2xl bg-paper-high">
              {allCategories ? <ChevronUp size={22} /> : <ChevronDown size={22} />}
              <span className="t-label">{allCategories ? "Less" : "More"}</span>
            </button>
          )}
        </div>
      )}

      <button type="button" onClick={() => setDetails(!details)} className="flex items-center justify-between px-5 py-4 t-secondary text-ink-muted text-left" data-testid="details-toggle">
        <span>
          {[
            tx.date === today() ? "Today" : tx.date,
            tx.kind !== "transfer" ? account(tx.account_id) : null,
            tx.paid_by_member_id && members.length > 1 ? `Paid by ${member(tx.paid_by_member_id)}` : null,
            tx.split && tx.split.mode === "equal" && tx.split.members.length > 1 ? "Split between everyone" : null,
          ].filter(Boolean).join(" · ")}
        </span>
        {details ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
      </button>
      {details && (
        <div className="px-5 pb-3 grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="t-label text-ink-muted">Date</span>
              <input type="date" data-testid="date" className={inputClass} value={tx.date} onChange={(e) => e.target.value && setTx({ ...tx, date: e.target.value })} />
            </label>
            {tx.kind !== "transfer" && (
              <label className="block">
                <span className="t-label text-ink-muted">Account</span>
                <select className={inputClass} value={tx.account_id ?? ""} onChange={(e) => setTx({ ...tx, account_id: e.target.value || null })}>
                  <option value="">No account</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {(tx.kind === "expense" || tx.kind === "refund") && members.length > 1 && (
            <label className="block">
              <span className="t-label text-ink-muted">{tx.kind === "refund" ? "Who got it back" : "Paid by"}</span>
              <select className={inputClass} value={tx.paid_by_member_id ?? ""} onChange={(e) => setTx({ ...tx, paid_by_member_id: e.target.value })}>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className="t-label text-ink-muted">Note</span>
            <input data-testid="note" className={inputClass} maxLength={500} value={tx.note} onChange={(e) => typeNote(e.target.value)} placeholder="Where, what" />
          </label>
          {suggested && !picked && (
            <p className="t-secondary text-ink-muted -mt-2" data-testid="suggested">
              {suggested.category.name}, {suggested.source === "rule" ? `by your rule “${suggested.rule?.pattern}”` : suggested.source === "debt" ? "a debt repayment" : "a shop Fulla knows"}
            </p>
          )}
          {canRemember && (
            <div className="rounded-2xl bg-paper-high p-3 grid gap-2">
              <label className="flex items-center gap-3 t-body">
                <input type="checkbox" data-testid="remember-rule" className="w-5 h-5 accent-current" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>{person ? `Always put e-Transfers with ${person} in ${chosenCategory?.name}` : `Always put this in ${chosenCategory?.name}`}</span>
              </label>
              {remember && (
                <label className="block">
                  <span className="t-label text-ink-muted">When the note contains</span>
                  <input data-testid="remember-pattern" className={inputClass} maxLength={100} value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} />
                </label>
              )}
            </div>
          )}
          {tx.kind !== "transfer" && (
            <div className="flex gap-2">
              <Chip label="Flexible" selected={tx.recurrence === "variable"} onClick={() => setTx({ ...tx, recurrence: "variable" })} testId="recurrence-flexible" />
              <Chip label="Fixed" selected={tx.recurrence === "fixed"} onClick={() => setTx({ ...tx, recurrence: "fixed" })} testId="recurrence-fixed" />
            </div>
          )}
          {existing?.state === "rejected" && <p className="t-secondary text-danger">The server refused this: {existing.error}</p>}
          {onDelete && <SecondaryButton danger onClick={() => void onDelete()}>Delete</SecondaryButton>}
        </div>
      )}
      {error && <p className="t-secondary text-danger px-5">{error}</p>}

      <div className="mt-auto bg-paper-high px-2.5 pt-2.5 pb-3 safe-bottom">
        <div className="grid grid-cols-4 gap-2">
          {["1", "2", "3"].map((k) => <Key key={k} label={k} onClick={() => key(k)} />)}
          <Key label={<Delete size={24} />} onClick={() => key("back")} aria="Delete digit" />
          <div className="col-span-3 grid grid-cols-3 gap-2">
            {["4", "5", "6", "7", "8", "9", ".", "0"].map((k) => <Key key={k} label={k} onClick={() => key(k)} />)}
            <div />
          </div>
          <button
            type="button"
            data-testid="save"
            aria-label={why ?? "Save"}
            title={why ?? "Save"}
            disabled={!!why || saving}
            onClick={() => void save()}
            className={`yields rounded-2xl flex items-center justify-center ${why ? "bg-line text-ink-muted" : "bg-accent text-on-accent"} ${saved ? "bg-highlight! text-on-highlight!" : ""}`}
          >
            <Check size={30} strokeWidth={2.5} />
          </button>
        </div>
        {why && amount > 0 && <p className="t-label text-ink-muted text-center pt-2">{why}</p>}
      </div>
    </div>
  );
}

function Key({ label, onClick, aria }: { label: React.ReactNode; onClick: () => void; aria?: string }) {
  return (
    <button type="button" aria-label={aria} data-testid={typeof label === "string" ? `key-${label}` : undefined} onClick={onClick} className="yields h-[60px] rounded-2xl bg-paper t-key flex items-center justify-center">
      {label}
    </button>
  );
}
