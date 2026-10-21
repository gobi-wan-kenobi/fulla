// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which category a transaction gets when nobody chose one, in this order:
 *
 *  1. the household's own rules (categorization_rules, first active one by sort);
 *  2. built-in statement patterns: own-account and card-bill transfers, and
 *     debt repayments into Debt payments (transfers.ts);
 *  3. the built-in list of known merchants (merchants.ts);
 *  4. the categorizer, asked by the server (categorizer.ts, server/categorizer.ts),
 *     which sends what it is unsure of to review;
 *  5. Other / Other income.
 *
 * Everything here is pure, so the import, the entry screen and "apply rules
 * to what is already there" reach the same answer about the same text.
 */
import { DEBT_KEY, type DebtKind, FEES_KEY, INSURANCE_KEY, INTEREST_KEY, INVESTMENT_INCOME_KEY, type InsuranceKind, SHARED_SUBCATEGORIES, UNCATEGORIZED, WEB_DEFAULT_CATEGORIES } from "./defaults";
import { defaultKeys } from "./importers/hints";
import { KNOWN_MERCHANTS, type KnownMerchant } from "./merchants";
import { allows, type CategorizationRule, type Category, type TransactionKind } from "./model";
import { normalizeName } from "./text";
import { knownDebt } from "./transfers";

export type CategorySource = "rule" | "file" | "merchant" | "debt" | "model" | "fallback";

/** A statement's text as words: no accents, lower case, punctuation as spaces (apostrophes dropped). */
export function words(s: string): string {
  return normalizeName(s)
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}&+]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Card networks, wallets and payment processors that bank exports put in front of the merchant.
const PREFIXES = [
  "pos", "opos", "apos", "idp", "purchase", "point of sale", "retail purchase", "card purchase", "visa debit", "debit",
  "contactless", "ctls", "interac purchase", "interac", "apple pay", "google pay", "pre authorized debit to",
  "pre authorized debit", "preauthorized debit", "pad", "bill payment", "sq", "tst", "pp", "paypal", "sp", "fs", "dd",
];
const PROVINCES = new Set(["on", "qc", "bc", "ab", "mb", "sk", "ns", "nb", "nl", "pe", "pei", "yt", "nt", "nu"]);
const COUNTRY = new Set(["ca", "can", "canada", "com", "www"]);
const TWO_WORD_CITIES = new Set([
  "north york", "east york", "richmond hill", "st catharines", "niagara falls", "thunder bay", "red deer", "saint john",
  "st johns", "quebec city", "north vancouver", "west vancouver", "port coquitlam", "sault ste", "grande prairie",
  "medicine hat", "prince george", "new westminster", "stoney creek", "ajax pickering",
]);

/**
 * A bank's merchant string as a person would name the merchant: processor
 * prefixes, store and reference numbers, "*", "#", and a trailing
 * "CITY PROVINCE" or ".CA" removed. "SQ *BLUE DOOR CAFE #12 TORONTO ON" is
 * "blue door cafe". Used for the pattern a new rule proposes.
 */
export function cleanMerchant(raw: string): string {
  let s = words(raw.replace(/#\S*/g, " "));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of PREFIXES) {
      if (s === p) break;
      if (s.startsWith(p + " ")) {
        s = s.slice(p.length + 1);
        changed = true;
      }
    }
  }
  // Tokens that are references, not names: all digits, or two digits or more mixed in.
  let t = s.split(" ").filter((w) => w && !/^\d+$/.test(w) && !(/\d/.test(w) && w.replace(/\D/g, "").length >= 2));
  while (t.length > 1 && COUNTRY.has(t[t.length - 1])) t = t.slice(0, -1);
  if (t.length > 1 && PROVINCES.has(t[t.length - 1])) {
    t = t.slice(0, -1);
    const two = t.slice(-2).join(" ");
    if (t.length > 3 && TWO_WORD_CITIES.has(two)) t = t.slice(0, -2);
    else if (t.length > 1) t = t.slice(0, -1);
  }
  while (t.length > 1 && COUNTRY.has(t[t.length - 1])) t = t.slice(0, -1);
  const out = t.join(" ").trim();
  return out || words(raw);
}

