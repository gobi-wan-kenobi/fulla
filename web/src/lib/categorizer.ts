// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The optional categorizer model: a fine-tuned chat model that reads one
 * transaction and answers with a parent category from a 19-category budget
 * taxonomy, a subcategory, and whether the spending is fixed or flexible.
 * It is only ever called by the server (app/api/categorize), with a key that
 * stays there; the browser sends the text of the lines that nothing else
 * knew and maps the answer onto the household's own categories here.
 *
 * Only category names are in this file: the mapping from the model's
 * taxonomy to Fulla's starting categories.
 */
import { categoryForKey, debtCategory, insuranceCategory, insuranceKind, isCatchAll } from "./categorize";
import type { DebtKind } from "./defaults";
import { allows, type Account, type Category, type TransactionKind } from "./model";
import { CREDIT_CARD, OTHER_ACCOUNT, isPersonToPerson, knownDebt } from "./transfers";

export const DEFAULT_CATEGORIZER_MODEL = "ft:gpt-4.1-2025-04-14:personal:transaction-processor:Bb3M10Qu";

export const SYSTEM_PROMPT =
  "You are a financial transaction categorization assistant. Analyze transactions and provide accurate parent category, subcategory, spending type, and merchant classifications using a comprehensive budget hierarchy.";

export interface ModelItem {
  id: string;
  date: string;
  description: string;
  /** Positive minor units. */
  amount_minor: number;
  /** Minor units per major unit (2 for CAD). */
  minor_units?: number;
  institution?: string | null;
  /** Which way the money went, from the statement's sign. */
  direction?: "out" | "in";
  /** How often the household has seen this payee (categorize/facts.ts). */
  how_often_seen?: string;
}

export interface ModelAnswer {
  parent: string;
  subcategory: string | null;
  /** What the model says; kept for reference only. Whether spending is fixed is the category's flag. */
  spending: "fixed" | "flexible" | null;
  /** Jev only: how sure it is of the parent (flat.confidence), 0 to 1. */
  confidence?: number | null;
  /** Jev only: below the cutoff, so the line is not filed but sent to review (Other, tagged needs-review). */
  review?: boolean;
  /** Which categorizer answered. */
  by?: "jev" | "openai" | "local";
}

// Hyphens the model writes that are not "-": soft hyphen, the U+2010–U+2015 hyphens and dashes,
// hyphen bullet, minus sign, small and full-width hyphen-minus.
const HYPHENS = /[\u00ad\u2010-\u2015\u2043\u2212\ufe58\ufe63\uff0d]/g;

