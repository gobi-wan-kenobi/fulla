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

export interface StatementResult {
  lines: StatementLine[];
  skipped: SkippedLine[];
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
