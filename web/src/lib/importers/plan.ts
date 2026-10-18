// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from core/.../importers/ImportPlan.kt; keep the two in step. The ids
// it derives are the same as the phone's, so a statement imported on Android
// and again here is recognised as already imported.
import { DEFAULT_CATEGORIES } from "../defaults";
import { importedId, sha256Hex, uuid5 } from "../ids";
import type { Account, AppliesTo, CategorizationRule, Category, Member, Split, Transaction, TransactionKind } from "../model";
import { type CategorySource, debtCategory, incomingKind, knownMerchant, matchRule, merchantCategory, type MerchantMatch } from "../categorize";
import { normalizeName } from "../text";
import { type KnownDebt, type KnownTransfer, knownDebt, knownTransfer } from "../transfers";
import { defaultKeys, iconFor, synonymsOf } from "./hints";
import type { StatementLine } from "./types";

export { matchRule } from "../categorize";

export interface ProposedTransaction {
  transaction: Transaction;
  line: StatementLine;
  matchedRule: CategorizationRule | null;
  /** Where the category came from (web only): a rule, the file, a known merchant, or the catch-all. */
  source: CategorySource | null;
  /** The known merchant that set the category, when one did. */
  matchedMerchant: MerchantMatch | null;
  /** Web only: the built-in transfer pattern that made this line a transfer (transfers.ts), when one did. */
  matchedTransfer?: KnownTransfer | null;
  /** Web only: the debt repayment pattern that put this line in Debt payments (transfers.ts), when one did. */
  matchedDebt?: KnownDebt | null;
  /** The household already holds a row with this id: importing again changes nothing. */
  alreadyImported: boolean;
  /** A category this line needs written first: new, or existing and widened to both kinds. */
  newCategory: Category | null;
  /** Accounts the file names that the household does not have yet. */
  newAccounts: Account[];
}

export interface ImportNames {
  categories: Category[];
  members: Member[];
  accounts: Account[];
}

export function fingerprint(accountId: string, line: StatementLine, ordinal: number): string {
  return sha256Hex([accountId, line.date, String(line.amountMinor), normalizeName(line.description), String(ordinal)].join("|"));
}

export function accountIdFor(householdId: string, name: string): string {
  return uuid5(householdId, `account|${normalizeName(name)}`);
}

export function categoryIdFor(householdId: string, name: string): string {
  return uuid5(householdId, `category|${normalizeName(name)}`);
}

export interface ProposeInput {
  householdId: string;
  accountId: string;
  lines: StatementLine[];
  rules: CategorizationRule[];
  uncategorizedExpenseId: string;
  uncategorizedIncomeId: string;
  payerMemberId: string;
  defaultSplit: Split | null;
  existingIds: Set<string>;
  now: string;
  names?: ImportNames;
  /** Web only: after the rules and the file, try the built-in known merchants (merchants.ts). */
  knownMerchants?: boolean;
  /**
   * Web only: after the rules and the file, before the known merchants, lines
   * that plainly move money between the household's own accounts (a transfer
   * between accounts, a card bill payment) become transfers (transfers.ts),
   * to an account of that name, made when there is none; and repayments of a
   * loan, a line of credit or a buy-now-pay-later plan go to Debt payments
   * (fixed spending), when the household has that category.
   */
  knownTransfers?: boolean;
}

function sameCategory(a: Category, b: Category): boolean {
  return (
    a.id === b.id && a.name === b.name && a.applies_to === b.applies_to && a.parent_id === b.parent_id &&
    a.icon === b.icon && a.color_index === b.color_index && a.sort === b.sort && a.archived === b.archived
  );
}

