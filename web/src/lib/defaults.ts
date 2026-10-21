// SPDX-License-Identifier: GPL-3.0-or-later
import data from "@/data/categories.json";
import web from "@/data/web-categories.json";
import type { AppliesTo } from "./model";

export interface DefaultSubcategory {
  key: string;
  name: Record<string, string>;
  fixed?: boolean;
  /** Money in here is not the household's income (Government grants). */
  excluded_from_income?: boolean;
}

export interface DefaultCategory {
  key: string;
  applies_to: AppliesTo;
  icon: string;
  color_index: number;
  name: Record<string, string>;
  /** Web fork only: spending in it is usually the same every month. */
  fixed?: boolean;
  /** Web fork only: the subcategories a new household gets under it. */
  subcategories?: DefaultSubcategory[];
}

/** The phone's starting categories, from testdata/defaults/categories.json (core's Defaults). */
export const SHARED_DEFAULT_CATEGORIES: DefaultCategory[] = data.categories as DefaultCategory[];
/** The web fork's own starting categories (testdata/defaults/web-categories.json, fulla.web_defaults()). */
export const WEB_DEFAULT_CATEGORIES: DefaultCategory[] = web.categories as DefaultCategory[];
/** Subcategories of a shared starting category (web-categories.json shared_subcategories, 0035): Subscriptions › Software. */
export interface SharedSubcategories { parent: string; subcategories: DefaultSubcategory[] }
export const SHARED_SUBCATEGORIES: SharedSubcategories[] = ((web as { shared_subcategories?: SharedSubcategories[] }).shared_subcategories ?? []);
/** What a new household starts with: the shared defaults, then the web's (Debt payments). */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [...SHARED_DEFAULT_CATEGORIES, ...WEB_DEFAULT_CATEGORIES];
export const UNCATEGORIZED: DefaultCategory = data.uncategorized as DefaultCategory;

export const DEBT_KEY = "debt_payments";
export const INSURANCE_KEY = "insurance";
export type InsuranceKind = "life_insurance" | "home_insurance" | "auto_insurance" | "health_insurance";
export const INTEREST_KEY = "interest";
export const FEES_KEY = "fees";
export const INVESTMENT_INCOME_KEY = "investment_income";
export type DebtKind = "card_interest" | "personal_loan" | "line_of_credit" | "bnpl" | "student_loan" | "car_loan" | "other_debt";
