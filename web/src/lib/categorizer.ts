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
import { categoryForKey } from "./categorize";
import type { Category, TransactionKind } from "./model";

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
}

export interface ModelAnswer {
  parent: string;
  subcategory: string | null;
  spending: "fixed" | "flexible" | null;
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
  const parent = fields["parent category"] ?? fields["category"];
  if (!parent) return null;
  const st = (fields["spending type"] ?? "").toLowerCase();
  return {
    parent,
    subcategory: fields["subcategory"] || null,
    spending: st === "fixed" ? "fixed" : st === "flexible" ? "flexible" : null,
  };
}

/** Names compared without case, accents, or the kind of hyphen and ampersand. */
function key(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\u2010-\u2015\-]/g, "-").replace(/\s+/g, " ").trim();
}

/** The model's parent categories → Fulla's starting category keys. Null: not a category (a transfer, a saving). */
const PARENTS: Record<string, string | null> = {
  "income": "other_income",
  "dining & take-out": "eating_out",
  "groceries": "groceries",
  "entertainment & recreation": "leisure",
  "shopping": "shopping",
  "transportation": "transport",
  "debt payments": "other",
  "utilities": "utilities",
  "personal care": "health",
  "savings & investing": null,
  "miscellaneous fees": "other",
  "insurance": "other",
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

/** Fulla's starting category key for an answer, or null when it names none. */
export function modelKey(answer: ModelAnswer, kind: TransactionKind): string | null {
  const sub = answer.subcategory ? SUBCATEGORIES[key(answer.subcategory)] : undefined;
  const parent = PARENTS[key(answer.parent)];
  if (parent === undefined || parent === null) return null;
  if (kind === "income") return parent === "other_income" ? (sub === "salary" ? "salary" : "other_income") : null;
  if (parent === "other_income") return null; // money out the model calls income: not trusted
  return sub && sub !== "salary" ? sub : parent;
}

/** The household's category for an answer, or null to fall through to Other. */
export function modelCategory(categories: Category[], answer: ModelAnswer, kind: TransactionKind): Category | null {
  const k = modelKey(answer, kind);
  return k ? categoryForKey(categories, k, kind) : null;
}

/** Every parent category the model knows, for the test that the mapping covers them all. */
export const MODEL_PARENTS = Object.keys(PARENTS);