/** A label from the model as plain text: every kind of hyphen as "-", spaces collapsed. */
export function normalizeLabel(s: string): string {
  return s.replace(HYPHENS, "-").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

/** The user message, in the form the model was trained on. */
export function userPrompt(item: ModelItem): string {
  const units = item.minor_units ?? 2;
  const amount = (Math.abs(item.amount_minor) / 10 ** units).toFixed(units);
  const lines = [`Categorize this transaction:`, `Date: ${item.date}`, `Description: ${item.description.slice(0, 200)}`, `Amount: $${amount}`];
  if (item.institution) lines.push(`Institution: ${item.institution.toUpperCase().slice(0, 40)}`);
  return lines.join("\n");
}

/** "Parent Category: …\nSubcategory: …\nSpending Type: …\nMerchant: …" → its parts; null when it is not that. */
export function parseAnswer(text: string): ModelAnswer | null {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const parent = normalizeLabel(fields["parent category"] ?? fields["category"] ?? "");
  if (!parent) return null;
  const st = (fields["spending type"] ?? "").toLowerCase();
  return {
    parent,
    subcategory: normalizeLabel(fields["subcategory"] ?? "") || null,
    spending: st === "fixed" ? "fixed" : st === "flexible" ? "flexible" : null,
  };
}

/** Names compared without case, accents, or the kind of hyphen and ampersand. */
function key(s: string): string {
  return normalizeLabel(s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")).toLowerCase();
}

/** The model's parent categories → Fulla's starting category keys. Null: not a category (a transfer, a saving). */
const PARENTS: Record<string, string | null> = {
  "income": "other_income",
  "dining & take-out": "eating_out",
  "groceries": "groceries",
  "entertainment & recreation": "leisure",
  "shopping": "shopping",
  "transportation": "transport",
  "debt payments": "debt_payments",
  "utilities": "utilities",
  "personal care": "health",
  "savings & investing": null,
  "miscellaneous fees": "other",
  "insurance": "insurance",
  "education & self-improvement": "education",
  "healthcare": "health",
  "housing": "housing",
  "travel & vacation": "leisure",
  "shipping": "shopping",
  "child & dependent care": "other",
  "transfers": null,
};

/** Subcategories that say more than their parent. */
const SUBCATEGORIES: Record<string, string> = {
  "salary & wages": "salary",
  "interest & dividends": "interest",
  "interest": "interest",
  "streaming subscriptions": "subscriptions",
  "subscriptions": "subscriptions",
  "online learning apps": "education",
  "gifts & flowers": "gifts",
  "charitable donations": "gifts",
  "donations": "gifts",
  "school supplies": "education",
  "rideshare/taxi (commute)": "transport",
  "gym membership": "health",
};

/** A Debt payments subcategory label from the model as one of Fulla's kinds of debt; the description wins when it says. */
export function debtKind(subcategory: string | null, description = ""): DebtKind {
  const said = knownDebt(description, -1);
  if (said && said.kind !== "other_debt") return said.kind;
  const s = key(subcategory ?? "");
  if (/line of credit|\bloc\b|heloc/.test(s)) return "line_of_credit";
  if (/bnpl|buy now|pay later|instal?lment plan/.test(s)) return "bnpl";
  if (/student/.test(s)) return "student_loan";
  if (/\b(auto|car|vehicle)\b/.test(s)) return "car_loan";
  if (/personal|loan/.test(s)) return "personal_loan";
  return said?.kind ?? "other_debt";
}

/** Fulla's starting category key for an answer, or null when it names none. */
export function modelKey(answer: ModelAnswer, kind: TransactionKind): string | null {
  const sub = answer.subcategory ? SUBCATEGORIES[key(answer.subcategory)] : undefined;
  const parent = PARENTS[key(answer.parent)];
  if (parent === undefined || parent === null) return null;
  if (kind === "income") return parent === "other_income" ? (sub === "salary" || sub === "interest" ? sub : "other_income") : null;
  if (parent === "other_income") return null; // money out the model calls income: not trusted
  return sub && sub !== "salary" && sub !== "interest" ? sub : parent;
}

const STOP = new Set(["and", "or", "the", "of", "for", "a", "an", "to"]);

/** A name's words, for comparing loosely: no case, accents, punctuation, "and", or plural s. */
function tokens(s: string): Set<string> {
  return new Set(
    key(s).replace(/&/g, " and ").split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && !STOP.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/** 2: the same words; 1: one name's words all in the other's ("Rent" and "Rent / Mortgage"); 0: neither. */
export function nameMatch(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  const inY = [...x].every((w) => y.has(w));
  const inX = [...y].every((w) => x.has(w));
  return inX && inY ? 2 : inX || inY ? 1 : 0;
}

/**
 * The household's category for an answer, or null to fall through to Other.
 * The parent decides which of Fulla's categories it is; then, when the
 * household has a subcategory of it (or a category of its own) whose name is
 * the model's subcategory, loosely ("Rent" → "Rent / Mortgage"), that one.
 */
export function modelCategory(categories: Category[], answer: ModelAnswer, kind: TransactionKind, description = ""): Category | null {
  const k = modelKey(answer, kind);
  if (!k) return null;
  if (k === "debt_payments") {
    if (/mortgage/.test(key(answer.subcategory ?? ""))) return categoryForKey(categories, "housing", kind);
    return debtCategory(categories, debtKind(answer.subcategory, description)) ?? categoryForKey(categories, "other", kind);
  }
  if (k === "insurance") return insuranceCategory(categories, insuranceKind(description) ?? insuranceKind(answer.subcategory ?? ""));
  if (k === "interest") return categoryForKey(categories, "interest", kind) ?? categoryForKey(categories, "other_income", kind);
  const base = categoryForKey(categories, k, kind);
  const sub = answer.subcategory;
  if (!sub) return base;
  const live = categories.filter((c) => !c.archived && allows(c.applies_to, kind) && !isCatchAll(c));
  const best = (list: Category[]) => {
    let found: { c: Category; score: number } | null = null;
    for (const c of [...list].sort((a, b) => a.sort - b.sort)) {
      const score = nameMatch(sub, c.name);
      if (score > (found?.score ?? 0)) found = { c, score };
    }
    return found;
  };
  // A subcategory of the chosen one first; then any category named for the subcategory itself.
  const child = base ? best(live.filter((c) => c.parent_id === base.id)) : null;
  if (child) return child.c;
  const other = best(live.filter((c) => c.id !== base?.id));
  if (other && (other.score === 2 || !base)) return other.c;
  return base;
}

/** Every parent category the model knows, for the test that the mapping covers them all. */
export const MODEL_PARENTS = Object.keys(PARENTS);

/** The account at the other end when the model says a line is money moving between your own accounts. */
export interface ModelTransfer {
  counterpart: string;
  counterpartType: Account["type"];
  direction: "out" | "in";
}

/**
 * What Fulla does with a model's answer. A model never makes a transfer: a
 * line becomes one only when it is matched with the other account's line, a
 * person says so, or one of the household's own rules does. So an answer that
 * means a transfer (modelTransfer) files nothing: the line goes to review with
 * no suggestion. An unsure answer (review) files nothing either, but its
 * category, when it is a real one, is kept as the suggestion review shows.
 */
export interface ModelOutcome {
  /** The category to file the line in, or null (it stays in Other). */
  category: Category | null;
  /** True: the line goes to review. */
  review: boolean;
  /** The category review suggests (never a transfer, never a catch-all), with the model's confidence. */
  suggestion: Category | null;
  confidence: number | null;
}

export function modelOutcome(categories: Category[], answer: ModelAnswer | null | undefined, kind: TransactionKind, description = ""): ModelOutcome | null {
  if (!answer) return null;
  const confidence = typeof answer.confidence === "number" ? answer.confidence : null;
  if (modelTransfer(answer, description, kind)) return { category: null, review: true, suggestion: null, confidence: null };
  const c = modelCategory(categories, answer, kind, description);
  if (answer.review) return { category: null, review: true, suggestion: c && !isCatchAll(c) ? c : null, confidence };
  return { category: c, review: false, suggestion: null, confidence };
}

/**
 * When the model's answer means a transfer rather than spending (and so is
 * never applied, see modelOutcome): its
 * Transfers and Savings & Investing, and a Debt Payment that is a credit card
 * bill (the spending is on the card's own statement). Never for money to or
 * from a person (an Interac e-Transfer may be spending), and never for a loan,
 * a line of credit or a buy-now-pay-later plan: those are Debt payments,
 * spending. Null: map it to a category.
 */
export function modelTransfer(answer: ModelAnswer, description: string, kind: TransactionKind): ModelTransfer | null {
  if (kind !== "expense" && kind !== "income") return null;
  if (isPersonToPerson(description) || knownDebt(description, -1)) return null;
  const direction = kind === "expense" ? "out" : "in";
  const parent = key(answer.parent);
  const sub = key(answer.subcategory ?? "");
  if (parent === "transfers") {
    if (/credit ?-?card/.test(sub)) return { counterpart: CREDIT_CARD, counterpartType: "credit_card", direction };
    return { counterpart: OTHER_ACCOUNT, counterpartType: "other", direction };
  }
  if (parent === "savings & investing") return { counterpart: OTHER_ACCOUNT, counterpartType: "other", direction };
  if (parent === "debt payments" && kind === "expense" && /credit ?-?card/.test(sub)) {
    return { counterpart: CREDIT_CARD, counterpartType: "credit_card", direction };
  }
  return null;
}