interface Pattern { text: string; merchant: KnownMerchant }

const PATTERNS: Pattern[] = KNOWN_MERCHANTS.flatMap((merchant) => merchant.patterns.map((p) => ({ text: words(p), merchant })))
  .filter((p) => p.text.length > 0)
  .sort((a, b) => b.text.length - a.text.length);

export interface MerchantMatch { merchant: KnownMerchant; pattern: string }

/** The known merchant a statement text names, longest pattern first, as whole words. */
export function knownMerchant(description: string): MerchantMatch | null {
  const text = ` ${words(description)} `;
  for (const p of PATTERNS) if (text.includes(` ${p.text} `)) return { merchant: p.merchant, pattern: p.text };
  return null;
}

/** The household's category that is one of Fulla's starting categories (by any of its names), usable for kind. */
export function categoryForKey(categories: Category[], key: string, kind: TransactionKind): Category | null {
  const live = categories.filter((c) => !c.archived && allows(c.applies_to, kind));
  const named = (c: Category) => defaultKeys(c.name).includes(key);
  return live.find((c) => c.parent_id === null && named(c)) ?? live.find(named) ?? null;
}

/**
 * The household's subcategory for "parent/sub" (a shared starting category's
 * subcategory, SHARED_SUBCATEGORIES; or a web one's), by any of the default's
 * names, under the household's parent; else the parent itself; null without
 * the parent. A plain key is categoryForKey.
 */
export function categoryForPath(categories: Category[], path: string, kind: TransactionKind): Category | null {
  const [p, s] = path.split("/");
  const parent = categoryForKey(categories, p, kind);
  if (!s || !parent) return parent;
  const sub = [...SHARED_SUBCATEGORIES.filter((g) => g.parent === p).flatMap((g) => g.subcategories),
    ...(WEB_DEFAULT_CATEGORIES.find((d) => d.key === p)?.subcategories ?? [])].find((d) => d.key === s);
  if (!sub) return parent;
  const names = new Set(Object.values(sub.name).map(normalizeName));
  return categories.find((c) => !c.archived && c.parent_id === parent.id && allows(c.applies_to, kind) && names.has(normalizeName(c.name))) ?? parent;
}

const DEBT_SUBS = WEB_DEFAULT_CATEGORIES.find((d) => d.key === DEBT_KEY)?.subcategories ?? [];

/**
 * The household's Debt payments category for a kind of debt: its subcategory
 * for that kind (by any of the default's names) when it has one, else Debt
 * payments itself; null when the household has no Debt payments.
 */
export function debtCategory(categories: Category[], kind: DebtKind | null): Category | null {
  const parent = categoryForKey(categories, DEBT_KEY, "expense");
  if (!parent) return null;
  const sub = kind ? DEBT_SUBS.find((d) => d.key === kind) : undefined;
  if (!sub) return parent;
  const names = new Set(Object.values(sub.name).map(normalizeName));
  return categories.find((c) => !c.archived && c.parent_id === parent.id && names.has(normalizeName(c.name))) ?? parent;
}

const GRANTS = WEB_DEFAULT_CATEGORIES.find((d) => d.key === INVESTMENT_INCOME_KEY)?.subcategories?.find((d) => d.key === "grants");

/**
 * Where a government grant into an RESP goes: the household's category left
 * out of income under Investment income (Government grants, by its flag or
 * any of its default names), else Investment income itself.
 */
