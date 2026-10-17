// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Money that only moves between the household's own accounts, recognised
 * from the statement text alone: it becomes a transfer (out of the spending
 * and income totals, still in History under Transfers), never spending.
 *
 *  - Moves between your own accounts at one bank, as Wealthsimple writes
 *    them: "Transfer out to <account>", "Transfer in from <account>",
 *    "Transfer out", "Transfer in". An Interac e-Transfer is NOT one of these:
 *    to another person it is spending, so it is left alone.
 *  - Credit card bill payments from the bank ("Online bill payment for
 *    <card>", "MASTERCARD PAYMENT", "VISA PMT") and, on the card's own
 *    statement, the payment arriving ("PAYMENT - THANK YOU").
 *  - Pre-authorised payments to a loan or line of credit ("... LOAN",
 *    "LINE OF CREDIT", "STUDENT LOAN").
 *
 * Never decided here: buy-now-pay-later and consumer lenders (Affirm,
 * easyfinancial, Klarna, goPeer, …), whose payments the household may want counted
 * as spending; and mortgages, which are the household's housing cost
 * (merchants.ts puts them in Housing).
 *
 * Only generic words: nothing here names a household's own accounts or people.
 */
import type { Account } from "./model";
import { normalizeName } from "./text";

export type TransferReason = "own-account" | "card-payment" | "loan";

export interface KnownTransfer {
  /** The household account at the other end, by name (made when the household has none of that name). */
  counterpart: string;
  counterpartType: Account["type"];
  /** "out": from the imported account to the counterpart; "in": the other way. */
  direction: "out" | "in";
  reason: TransferReason;
}

/** The counterpart's name when the text names no account. */
export const OTHER_ACCOUNT = "Other account";
export const CREDIT_CARD = "Credit card";
export const LOAN = "Loan";
export const BANK_ACCOUNT = "Bank account";

const CONSUMER_LENDERS =
  /\b(affirm|easy ?financial|klarna|afterpay|after pay|clearpay|paybright|pay bright|sezzle|uplift|zip ?pay|fairstone|spring financial|lendcare|katapult|pay in 4|go ?peer|mogo|lendful|cashco|money ?mart|easyhome)\b/;
const PERSON_TO_PERSON = /\b(e ?-?transfer|etransfer|interac|email money|zelle|venmo|cash ?app|paypal|wise|remitly|western union|moneygram)\b/;

/** Payments the household decides about itself: buy-now-pay-later and consumer lenders. */
export function isConsumerLender(description: string): boolean {
  return CONSUMER_LENDERS.test(normalizeName(description));
}

/** Money to or from a person (Interac e-Transfer and the like): spending or income, not a transfer. */
export function isPersonToPerson(description: string): boolean {
  return PERSON_TO_PERSON.test(normalizeName(description));
}

const CARD = /\b(mastercard|master card|visa|amex|american express|credit card|capital one|cards?)\b/;
const PAYMENT = /\b(payment|paymt|pymt|pmt|paiement|bill pay(ment)?)\b/;
const NOT_A_CARD_PAYMENT = /\b(purchase|debit purchase|achat|refund|cash advance|fee|interest|annual)\b/;
const LOAN_WORDS = /\b(loans?|line of credit|lines of credit|heloc|student loan|nslsc|auto finance|car finance|vehicle finance|auto loan|car loan)\b/;

/** "Text, account ••••1234 (executed at …)" → "Text"; spaces and trailing punctuation tidied. */
function payeeName(text: string): string {
  return text
    .replace(/,?\s*account\b.*$/i, "")
    .replace(/\(.*$/, "")
    .replace(/[\s,;:\-–]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** What the text says about the card, for an account name: the payee, or the network. */
function cardName(original: string, words: string): string {
  const m = /\bbill payment (?:for|to)\s+(.+)$/i.exec(original);
  if (m) {
    const name = payeeName(m[1]);
    if (name) return name;
  }
  if (/\b(amex|american express)\b/.test(words)) return "American Express";
  if (/\bcapital one\b/.test(words)) return "Capital One";
  if (/\bmaster ?card\b/.test(words)) return "Mastercard";
  if (/\bvisa\b/.test(words)) return "Visa";
  return CREDIT_CARD;
}

/**
 * The transfer a statement line is, or null when it is not plainly one.
 * amountMinor is signed as the statement has it: negative is money out.
 */
export function knownTransfer(description: string, amountMinor: number): KnownTransfer | null {
  const original = description.replace(/\s+/g, " ").trim();
  const words = normalizeName(original);
  if (!words || amountMinor === 0 || isConsumerLender(original) || isPersonToPerson(original)) return null;
  const out = amountMinor < 0;

  // Between your own accounts at one bank (Wealthsimple's wording).
  let m = /^transfer out(?: to (.+))?$/i.exec(original);
  if (m && out) return { counterpart: payeeName(m[1] ?? "") || OTHER_ACCOUNT, counterpartType: "other", direction: "out", reason: "own-account" };
  m = /^transfer in(?: from (.+))?$/i.exec(original);
  if (m && !out) return { counterpart: payeeName(m[1] ?? "") || OTHER_ACCOUNT, counterpartType: "other", direction: "in", reason: "own-account" };

  // The card's own statement: the payment from the bank arriving.
  if (!out && /\b(payment|paiement)\b.{0,6}\b(thank you|merci)\b|\b(thank you|merci)\b.{0,6}\b(payment|paiement)\b/.test(words)) {
    return { counterpart: BANK_ACCOUNT, counterpartType: "checking", direction: "in", reason: "card-payment" };
  }

  // A credit card bill paid from the bank.
  if (out && CARD.test(words) && PAYMENT.test(words) && !NOT_A_CARD_PAYMENT.test(words)) {
    return { counterpart: cardName(original, words), counterpartType: "credit_card", direction: "out", reason: "card-payment" };
  }

  // A loan or line of credit paid down.
  if (out && LOAN_WORDS.test(words) && !/\b(mortgage|mtg)\b/.test(words)) {
    const lender = /\b(?:debit|payment|pad)\s+(?:to|for)\s+(.+)$/i.exec(original);
    return { counterpart: (lender && payeeName(lender[1])) || LOAN, counterpartType: "other", direction: "out", reason: "loan" };
  }
  return null;
}
