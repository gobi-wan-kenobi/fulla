// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, categorizer } from "@/lib/api";
import { fallbackCategory } from "@/lib/categorize";
import { type ModelAnswer, modelCategory, modelTransfer } from "@/lib/categorizer";
import { randomId } from "@/lib/ids";
import {
  DATE_FORMATS, type ImportProfile, type PdfProblem, type PdfStatementResult, type SavedProfile, type StatementFormat,
  type StatementResult, PdfStatementError, columnValues, decodeText, detectFormat, dropRepeatedBankIds, extractPdfPages,
  guessDelimiter, guessProfile, isPdf, newAccounts, newCategories, ofxCurrency, previewCsv, profileFromJson, profileToJson,
  accountIdFor, propose, readCsv, readOfx, readQif, readWealthsimpleChequing,
} from "@/lib/importers";
import { loadPdfJs } from "@/lib/importers/pdfBrowser";
import { categoriesFor } from "@/lib/ledger";
import { activeMembers, isCategorised, type Account, type Category, type Config, type Transaction } from "@/lib/model";
import { currencyOf, formatMoney } from "@/lib/money";
import type { LocalRow } from "@/lib/sync";
import { Chip, EmptyState, PrimaryButton, ScreenHeader, Section } from "./Pieces";

type Format = StatementFormat | "pdf";

/** What to say when a PDF cannot be read, in words a person can act on. */
const PDF_PROBLEMS: Record<PdfProblem, string> = {
  "no-text": "That PDF has no text to read: it may be a scan or a photo. Download the statement from your bank's website or app instead, or export a CSV, OFX or QFX.",
  "not-wealthsimple": "Fulla reads PDF statements from Wealthsimple chequing only, for now. For another bank, export a CSV, OFX or QFX from its website.",
  "not-chequing": "That is not a Wealthsimple chequing statement. Fulla reads the chequing monthly statement PDF; for other accounts, export a CSV.",
  "no-rows": "That statement has no transactions in it.",
  unreadable: "That PDF could not be opened. It may be damaged; try downloading it again.",
  password: "That PDF is locked with a password. Download an unlocked copy from your bank first.",
};