export function grantsCategory(categories: Category[]): Category | null {
  const parent = categoryForKey(categories, INVESTMENT_INCOME_KEY, "income");
  const names = new Set(Object.values(GRANTS?.name ?? {}).map(normalizeName));
  const live = categories.filter((c) => !c.archived && allows(c.applies_to, "income"));
  return live.find((c) => parent && c.parent_id === parent.id && c.excluded_from_income)
    ?? live.find((c) => parent && c.parent_id === parent.id && names.has(normalizeName(c.name)))
    ?? live.find((c) => c.excluded_from_income)
    ?? investmentIncomeCategory(categories, "dividend");
}

/** Fees (a card's annual fee, an account fee), else Other; null only when there is neither. */
export function feesCategory(categories: Category[]): Category | null {
  return categoryForKey(categories, FEES_KEY, "expense") ?? fallbackCategory(categories, "expense");
}

/**
 * What an investment account pays out: dividends and distributions to
 * Investment income, interest to Interest, each falling back to the other and
 * then to Other income.
 */
export function investmentIncomeCategory(categories: Category[], kind: "dividend" | "interest"): Category | null {
  const keys = kind === "interest" ? [INTEREST_KEY, INVESTMENT_INCOME_KEY] : [INVESTMENT_INCOME_KEY, INTEREST_KEY];
  for (const k of keys) {
    const c = categoryForKey(categories, k, "income");
    if (c) return c;
  }
  return fallbackCategory(categories, "income");
}

export const OTHER_KEY = "other";
export const OTHER_INCOME_KEY = "other_income";

/** The catch-all a transaction falls to: Other for money out, Other income for money in, else Uncategorized. */
export function fallbackCategory(categories: Category[], kind: TransactionKind): Category | null {
  const key = kind === "income" ? OTHER_INCOME_KEY : OTHER_KEY;
  const live = categories.filter((c) => !c.archived && allows(c.applies_to, kind));
  return categoryForKey(categories, key, kind) ?? live.find((c) => c.applies_to === "both") ?? live[live.length - 1] ?? null;
}

