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
  /**
   * What the statement itself says the line is, when its layout says (a card's
   * payments section, an investment account's activity code); categorizing
   * then follows it before anything else:
   *  - card-payment: a payment that reached the card (a transfer from the bank);
   *  - transfer: money moved between the household's own accounts;
   *  - credit: a refund or credit on a card (reduces spending);
   *  - card-interest, fee: what the card or account charged;
   *  - dividend, interest: what an investment account paid;
   *  - grant: a government grant into an RESP (the account's, not the household's income).
   */
  role?: LineRole | null;
  /** A purchase made in another currency: the amount in that currency (minor units, positive) and its code. */
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
}

export type LineRole = "card-payment" | "transfer" | "credit" | "card-interest" | "fee" | "dividend" | "interest" | "grant";

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
  type: "checking" | "savings" | "credit_card" | "investment" | "other" | null;
  /** Four digits (or, for an account number with letters, its last four letters and digits, upper case), or null. */
  last4: string | null;
  /**
   * The balance at the end, as the account's balance: what a card is owed is
   * negative (a liability), an investment account is its market value.
   */
  closingBalanceMinor: number | null;
  /** YYYY-MM-DD. */
  closingDate: string | null;
  /** What to call a new account for it, before the digits: "Example Bank Gold Card", "Example Broker TFSA". */
  label?: string | null;
  /** YYYY-MM-DD: the first day the statement covers, when it says. */
  periodStart?: string | null;
  /** The statement's version when it says (an amended statement replaces the one before); 1 otherwise. */
  version?: number | null;
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
