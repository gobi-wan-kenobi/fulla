// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { ChevronLeft, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { categorizeExisting } from "@/lib/categorize";
import { recategorized, visible } from "@/lib/ledger";
import type { CategorizationRule, Category, Config, Transaction } from "@/lib/model";
import { canManage, deletedRule, newRule, shownRules } from "@/lib/rules";
import type { LocalRow } from "@/lib/sync";
import { Icon } from "./Icon";
import { Chip, EmptyState, PrimaryButton, ScreenHeader, Section, SecondaryButton, categoryColor, inputClass } from "./Pieces";

type Change = { tx: Transaction; existing: LocalRow };

/**
 * Categorisation, as Settings shows it: the household's rules ("when the note
 * contains …, put it in …"), applying them to what is already there, and
 * which categories are fixed spending.
 */
export function RulesScreen({ config, rows, onConfig, onBulk, onClose }: {
  config: Config;
  rows: LocalRow[];
  onConfig: (c: Config) => void;
  onBulk: (changes: Change[]) => Promise<number>;
  onClose: () => void;
}) {
  const manage = canManage(config);
  const rules = useMemo(() => shownRules(config.categorization_rules), [config.categorization_rules]);
  const categories = config.categories.filter((c) => !c.archived).sort((a, b) => a.sort - b.sort);
  const spending = categories.filter((c) => c.applies_to !== "income");
  const [editing, setEditing] = useState<CategorizationRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ category: Category; rows: LocalRow[] } | null>(null);
  const name = (id?: string | null) => config.categories.find((c) => c.id === id)?.name ?? "—";
  const pending = useMemo(() => categorizeExisting(visible(rows), config.categorization_rules ?? [], config.categories), [rows, config]);

  async function saveRule(rule: CategorizationRule) {
    setBusy(true);
    setError(null);
    try {
      onConfig(await api.ruleUpsert(config.household.id, rule));
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyExisting() {
    setBusy(true);
    setError(null);
    try {
      const changes = pending
        .map((p) => {
          const tx = recategorized(p.row.tx, p.category);
          return tx ? { tx: p.fixed ? { ...tx, recurrence: "fixed" as const } : tx, existing: p.row } : null;
        })
        .filter((c): c is Change => !!c);
      const n = await onBulk(changes);
      setNotice(`Sorted ${n} transaction${n === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setFixed(c: Category, fixed: boolean) {
    setError(null);
    try {
      onConfig(await api.categoryUpsert(config.household.id, { ...c, fixed }));
      const past = visible(rows).filter((r) => r.tx.category_id === c.id && (r.tx.recurrence === "fixed") !== fixed);
      setOffer(past.length ? { category: { ...c, fixed }, rows: past } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function applyOffer() {
    if (!offer) return;
    const recurrence = offer.category.fixed ? ("fixed" as const) : ("variable" as const);
    await onBulk(offer.rows.map((r) => ({ tx: { ...r.tx, recurrence }, existing: r })));
    setOffer(null);
  }

  if (editing) {
    return <RuleEditor rule={editing} categories={categories} busy={busy} error={error} isNew={!rules.some((r) => r.id === editing.id)}
      onSave={saveRule} onDelete={() => saveRule(deletedRule(editing))} onClose={() => { setEditing(null); setError(null); }} />;
  }

  return (
    <div>
      <ScreenHeader
        title="Categories"
        end={<button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>}
      />
      <Section>Rules</Section>
      <p className="t-secondary text-ink-muted px-5 pb-2">
        When a note contains the words, the transaction goes in that category. Rules come first, then shops Fulla knows, then the categorizer, then Other.
      </p>
      {rules.length === 0 ? (
        <EmptyState title="No rules yet" text="Change a transaction's category and Fulla offers to remember it. Or add one here." />
      ) : (
        rules.map((r) => {
          const c = config.categories.find((k) => k.id === r.action.category_id);
          return (
            <button
              key={r.id}
              type="button"
              data-testid="rule-row"
              disabled={!manage}
              onClick={() => setEditing(r)}
              className="w-full flex items-center gap-4 px-5 py-3 border-b border-line text-left yields"
            >
              {c ? <Icon name={c.icon} color={categoryColor(c.color_index)} /> : <div className="w-[22px]" />}
              <div className="flex-1 min-w-0">
                <div className={`t-body truncate ${r.active ? "" : "text-ink-muted"}`}>“{r.pattern}”</div>
                <div className="t-secondary text-ink-muted truncate">
                  {r.action.category_id ? name(r.action.category_id) : r.action.kind === "transfer" ? "Transfer" : "Tags"}
                  {!r.active && " · paused"}
                </div>
              </div>
            </button>
          );
        })
      )}
      <div className="p-5 grid gap-3">
        {manage ? (
          <SecondaryButton onClick={() => setEditing(newRule(config, "", spending[0]?.id ?? null))}>
            <span className="inline-flex items-center gap-2" data-testid="rule-add"><Plus size={18} /> Add a rule</span>
          </SecondaryButton>
        ) : (
          <p className="t-secondary text-ink-muted">Only the household&apos;s admins can change rules.</p>
        )}
        <PrimaryButton onClick={() => void applyExisting()} disabled={pending.length === 0} busy={busy} testId="rules-apply">
          {pending.length === 0 ? "Nothing uncategorized to sort" : `Sort ${pending.length} uncategorized`}
        </PrimaryButton>
        {notice && <p className="t-secondary text-ink-muted" data-testid="rules-notice">{notice}</p>}
      </div>

      <Section>Fixed and flexible</Section>
      <p className="t-secondary text-ink-muted px-5 pb-2">
        Fixed is what costs about the same every month (rent, phone, insurance). A transaction put in a category gets its setting; you can still change one transaction.
      </p>
      {spending.map((c) => (
        <div key={c.id} className="flex items-center gap-3 px-5 py-2 border-b border-line" data-testid={`fixed-row-${c.name}`}>
          <Icon name={c.icon} color={categoryColor(c.color_index)} />
          <div className="flex-1 t-body truncate">{c.name}</div>
          <Chip label="Flexible" selected={!c.fixed} onClick={() => manage && c.fixed && void setFixed(c, false)} />
          <Chip label="Fixed" selected={!!c.fixed} onClick={() => manage && !c.fixed && void setFixed(c, true)} testId={`fixed-${c.name}`} />
        </div>
      ))}
      {offer && (
        <div className="px-5 pt-3">
          <SecondaryButton onClick={() => void applyOffer()}>
            Also mark {offer.rows.length} past {offer.category.name} transaction{offer.rows.length === 1 ? "" : "s"} {offer.category.fixed ? "fixed" : "flexible"}
          </SecondaryButton>
        </div>
      )}
      {error && <p className="t-secondary text-danger px-5 pt-3">{error}</p>}
      <div className="h-8" />
    </div>
  );
}

function RuleEditor({ rule, categories, busy, error, isNew, onSave, onDelete, onClose }: {
  rule: CategorizationRule;
  categories: Category[];
  busy: boolean;
  error: string | null;
  isNew: boolean;
  onSave: (r: CategorizationRule) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [pattern, setPattern] = useState(rule.pattern);
  const [category, setCategory] = useState(rule.action.category_id ?? categories[0]?.id ?? "");
  const [active, setActive] = useState(rule.active);
  const ok = pattern.trim().length >= 2 && pattern.trim().length <= 100 && !!category;
  return (
    <div>
      <ScreenHeader
        title={isNew ? "New rule" : "Rule"}
        end={<button type="button" onClick={onClose} aria-label="Back" className="yields p-2 -mr-2"><ChevronLeft size={24} /></button>}
      />
      <label className="block px-5 py-2">
        <span className="t-label text-ink-muted">When the note contains</span>
        <input data-testid="rule-pattern" className={`${inputClass} mt-1`} maxLength={100} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="tim hortons" />
      </label>
      <label className="block px-5 py-2">
        <span className="t-label text-ink-muted">Put it in</span>
        <select data-testid="rule-category" className={`${inputClass} mt-1`} value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.applies_to === "income" ? " (income)" : ""}</option>)}
        </select>
      </label>
      {!isNew && (
        <div className="flex gap-2 px-5 py-2">
          <Chip label="On" selected={active} onClick={() => setActive(true)} />
          <Chip label="Paused" selected={!active} onClick={() => setActive(false)} />
        </div>
      )}
      <p className="t-secondary text-ink-muted px-5 pt-1">Upper and lower case and accents do not matter.</p>
      {error && <p className="t-secondary text-danger px-5 pt-3">{error}</p>}
      <div className="p-5 grid gap-3">
        <PrimaryButton testId="rule-save" busy={busy} disabled={!ok}
          onClick={() => onSave({ ...rule, pattern: pattern.trim(), action: { ...rule.action, category_id: category }, active, archived: false })}>
          Save
        </PrimaryButton>
        {!isNew && <SecondaryButton danger onClick={onDelete}><span data-testid="rule-delete">Delete rule</span></SecondaryButton>}
      </div>
    </div>
  );
}