/**
 * A bank statement into the household, as the Android import screen: pick a
 * file (OFX, QFX, QIF, CSV or a Wealthsimple chequing PDF, told apart by
 * content), say which account it is and, for CSV, which column is which;
 * check the preview (for a PDF, every running balance is checked); import. The file
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
  const [format, setFormat] = useState<Format>("csv");
  const [unreadable, setUnreadable] = useState(false);
  const [pdf, setPdf] = useState<PdfStatementResult | null>(null);
  const [pdfProblem, setPdfProblem] = useState<PdfProblem | null>(null);
  const [readingPdf, setReadingPdf] = useState(false);
  const [acceptMismatch, setAcceptMismatch] = useState(false);
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
    setDone(null);
    setError(null);
    setOverrides({});
    setPdf(null);
    setPdfProblem(null);
    setAcceptMismatch(false);
    if (isPdf(read)) {
      // Read here in the browser with PDF.js; the file goes nowhere.
      setUnreadable(false);
      setBytes(null);
      setReadingPdf(true);
      try {
        const pages = await extractPdfPages(read, await loadPdfJs());
        const statement = readWealthsimpleChequing(pages, currency);
        setPdf(statement);
        setFileName(file.name);
        setFormat("pdf");
        setProfileId(null);
        const ws = accounts.find((a) => /wealthsimple/i.test(a.name) && /chequ|check/i.test(a.name));
        if (ws) setAccount(ws.id);
        setBytes(read);
      } catch (e) {
        setPdfProblem(e instanceof PdfStatementError ? e.problem : "unreadable");
      } finally {
        setReadingPdf(false);
      }
      return;
    }
    const f = detectFormat(read);
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
    if (format === "pdf") return pdf ? { lines: pdf.lines, skipped: [] } : null;
    try {
      if (format === "ofx") return readOfx(bytes, currency);
      if (format === "qif") return readQif(bytes, currency, qifDate);
      return profile ? readCsv(bytes, profile, currency) : null;
    } catch {
      return null;
    }
  }, [bytes, format, profile, qifDate, currency, pdf]);
  const deduped = useMemo(() => (result ? dropRepeatedBankIds(result.lines) : null), [result]);

  // Android falls back to the first category (Housing on a server-created household, which
  // has no "both" category). The web ends with Other and Other income: what no rule, known
  // merchant or categorizer recognised (categorize.ts).
  const uncategorizedExpense = fallbackCategory(config.categories, "expense");
  const uncategorizedIncome = fallbackCategory(config.categories, "income");
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
      knownMerchants: true,
      knownTransfers: true,
    });
  }, [deduped, account, config, rows, uncategorized, uncategorizedExpense, uncategorizedIncome]);
  const fresh = proposals.filter((p) => !p.alreadyImported);

  // Step 3: what nothing else recognised goes to the categorizer, when the server has one.
  const [modelOn, setModelOn] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState<Record<string, ModelAnswer>>({});
  const [asking, setAsking] = useState(0);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    void categorizer.enabled().then((on) => live && setModelOn(on));
    return () => { live = false; };
  }, []);
  const unknown = useMemo(
    () => fresh.filter((p) => p.source === "fallback" && isCategorised(p.transaction.kind) && !asked.current.has(p.transaction.id)),
    [fresh],
  );
  useEffect(() => {
    if (!modelOn || unknown.length === 0) return;
    const items = unknown.slice(0, 200).map((p) => ({
      id: p.transaction.id, date: p.transaction.date, description: p.line.description, amount_minor: p.transaction.amount_minor,
      minor_units: currency.minorUnits, institution: accounts.find((a) => a.id === p.transaction.account_id)?.name ?? null,
    }));
    for (const i of items) asked.current.add(i.id);
    setAsking((n) => n + items.length);
    void categorizer.ask(items).then((got) => {
      setAnswers((a) => ({ ...a, ...got }));
      setAsking((n) => Math.max(0, n - items.length));
    });
  }, [modelOn, unknown, currency.minorUnits, accounts]);
  const createdCategories = useMemo(() => newCategories(proposals), [proposals]);
  const createdAccounts = useMemo(() => newAccounts(proposals), [proposals]);
  // The account a model transfer goes to: the household's of that name, one this import makes, or a new one.
  const accountNamed = (name: string, type: Account["type"]): Account => {
    const k = name.trim().toLowerCase();
    return config.accounts.find((a) => !a.archived && a.name.trim().toLowerCase() === k)
      ?? createdAccounts.find((a) => a.name.trim().toLowerCase() === k)
      ?? { id: accountIdFor(config.household.id, name), name, type, opening_balance_minor: 0, opening_balance_date: null,
        round_up_to: null, round_up_multiplier: null, sort: config.accounts.length + createdAccounts.length, archived: false };
  };
  type Guess = { transfer: null; category: Category; fixed: boolean } | { transfer: Account; direction: "out" | "in"; category: null };
  const modelGuess = (t: Transaction, description: string): Guess | null => {
    const a = answers[t.id];
    if (!a) return null;
    const move = modelTransfer(a, description, t.kind);
    if (move) {
      const other = accountNamed(move.counterpart, move.counterpartType);
      if (other.id !== t.account_id) return { transfer: other, direction: move.direction, category: null };
    }
    const c = modelCategory(config.categories, a, t.kind);
    // Fixed or flexible is the category's to say (categories.fixed), never the model's.
    return c ? { transfer: null, category: c, fixed: !!c.fixed } : null;
  };
  /** A line the model calls a transfer, as one: out of the totals, between two accounts. */
  const asTransfer = (t: Transaction, g: Extract<Guess, { category: null }>): Transaction => ({
    ...t, kind: "transfer", category_id: null, paid_by_member_id: null, split: null, recurrence: "variable",
    account_id: g.direction === "out" ? t.account_id : g.transfer.id,
    to_account_id: g.direction === "out" ? g.transfer.id : t.account_id,
  });
  const brandNew = createdCategories.filter((c) => !config.categories.some((k) => k.id === c.id));
  const statedCurrency = bytes && format === "ofx" ? ofxCurrency(bytes) : format === "pdf" && pdf ? pdf.currency : null;
  // A PDF's running balances, checked line by line (wealthsimplePdf.ts): a line that does not add up
  // was misread or is missing one before it, so the import waits until you have looked.
  const balance = format === "pdf" && pdf ? pdf.balance : null;
  const mismatchAt = useMemo(() => new Set((balance?.mismatches ?? []).map((m) => m.index)), [balance]);
  const balanceBlocks = !!balance && !balance.ok && !acceptMismatch;
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
      const modelAccounts = new Map<string, Account>();
      const txs = fresh.map((p) => {
        const t = p.transaction;
        const chosen = overrides[t.id];
        if (chosen) {
          const c = config.categories.find((k) => k.id === chosen);
          return { ...t, category_id: chosen, recurrence: c?.fixed ? ("fixed" as const) : t.recurrence };
        }
        const guess = p.source === "fallback" ? modelGuess(t, p.line.description) : null;
        if (!guess) return t;
        if (guess.category === null) {
          if (!config.accounts.some((a) => a.id === guess.transfer.id)) modelAccounts.set(guess.transfer.id, guess.transfer);
          return asTransfer(t, guess);
        }
        return { ...t, category_id: guess.category.id, recurrence: guess.fixed ? ("fixed" as const) : t.recurrence };
      });
      const used = new Set(txs.map((t) => t.category_id).filter(Boolean));
      const accountsUsed = new Set(txs.flatMap((t) => [t.account_id, t.to_account_id]).filter(Boolean));
      const made = new Map(createdAccounts.map((a) => [a.id, a]));
      for (const [id, a] of modelAccounts) if (!made.has(id)) made.set(id, a);
      const n = await onImport(txs, [...made.values()].filter((a) => accountsUsed.has(a.id)), createdCategories.filter((c) => used.has(c.id)));
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
        accept=".csv,.ofx,.qfx,.qif,.txt,.pdf,text/csv,application/x-ofx,application/vnd.intu.qfx,application/pdf"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = "";
        }}
      />
      {!bytes ? (
        <EmptyState title="Bring in a statement" text="OFX, QFX, QIF or CSV from your bank, or a Wealthsimple chequing PDF. It is read here, on this phone; importing the same file again adds nothing twice.">
          <PrimaryButton onClick={() => fileInput.current?.click()} busy={readingPdf} testId="choose-file">Choose a file</PrimaryButton>
          {readingPdf && <p className="t-secondary text-ink-muted pt-4">Reading the PDF…</p>}
          {done !== null && <p className="t-body pt-4" data-testid="import-done">Imported {done} transaction{done === 1 ? "" : "s"}.</p>}
          {unreadable && <p className="t-body text-danger pt-4">That file is not a statement Fulla can read.</p>}
          {pdfProblem && <p className="t-body text-danger pt-4" data-testid="pdf-problem">{PDF_PROBLEMS[pdfProblem]}</p>}
          {error && <p className="t-secondary text-danger pt-4">{error}</p>}
        </EmptyState>
      ) : (
        <>
          <p className="t-secondary text-ink-muted px-5">
            {fileName} · {format === "ofx" ? "OFX / QFX" : format === "pdf" ? `Wealthsimple chequing PDF${pdf?.period ? `, ${pdf.period}` : ""}` : format.toUpperCase()}
          </p>
          {balance && balance.ok && (
            <p className="t-secondary text-money-in px-5 pt-2" data-testid="balance-ok">
              Every running balance adds up
              {balance.openingMinor !== null && balance.closingMinor !== null
                ? `: ${formatMoney(balance.openingMinor, "CAD", locale)} to ${formatMoney(balance.closingMinor, "CAD", locale)}.`
                : "."}
            </p>
          )}
          {balance && !balance.ok && (
            <div className="px-5 pt-2" data-testid="balance-mismatch">
              <p className="t-secondary text-danger">
                {balance.mismatches.length > 0
                  ? `${balance.mismatches.length} ${balance.mismatches.length === 1 ? "line does" : "lines do"} not add up to the balance the statement prints (marked below). A line may have been misread or missed.`
                  : ""}
                {balance.closingMatches === false
                  ? ` The last balance is not the closing balance of ${formatMoney(balance.closingMinor ?? 0, "CAD", locale)}.`
                  : ""}
              </p>
              <label className="t-secondary flex items-center gap-2 pt-2">
                <input type="checkbox" checked={acceptMismatch} onChange={(e) => setAcceptMismatch(e.target.checked)} data-testid="accept-mismatch" />
                I have checked these lines; import anyway
              </label>
            </div>
          )}
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
          {(() => {
            const by = (src: string) => fresh.filter((p) => p.source === src).length;
            const guessed = fresh.filter((p) => p.source === "fallback" && !overrides[p.transaction.id]).map((p) => modelGuess(p.transaction, p.line.description)).filter(Boolean);
            const modelled = guessed.length;
            const moved = fresh.filter((p) => p.transaction.kind === "transfer").length + guessed.filter((g) => g!.category === null).length;
            const parts = [
              by("rule") && `${by("rule")} by your rules`,
              moved && `${moved} transfers (not spending)`,
              by("merchant") && `${by("merchant")} known shops`,
              modelled && `${modelled} by the categorizer`,
              by("fallback") - modelled > 0 && `${by("fallback") - modelled} to Other`,
            ].filter(Boolean);
            return parts.length > 0 ? <p className="t-secondary text-ink-muted px-5" data-testid="sorted-summary">Sorted: {parts.join(" · ")}{asking > 0 ? " · asking the categorizer…" : ""}</p> : null;
          })()}
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
            {proposals.slice(0, 200).map((p, i) => {
              const t = p.transaction;
              const guess = p.source === "fallback" && !p.alreadyImported ? modelGuess(t, p.line.description) : null;
              const modelMove = guess && guess.category === null && !overrides[t.id] ? guess : null;
              const cat = overrides[t.id] ?? guess?.category?.id ?? (modelMove ? "" : t.category_id);
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
                          {modelMove && <option value="">Transfer {modelMove.direction === "out" ? "to" : "from"} {modelMove.transfer.name}</option>}
                          {[...categoriesFor(config, t.kind), ...createdCategories.filter((c) => !config.categories.some((k) => k.id === c.id))].map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span data-testid="by-transfer">
                          · transfer{p.matchedTransfer ? ` ${p.matchedTransfer.direction === "out" ? "to" : "from"} ${p.matchedTransfer.counterpart}` : ""}
                        </span>
                      )}
                      {mismatchAt.has(i) && <span className="text-danger" data-testid="row-mismatch">· balance does not add up</span>}
                      {!overrides[t.id] && !p.alreadyImported && (
                        p.source === "rule" && p.matchedRule ? <span data-testid="by-rule">· by rule “{p.matchedRule.pattern}”</span>
                          : p.source === "merchant" ? <span data-testid="by-merchant">· known shop</span>
                            : modelMove ? <span data-testid="by-model">· transfer, by categorizer</span>
                              : guess ? <span data-testid="by-model">· by categorizer</span> : null
                      )}
                    </div>
                  </div>
                  <div className={`t-amount ${p.line.amountMinor > 0 ? "text-money-in" : "text-ink"}`}>{formatMoney(p.line.amountMinor, currency.code, locale, true)}</div>
                </div>
              );
            })}
          </div>
          {error && <p className="t-secondary text-danger px-5 pt-3">{error}</p>}
          <div className="p-5 grid gap-3">
            <PrimaryButton onClick={() => void runImport()} disabled={fresh.length === 0 || balanceBlocks} busy={busy} testId="import-run">
              Import {fresh.length}
            </PrimaryButton>
            <button type="button" className="t-secondary text-ink-muted py-2" onClick={() => { setBytes(null); setPdf(null); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