/** Rules that can match: active and not deleted, first by sort then id. */
export function liveRules(rules: CategorizationRule[]): CategorizationRule[] {
  return rules
    .filter((r) => r.active && !r.archived)
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "When a note contains pattern, then …" (fulla.save_rule): the first live rule whose pattern is in the text. */
export function matchRule(rules: CategorizationRule[], description: string): CategorizationRule | null {
  const text = normalizeName(description);
  return liveRules(rules).find((r) => text.includes(normalizeName(r.pattern))) ?? null;
}

export interface Suggestion {
  category: Category;
  source: CategorySource;
  rule?: CategorizationRule;
  merchant?: MerchantMatch;
  /** True when this kind of spending is usually the same every period. */
  fixed: boolean;
}

/** The known merchant's category for kind, or null. Money in from a shop is a refund (the caller decides the kind). */
export function merchantCategory(categories: Category[], match: MerchantMatch, kind: TransactionKind, description = ""): Category | null {
  const key = kind === "income" ? match.merchant.income : match.merchant.expense;
  if (key === INSURANCE_KEY && kind !== "income") return insuranceCategory(categories, insuranceKind(description));
  if (key === DEBT_KEY && kind !== "income") return debtCategory(categories, "card_interest");
  return key ? categoryForPath(categories, key, kind) : null;
}

const LIFE = /\b(life|vie|vida|leben|vita)\b|rbcins life|sun life|manulife|canada life|empire life|securian/;
const HOME = /\b(home|house|tenant|tenants|renters?|condo|property|habitation|hogar)\b/;
const AUTO = /\b(auto|car|vehicle|motor|sonnet|belair ?direct)\b/;
const HEALTH = /\b(health|dental|medical|drug plan|blue cross|green shield|travel medical)\b/;

/** Which kind of insurance a statement line is, from its words; null when it does not say. */
export function insuranceKind(description: string): InsuranceKind | null {
  const s = normalizeName(description).replace(/[-_/]+/g, " ");
  if (LIFE.test(s)) return "life_insurance";
  if (HEALTH.test(s)) return "health_insurance";
  if (AUTO.test(s)) return "auto_insurance";
  if (HOME.test(s)) return "home_insurance";
  return null;
}

const INSURANCE_SUBS = WEB_DEFAULT_CATEGORIES.find((d) => d.key === INSURANCE_KEY)?.subcategories ?? [];

/** The household's Insurance subcategory for a kind (by any of the default's names), else Insurance; null without Insurance. */
export function insuranceCategory(categories: Category[], kind: InsuranceKind | null): Category | null {
  const parent = categoryForKey(categories, INSURANCE_KEY, "expense");
  if (!parent) return null;
  const sub = kind ? INSURANCE_SUBS.find((d) => d.key === kind) : undefined;
  if (!sub) return parent;
  const names = new Set(Object.values(sub.name).map(normalizeName));
  return categories.find((c) => !c.archived && c.parent_id === parent.id && names.has(normalizeName(c.name))) ?? parent;
}

/**
 * Steps 1 and 2 for one transaction: a household rule, then a known merchant.
 * Null when neither knows it (the model and the catch-all come after).
 */
export function suggest(description: string, kind: TransactionKind, rules: CategorizationRule[], categories: Category[]): Suggestion | null {
  if (!description.trim() || kind === "transfer" || kind === "settlement") return null;
  const rule = matchRule(rules, description);
  const ruled = rule?.action.category_id ? categories.find((c) => c.id === rule.action.category_id && !c.archived) : undefined;
  if (rule && ruled && allows(ruled.applies_to, kind)) return { category: ruled, source: "rule", rule, fixed: !!ruled.fixed };
  const debt = kind === "expense" ? knownDebt(description, -1) : null;
  const owed = debt ? debtCategory(categories, debt.kind) : null;
  if (owed) return { category: owed, source: "debt", fixed: true };
  const match = knownMerchant(description);
  if (match) {
    const c = merchantCategory(categories, match, kind, description);
    if (c) return { category: c, source: "merchant", merchant: match, fixed: !!c.fixed || !!match.merchant.fixed };
  }
  return null;
}

/** The kind a statement line gets from a known merchant when money comes in: a refund of a shop, else income. */
export function incomingKind(description: string): "income" | "refund" {
  const match = knownMerchant(description);
  return match && match.merchant.expense && !match.merchant.income ? "refund" : "income";
}

const UNCATEGORIZED_NAMES = new Set(Object.values(UNCATEGORIZED.name).map(normalizeName));

/** Categories that mean "nobody has sorted this yet": Uncategorized, Other, Other income. */
export function isCatchAll(c: Category | undefined | null): boolean {
  if (!c) return true;
  const keys = defaultKeys(c.name);
  return keys.includes(OTHER_KEY) || keys.includes(OTHER_INCOME_KEY) || UNCATEGORIZED_NAMES.has(normalizeName(c.name));
}

export interface Recategorization<R> {
  row: R;
  category: Category;
  source: CategorySource;
  fixed: boolean;
}

/**
 * What "apply rules to what is already there" changes: rows still in a
 * catch-all (Uncategorized, Other, Other income) that a rule or a known
 * merchant now recognises. Rows someone put in a real category are left alone.
 */
export function categorizeExisting<R extends { tx: { kind: TransactionKind; note: string; category_id: string | null; status: string } }>(
  rows: R[], rules: CategorizationRule[], categories: Category[],
): Recategorization<R>[] {
  const out: Recategorization<R>[] = [];
  for (const row of rows) {
    const t = row.tx;
    if (t.status !== "active" || (t.kind !== "expense" && t.kind !== "income" && t.kind !== "refund")) continue;
    if (!isCatchAll(categories.find((c) => c.id === t.category_id))) continue;
    const s = suggest(t.note, t.kind, rules, categories);
    if (s && s.category.id !== t.category_id) out.push({ row, category: s.category, source: s.source, fixed: s.fixed });
  }
  return out;
}
