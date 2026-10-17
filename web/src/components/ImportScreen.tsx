// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { randomId } from "@/lib/ids";
import {
  DATE_FORMATS, type ImportProfile, type SavedProfile, type StatementFormat, type StatementResult, columnValues, decodeText,
  detectFormat, dropRepeatedBankIds, guessDelimiter, guessProfile, newAccounts, newCategories, ofxCurrency, previewCsv,
  profileFromJson, profileToJson, propose, readCsv, readOfx, readQif,
} from "@/lib/importers";
import { categoriesFor } from "@/lib/ledger";
import { activeMembers, isCategorised, type Account, type Category, type Config, type Transaction } from "@/lib/model";
import { currencyOf, formatMoney } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { Chip, EmptyState, PrimaryButton, ScreenHeader, Section } from "./Pieces";

/**
 * A bank statement into the household, as the Android import screen: pick a
 * file (OFX, QFX, QIF or CSV, told apart by content), say which account it
 * is and, for CSV, which column is which; check the preview; import. The file
 * is read here in the browser and never uploaded anywhere: only the rows you
 * import reach the household. Importing the same file twice changes nothing.
 */
export function ImportScreen({ config, rows, onImport, onConfig }: {
  config: Config;
  rows: LocalRow[];
  onImport: (txs: Transaction[], accounts: Account[], categories: Category[]) => Promise<number>;
  onConfig: (c: Config) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const currency = currencyOf(config.household.currency)!;
  const locale = config.household.locale || "en-CA";
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState<StatementFormat>("csv");
  const [unreadable, setUnreadable] = useState(false);
  const accounts = config.accounts.filter((a) => !a.archived);
  const [account, setAccount] = useState<string | null>(accounts[0]?.id ?? null);
  const [profile, setProfile] = useState<ImportProfile | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [qifDate, setQifDate] = useState("MM/dd/yyyy");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profiles = useMemo(() => (config.import_profiles ?? []).map(profileFromJson).filter((p): p is SavedProfile => !!p), [config.import_profiles]);

  async function pick(file: File) {
    const read = new Uint8Array(await file.arrayBuffer());
    const f = detectFormat(read);
    setDone(null);
    setError(null);
    setOverrides({});
    if (!f) {
      setUnreadable(true);
      setBytes(null);
      return;
    }
    setUnreadable(false);
    setFileName(file.name);
    setBytes(read);
    setFormat(f);
    setProfileId(null);
    if (f === "csv") setProfile(guessProfile(read, currency.code));
  }

  function use(p: SavedProfile) {
    setProfileId(p.id);
    setProfile(p.profile);
    if (p.accountId) setAccount(p.accountId);
  }

  const header = useMemo(() => (bytes && format === "csv" ? (previewCsv(bytes, 1)[0] ?? []) : []), [bytes, format]);

  const result: StatementResult | null = useMemo(() => {
    if (!bytes) return null;
    try {
      if (format === "ofx") return readOfx(bytes, currency);
      if (format === "qif") return readQif(bytes, currency, qifDate);
      return profile ? readCsv(bytes, profile, currency) : null;
    } catch {
      return null;
    }
  }, [bytes, format, profile, qifDate, currency]);
  const deduped = useMemo(() => (result ? dropRepeatedBankIds(result.lines) : null), [result]);

  // Android falls back to the first category (Housing on a server-created household, which
  // has no "both" category). The web picks the catch-all of the right kind instead.
  const fallback = (kind: "expense" | "income", names: string[]) => {
    const live = config.categories.filter((c) => !c.archived);
    return live.find((c) => c.applies_to === "both")
      ?? live.find((c) => c.applies_to === kind && names.includes(c.name.trim().toLowerCase()))
      ?? live.find((c) => c.applies_to === kind) ?? live[0];
  };
  const uncategorizedExpense = fallback("expense", ["other", "uncategorized"]);
  const uncategorizedIncome = fallback("income", ["other income", "other", "uncategorized"]);
  const uncategorized = uncategorizedExpense && uncategorizedIncome;
  const proposals = useMemo(() => {
    if (!deduped || !account || !uncategorized) return [];
    const members = activeMembers(config);
    return propose({
      householdId: config.household.id, accountId: account, lines: deduped.lines, rules: config.categorization_rules ?? [],
      uncategorizedExpenseId: uncategorizedExpense.id, uncategorizedIncomeId: uncategorizedIncome.id,
      payerMemberId: config.me_member_id ?? members[0]?.id ?? "",
      defaultSplit: members.length >= 2 ? { mode: "equal", members: members.map((m) => m.id) } : null,
      existingIds: new Set(rows.map((r) => r.tx.id)), now: new Date().toISOString(),
      names: { categories: config.categories, members: config.members, accounts: config.accounts },
    });
  }, [deduped, account, config, rows, uncategorized, uncategorizedExpense, uncategorizedIncome]);
  const fresh = proposals.filter((p) => !p.alreadyImported);
  const createdCategories = useMemo(() => newCategories(proposals), [proposals]);
  const createdAccounts = useMemo(() => newAccounts(proposals), [proposals]);
  const brandNew = createdCategories.filter((c) => !config.categories.some((k) => k.id === c.id));
  const statedCurrency = bytes && format === "ofx" ? ofxCurrency(bytes) : null;
  const categoryName = (id: string | null) => config.categories.find((c) => c.id === id)?.name ?? createdCategories.find((c) => c.id === id)?.name ?? "";

  async function saveMapping() {
    if (!profile || !bytes) return;
    const saved: SavedProfile = {
      id: randomId(),
      name: `${accounts.find((a) => a.id === account)?.name ?? "CSV"} (${fileName.replace(/\.[^.]+$/, "").slice(0, 30) || "CSV"})`.slice(0, 60),
      accountId: account,
      profile: { ...profile, delimiter: guessDelimiter(decodeText(bytes)) },
    };
    try {
      onConfig(await api.importProfileUpsert(config.household.id, profileToJson(saved)));
      setProfileId(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const txs = fresh.map((p) => (overrides[p.transaction.id] ? { ...p.transaction, category_id: overrides[p.transaction.id] } : p.transaction));
      const used = new Set(txs.map((t) => t.category_id).filter(Boolean));
      const accountsUsed = new Set(txs.flatMap((t) => [t.account_id, t.to_account_id]).filter(Boolean));
      const n = await onImport(txs, createdAccounts.filter((a) => accountsUsed.has(a.id)), createdCategories.filter((c) => used.has(c.id)));
      setDone(n);
      setBytes(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const columnChips = (selected: number | null | undefined, set: (i: number | null) => void, optional: boolean, testId?: string) => (
    <div className="flex gap-2 px-5 overflow-x-auto pb-1" data-testid={testId}>
      {optional && <Chip label="None" selected={selected == null} onClick={() => set(null)} />}
      {header.map((h, i) => <Chip key={i} label={(h.trim() || `#${i + 1}`).slice(0, 24)} selected={selected === i} onClick={() => set(i)} />)}
    </div>
  );

  return (
    <div>
      <ScreenHeader title="Import" />
      <input
        ref={fileInput}
        type="file"
        data-testid="file-input"
        className="hidden"
        accept=".csv,.ofx,.qfx,.qif,.txt,text/csv,application/x-ofx,application/vnd.intu.qfx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = "";
        }}
      />
      {!bytes ? (
        <EmptyState title="Bring in a statement" text="OFX, QFX, QIF or CSV from your bank. It is read here, on this phone; importing the same file again adds nothing twice.">
          <PrimaryButton onClick={() => fileInput.current?.click()} testId="choose-file">Choose a file</PrimaryButton>
          {done !== null && <p className="t-body pt-4" data-testid="import-done">Imported {done} transaction{done === 1 ? "" : "s"}.</p>}
          {unreadable && <p className="t-body text-danger pt-4">That file is not a statement Fulla can read.</p>}
          {error && <p className="t-secondary text-danger pt-4">{error}</p>}
        </EmptyState>
      ) : (
        <>
          <p className="t-secondary text-ink-muted px-5">{fileName} · {format === "ofx" ? "OFX / QFX" : format.toUpperCase()}</p>
          {statedCurrency && statedCurrency !== currency.code && (
            <p className="t-secondary text-warning px-5 pt-2">This statement is in {statedCurrency}; the household counts in {currency.code}. Amounts are read as {currency.code}.</p>
          )}
          <Section>Into account</Section>
          <div className="flex gap-2 px-5 overflow-x-auto pb-1">
            {accounts.map((a) => <Chip key={a.id} label={a.name} selected={a.id === account} onClick={() => setAccount(a.id)} testId={`account-${a.name}`} />)}
          </div>
          {format === "csv" && profile && (
            <>
              {profiles.length > 0 && (
                <>
                  <Section>Saved mappings</Section>
                  <div className="flex gap-2 px-5 overflow-x-auto pb-1">
                    {profiles.map((p) => <Chip key={p.id} label={p.name} selected={p.id === profileId} onClick={() => use(p)} />)}
                  </div>
                </>
              )}
              <Section>Date</Section>
              {columnChips(profile.dateColumn, (i) => setProfile({ ...profile, dateColumn: i ?? 0 }), false)}
              <div className="flex gap-2 px-5 pt-2 overflow-x-auto pb-1">
                {DATE_FORMATS.map((d) => <Chip key={d} label={d} selected={profile.dateFormat === d} onClick={() => setProfile({ ...profile, dateFormat: d })} />)}
              </div>
              <Section>Amount</Section>
              {columnChips(profile.amount.mode === "single" ? profile.amount.column : null, (i) => setProfile({ ...profile, amount: { mode: "single", column: i ?? 0 } }), false, "amount-columns")}
              <div className="flex gap-2 px-5 pt-2">
                <Chip label="1,234.56" selected={profile.decimal === "dot"} onClick={() => setProfile({ ...profile, decimal: "dot" })} />
                <Chip label="1.234,56" selected={profile.decimal === "comma"} onClick={() => setProfile({ ...profile, decimal: "comma" })} />
              </div>
              <Section>Description</Section>
              <div className="flex gap-2 px-5 overflow-x-auto pb-1">
                {header.map((h, i) => {
                  const on = profile.descriptionColumns.includes(i);
                  return (
                    <Chip key={i} label={(h.trim() || `#${i + 1}`).slice(0, 24)} selected={on}
                      onClick={() => setProfile({ ...profile, descriptionColumns: on ? profile.descriptionColumns.filter((c) => c !== i) : [...profile.descriptionColumns, i].sort((a, b) => a - b) })} />
                  );
                })}
              </div>
              <Section>Money in or out (type column)</Section>
              {columnChips(profile.kindColumn, (i) => setProfile({ ...profile, kindColumn: i, incomeValues: [] }), true)}
              {profile.kindColumn != null && bytes && (
                <div className="flex gap-2 px-5 pt-2 overflow-x-auto pb-1">
                  {columnValues(bytes, profile, profile.kindColumn).map((v) => {
                    const on = (profile.incomeValues ?? []).includes(v);
                    return <Chip key={v} label={`${v} = in`} selected={on} onClick={() => setProfile({ ...profile, incomeValues: on ? profile.incomeValues!.filter((x) => x !== v) : [...(profile.incomeValues ?? []), v] })} />;
                  })}
                </div>
              )}
              <Section>Category column</Section>
              {columnChips(profile.categoryColumn, (i) => setProfile({ ...profile, categoryColumn: i }), true)}
            </>
          )}
          {format === "qif" && (
            <>
              <Section>Date format</Section>
              <div className="flex gap-2 px-5 overflow-x-auto pb-1">
                {DATE_FORMATS.map((d) => <Chip key={d} label={d} selected={qifDate === d} onClick={() => setQifDate(d)} />)}
              </div>
            </>
          )}

          <Section>
            <span data-testid="lines-found">{proposals.length} lines, {fresh.length} new</span>
          </Section>
          {createdAccounts.length > 0 && <p className="t-secondary text-ink-muted px-5">New accounts: {createdAccounts.map((a) => a.name).join(", ")}</p>}
          {brandNew.length > 0 && <p className="t-secondary text-ink-muted px-5">New categories: {brandNew.map((c) => c.name).join(", ")}</p>}
          {result && result.skipped.length > 0 && <p className="t-secondary text-warning px-5">{result.skipped.length} {result.skipped.length === 1 ? "line" : "lines"} skipped (no date or amount)</p>}
          {deduped && deduped.repeated > 0 && <p className="t-secondary text-ink-muted px-5">{deduped.repeated} repeated by the bank, left out</p>}
          {format === "csv" && profileId === null && result && result.lines.length > 0 && (
            <button type="button" className="t-secondary underline px-5 py-2 text-ink" onClick={() => void saveMapping()} data-testid="save-mapping">
              Save this mapping for next time
            </button>
          )}
          <div className="mt-2">
            {proposals.slice(0, 200).map((p) => {
              const t = p.transaction;
              const cat = overrides[t.id] ?? t.category_id;
              return (
                <div key={t.id} className="flex items-center gap-3 px-5 py-3 border-b border-line" data-testid="preview-row">
                  <div className="flex-1 min-w-0">
                    <div className={`t-body truncate ${p.alreadyImported ? "text-ink-muted" : ""}`}>{t.note || categoryName(cat)}</div>
                    <div className="t-secondary text-ink-muted flex items-center gap-2">
                      <span>{t.date}</span>
                      {p.alreadyImported ? (
                        <span>· already imported</span>
                      ) : isCategorised(t.kind) ? (
                        <select
                          className="bg-transparent border border-line rounded-lg px-1 py-0.5 max-w-[11rem]"
                          value={cat ?? ""}
                          onChange={(e) => setOverrides({ ...overrides, [t.id]: e.target.value })}
                        >
                          {[...categoriesFor(config, t.kind), ...createdCategories.filter((c) => !config.categories.some((k) => k.id === c.id))].map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span>· transfer</span>
                      )}
                      {p.matchedRule && <span>· by rule “{p.matchedRule.pattern}”</span>}
                    </div>
                  </div>
                  <div className={`t-amount ${p.line.amountMinor > 0 ? "text-money-in" : "text-ink"}`}>{formatMoney(p.line.amountMinor, currency.code, locale, true)}</div>
                </div>
              );
            })}
          </div>
          {error && <p className="t-secondary text-danger px-5 pt-3">{error}</p>}
          <div className="p-5 grid gap-3">
            <PrimaryButton onClick={() => void runImport()} disabled={fresh.length === 0} busy={busy} testId="import-run">
              Import {fresh.length}
            </PrimaryButton>
            <button type="button" className="t-secondary text-ink-muted py-2" onClick={() => setBytes(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