/** Turns statement lines into transactions, with ids derived from their content. */
export function propose(input: ProposeInput): ProposedTransaction[] {
  const { householdId, accountId, lines, rules, names = { categories: [], members: [], accounts: [] } } = input;
  const seen = new Map<string, number>();
  const accounts = new Map<string, Account>();
  for (const a of names.accounts.filter((a) => !a.archived)) accounts.set(normalizeName(a.name), a);
  const members = new Map<string, Member>();
  const active = names.members.filter((m) => m.status === "active");
  for (const m of active) members.set(normalizeName(m.initials), m);
  for (const m of active) members.set(normalizeName(m.display_name), m);
  const categories = names.categories.filter((c) => !c.archived);

  // The categories a name can mean: its own name first, then, for one of
  // Fulla's starting categories, any of its names and their synonyms.
  const byName = new Map<string, Category[]>();
  const ordered = [...categories].sort((a, b) => Number(a.parent_id !== null) - Number(b.parent_id !== null));
  const push = (k: string, c: Category) => {
    const list = byName.get(k) ?? [];
    if (!list.includes(c)) list.push(c);
    byName.set(k, list);
  };
  for (const c of ordered) push(normalizeName(c.name), c);
  for (const c of ordered) {
    const keys = defaultKeys(c.name);
    const aliases = new Set<string>([
      ...DEFAULT_CATEGORIES.filter((d) => keys.includes(d.key)).flatMap((d) => [...Object.values(d.name), d.key]).map(normalizeName),
      ...synonymsOf(keys),
    ]);
    for (const a of aliases) push(a, c);
  }

  const newAccounts = new Map<string, Account>();
  const accountFor = (name: string, type: Account["type"] = "other"): Account => {
    const key = normalizeName(name);
    const existing = accounts.get(key) ?? newAccounts.get(key);
    if (existing) return existing;
    const made: Account = {
      id: accountIdFor(householdId, name), name: name.trim().slice(0, 60), type,
      opening_balance_minor: 0, opening_balance_date: null, round_up_to: null, round_up_multiplier: null,
      sort: accounts.size + newAccounts.size, archived: false,
    };
    newAccounts.set(key, made);
    return made;
  };
  const accountsInFile = new Set(lines.map((l) => (l.account ? normalizeName(l.account) : "")).filter((s) => s.length > 0));

  interface Read {
    line: StatementLine; account: string; rule: CategorizationRule | null; pocket: Account | null; name: string | null;
    merchant: MerchantMatch | null; transfer: { known: KnownTransfer; counterpart: Account } | null;
    debt: { known: KnownDebt; category: Category } | null;
  }
  const read: Read[] = lines.map((line) => {
    const named = line.account?.trim();
    const lineAccount = named ? accountFor(named).id : accountId;
    const rule = matchRule(rules, line.description);
    let pocket: Account | null = null;
    if (line.bankCategory && !rule?.action.category_id) {
      const k = normalizeName(line.bankCategory);
      pocket = accounts.get(k) ?? (accountsInFile.has(k) ? accountFor(line.bankCategory) : null);
      if (pocket && pocket.id === lineAccount) pocket = null;
    }
    const name = line.bankCategory && !rule?.action.category_id && !pocket ? line.bankCategory.trim() || null : null;
    const free = !rule?.action.category_id && !rule?.action.kind && !pocket && !name;
    const known = input.knownTransfers && free ? knownTransfer(line.description, line.amountMinor) : null;
    const counterpart = known ? accountFor(known.counterpart, known.counterpartType) : null;
    const transfer = known && counterpart && counterpart.id !== lineAccount ? { known, counterpart } : null;
    const owed = input.knownTransfers && free && !transfer ? knownDebt(line.description, line.amountMinor) : null;
    const owedCategory = owed ? debtCategory(categories, owed.kind) : null;
    const debt = owed && owedCategory ? { known: owed, category: owedCategory } : null;
    const merchant = input.knownMerchants && free && !transfer && !debt ? knownMerchant(line.description) : null;
    return { line, account: lineAccount, rule, pocket, name, merchant, transfer, debt };
  });

  const kindOf = (r: Read): TransactionKind => {
    if (r.rule?.action.kind === "transfer" && r.line.amountMinor < 0) return "transfer";
    if (r.pocket || r.transfer) return "transfer";
    if (r.line.amountMinor < 0) return "expense";
    if (r.rule?.action.category_id && categories.find((c) => c.id === r.rule!.action.category_id)?.applies_to === "expense") return "refund";
    if (r.merchant && incomingKind(r.line.description) === "refund" && merchantCategory(categories, r.merchant, "refund")) return "refund";
    return "income";
  };
  const kinds = read.map(kindOf);

  const usedFor = new Map<string, Set<TransactionKind>>();
  read.forEach((r, i) => {
    if (!r.name) return;
    const k = normalizeName(r.name);
    const set = usedFor.get(k) ?? new Set();
    set.add(kinds[i]);
    usedFor.set(k, set);
  });
  const written = new Map<string, Category>();
  const widened = new Map<string, Category>();
  const categoryFor = (name: string): Category => {
    const key = normalizeName(name);
    const done = written.get(key);
    if (done) return done;
    const uses = usedFor.get(key) ?? new Set();
    const spends = uses.has("expense") || uses.has("refund");
    const earns = uses.has("income");
    const needs: AppliesTo = spends && earns ? "both" : earns ? "income" : "expense";
    const candidates = byName.get(key) ?? [];
    const existing =
      candidates.find((c) => (!spends || c.applies_to !== "income") && (!earns || c.applies_to !== "expense")) ?? candidates[0];
    const base = existing ? (widened.get(existing.id) ?? existing) : undefined;
    let category: Category;
    if (!base) {
      category = {
        id: categoryIdFor(householdId, name), name: name.slice(0, 60), applies_to: needs, parent_id: null,
        icon: iconFor(name) ?? "label", color_index: (categories.length + written.size) % 12,
        sort: categories.length + written.size, archived: false,
      };
    } else if ((spends && base.applies_to === "income") || (earns && base.applies_to === "expense")) {
      category = { ...base, applies_to: "both" };
      widened.set(category.id, category);
    } else category = base;
    written.set(key, category);
    return category;
  };

  return read.map((r, i) => {
    const line = r.line;
    const kind = kinds[i];
    const identity = `${r.account}|${line.date}|${line.amountMinor}|${normalizeName(line.description)}`;
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    const fp = fingerprint(r.account, line, ordinal);
    const id = importedId(householdId, fp);
    const amount = Math.abs(line.amountMinor);
    const category = r.name && kind !== "transfer" ? categoryFor(r.name) : null;
    const toWrite = category && !categories.some((c) => sameCategory(c, category)) ? category : null;
    const payer = (line.payer ? members.get(normalizeName(line.payer))?.id : undefined) ?? input.payerMemberId;
    const ruled = r.rule?.action.category_id ?? null;
    const owed = !ruled && !category && r.debt && kind === "expense" ? r.debt.category : null;
    const known = !ruled && !category && !owed && r.merchant && kind !== "transfer" ? merchantCategory(categories, r.merchant, kind) : null;
    const chosen = ruled ?? category?.id ?? owed?.id ?? known?.id ?? null;
    const source: CategorySource | null =
      kind === "transfer" ? null : ruled ? "rule" : category ? "file" : owed ? "debt" : known ? "merchant" : "fallback";
    const chosenCategory = chosen ? (categories.find((c) => c.id === chosen) ?? category) : null;
    const fixedByDefault = line.fixed == null && kind !== "transfer" &&
      (!!owed || !!chosenCategory?.fixed || (!!known && !!r.merchant?.merchant.fixed));
    const base: Transaction = {
      id, kind, date: line.date, amount_minor: amount, category_id: null, account_id: null, to_account_id: null,
      paid_by_member_id: null, to_member_id: null, split: null,
      recurrence: (line.fixed === true || fixedByDefault) && kind !== "transfer" ? "fixed" : "variable",
      note: line.description.slice(0, 500), tags: r.rule?.action.tags ?? [], extras: {}, status: "active",
      recurring_rule_id: null, occurrence_date: null, import_fingerprint: fp, original_currency: null,
      trip_id: null, created_at: input.now, client_updated_at: input.now,
    };
    let tx: Transaction;
    if (kind === "transfer") {
      if (r.transfer) {
        tx = r.transfer.known.direction === "out"
          ? { ...base, account_id: r.account, to_account_id: r.transfer.counterpart.id }
          : { ...base, account_id: r.transfer.counterpart.id, to_account_id: r.account };
      } else if (!r.pocket) tx = { ...base, account_id: r.account, to_account_id: r.rule!.action.to_account_id ?? null };
      else if (line.amountMinor < 0) tx = { ...base, account_id: r.account, to_account_id: r.pocket.id };
      else tx = { ...base, account_id: r.pocket.id, to_account_id: r.account };
    } else if (kind === "income") {
      tx = { ...base, account_id: r.account, category_id: chosen ?? input.uncategorizedIncomeId };
    } else {
      tx = {
        ...base, account_id: r.account,
        category_id: chosen ?? input.uncategorizedExpenseId,
        paid_by_member_id: payer, split: input.defaultSplit,
      };
    }
    const used = new Set([tx.account_id, tx.to_account_id].filter(Boolean));
    return {
      transaction: tx, line, matchedRule: r.rule, source, matchedMerchant: source === "merchant" ? r.merchant : null,
      matchedTransfer: r.transfer?.known ?? null, matchedDebt: source === "debt" ? r.debt?.known ?? null : null, alreadyImported: input.existingIds.has(id), newCategory: toWrite,
      newAccounts: [...newAccounts.values()].filter((a) => used.has(a.id)),
    };
  });
}

/** The accounts an import creates, once each. */
export function newAccounts(proposals: ProposedTransaction[]): Account[] {
  const out = new Map<string, Account>();
  for (const p of proposals) if (!p.alreadyImported) for (const a of p.newAccounts) if (!out.has(a.id)) out.set(a.id, a);
  return [...out.values()];
}

/** The categories an import writes, once each: new ones, and existing ones widened to both kinds. */
export function newCategories(proposals: ProposedTransaction[]): Category[] {
  const groups = new Map<string, Category[]>();
  for (const p of proposals) {
    if (p.alreadyImported || !p.newCategory) continue;
    const g = groups.get(p.newCategory.id) ?? [];
    g.push(p.newCategory);
    groups.set(p.newCategory.id, g);
  }
  return [...groups.values()].map((v) => v.find((c) => c.applies_to === "both") ?? v[0]);
}
