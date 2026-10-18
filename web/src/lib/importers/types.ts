// SPDX-License-Identifier: GPL-3.0-or-later
import type { DecimalStyle } from "../money";

/** One line of a statement. amountMinor is signed: negative is money out. */
export interface StatementLine {
  date: string; // YYYY-MM-DD
  amountMinor: number;
  description: string;
  /** The bank's own category text, if the file has one. */
  bankCategory?: string | null;
  /** An id the bank gives the line (OFX/QFX FITID), if any. */
  bankId?: string | null;
  /** Who paid, as the file writes it: matched to a member by name. */
  payer?: string | null;
  /** Which account, as the file writes it: matched to an account by name. */
  account?: string | null;
  /** True when the file marks the line as a fixed amount; null when it says nothing. */
  fixed?: boolean | null;
}

export interface SkippedLine {
  line: number;
  reason: "date" | "amount";
}

/**
 * What a statement says about its own account, when it says: the bank, the
 * kind of account, the last four digits of its number (never more), and the
 * balance at the end. Used to find (or offer to make) the account on import.
 */
export interface StatementAccountInfo {
  institution: string | null;
  type: "checking" | "savings" | "credit_card" | "other" | null;
  /** Exactly four digits, or null. */
  last4: string | null;
  closingBalanceMinor: number | null;
  /** YYYY-MM-DD. */
  closingDate: string | null;
}

/** The last four digits of an account number as printed ("Account number: 000012345", "••••0042"); null for fewer than four. */
export function lastFour(text: string | null | undefined): string | null {
  const digits = (text ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export interface StatementResult {
  lines: StatementLine[];
  skipped: SkippedLine[];
  statement?: StatementAccountInfo | null;
}

export type AmountColumns =
  | { mode: "single"; column: number; negativeIsExpense?: boolean }
  | { mode: "split"; debitColumn: number; creditColumn: number };

/** How to read one CSV layout (core's ImportProfile). */
export interface ImportProfile {
  /** Null: detect (UTF-8 if the bytes are valid UTF-8, else Windows-1252). */
  encoding?: string | null;
  delimiter: string;
  skipRows: number;
  hasHeader: boolean;
  dateColumn: number;
  dateFormat: string;
  amount: AmountColumns;
  decimal: DecimalStyle;
  descriptionColumns: number[];
  categoryColumn?: number | null;
  kindColumn?: number | null;
  incomeValues?: string[];
  payerColumn?: number | null;
  accountColumn?: number | null;
  fixedColumn?: number | null;
  fixedValues?: string[];
}

export function profile(p: Partial<ImportProfile> & Pick<ImportProfile, "dateColumn" | "dateFormat" | "amount">): ImportProfile {
  return {
    encoding: null,
    delimiter: ",",
    skipRows: 0,
    hasHeader: true,
    decimal: "dot",
    descriptionColumns: [],
    categoryColumn: null,
    kindColumn: null,
    incomeValues: [],
    payerColumn: null,
    accountColumn: null,
    fixedColumn: null,
    fixedValues: [],
    ...p,
  };
}
