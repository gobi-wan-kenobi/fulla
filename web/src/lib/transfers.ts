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
 *
 * Not transfers: repaying a loan, a line of credit, a student or car loan, a
 * consumer lender or a buy-now-pay-later plan (Affirm, easyfinancial, goPeer,
 * Klarna, …). That money leaves the household, so it is spending, in the
 * fixed Debt payments category (knownDebt below). Mortgages are the
 * household's housing cost (merchants.ts puts them in Housing).
 *
 * Only generic words: nothing here names a household's own accounts or people.
 */
import type { DebtKind } from "./defaults";
import type { Account } from "./model";
import { normalizeName } from "./text";

export type TransferReason = "own-account" | "card-payment";

export interface KnownTransfer {
  /** The household account at the other end, by name (made when the household has none of that name). */
  counterpart: string;
  counterpartType: Account["type"];
  /** "out": from the imported account to the counterpart; "in": the other way. */
  direction: "out" | "in";
  reason: TransferReason;
  /** The last four digits of the counterpart's number, when the text shows them ("account ••••0042"). */
  counterpartLast4?: string | null;
}

/** The counterpart's name when the text names no account. */
export const OTHER_ACCOUNT = "Other account";
export const CREDIT_CARD = "Credit card";
export const BANK_ACCOUNT = "Bank account";

const BNPL = /\b(affirm|klarna|afterpay|after pay|clearpay|paybright|pay bright|sezzle|uplift|zip ?pay|katapult|pay in 4|paypal pay later)\b/;
const PERSONAL_LENDERS =
  /\b(easy ?financial|fairstone|spring financial|lendcare|go ?peer|mogo|lendful|cashco|money ?mart|easyhome|uei financial|uei|loans ?canada|lend ?direct|iceberg finance|consumer capital|prestige finance|cash ?money|magical credit|borrowell)\b/;
const CONSUMER_LENDERS = new RegExp(`${BNPL.source}|${PERSONAL_LENDERS.source}`);
const PERSON_TO_PERSON = /\b(e ?-?transfer|etransfer|interac|email money|zelle|venmo|cash ?app|paypal|wise|remitly|western union|moneygram)\b/;

const TO_A_PERSON = /\b(e ?-?transfer|etransfer|email money transfer|zelle|venmo|cash ?app|remitly|western union|moneygram)\b/;

/** An e-Transfer (or the like) to or from a person; never a card purchase that merely says Interac. */
export function isTransferWithPerson(description: string): boolean {
  return TO_A_PERSON.test(normalizeName(description));
}

/**
 * The other party of an e-Transfer as its statement shows it ("Interac
 * e-Transfer® Out to Example Person" → "Example Person"); null when it names
 * nobody. For the household's own screens and rules only: it is never sent
 * to a categorizer.
 */
export function personOf(description: string): string | null {
  if (!isTransferWithPerson(description)) return null;
  const m = /\b(?:to|from|sent to|received from|recipient|de|a|à)\s*:?\s+([^\d@#*|,;]{2,60}?)\s*(?:\(|\bref\b|\bconf\b|$)/i.exec(description.replace(/[®™]/g, ""));
  const name = m?.[1]?.trim().replace(/\s+/g, " ") ?? "";
  return name.length >= 2 ? name : null;
}

/** Buy-now-pay-later plans and consumer lenders: their payments are Debt payments, never transfers. */
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
const LINE_OF_CREDIT = /\b(line of credit|lines of credit|heloc|loc payment|loc pmt|personal loc|marge de credit)\b/;
const STUDENT_LOAN = /\b(student loans?|nslsc|osap|csfa|canada student|studentaid|student aid)\b/;
const CAR_LOAN = /\b(auto finance|car finance|vehicle finance|auto loan|car loan|vehicle loan|toyota financial|honda financial|ford credit|gm financial|nissan canada finance|hyundai capital|kia finance|scotia dealer|td auto finance|rbc auto|bmw financial|mercedes benz financial|vw credit)\b/;
const LOAN = /\b(loans?|pret|lending|lender|instalment|installment)\b/;
const MORTGAGE = /\b(mortgage|mtg|hypotheque)\b/;

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
    const last4 = /account\s*[∙•·*xX#]{2,}\s*(\d{4})\b/i.exec(original)?.[1] ?? null;
    return { counterpart: cardName(original, words), counterpartType: "credit_card", direction: "out", reason: "card-payment", counterpartLast4: last4 };
  }

  return null;
}

export interface KnownDebt {
  /** Which Debt payments subcategory (web-categories.json keys). */
  kind: DebtKind;
}

/**
 * The debt a payment repays, or null when it is not plainly one. Only money
 * out; never a mortgage (Housing), a credit card bill (a transfer), or money
 * to a person. amountMinor is signed as the statement has it.
 */
export function knownDebt(description: string, amountMinor: number): KnownDebt | null {
  const words = normalizeName(description.replace(/\s+/g, " ").trim());
  if (!words || amountMinor >= 0 || MORTGAGE.test(words) || isPersonToPerson(description)) return null;
  if (BNPL.test(words)) return { kind: "bnpl" };
  if (STUDENT_LOAN.test(words)) return { kind: "student_loan" };
  if (CAR_LOAN.test(words)) return { kind: "car_loan" };
  if (LINE_OF_CREDIT.test(words)) return { kind: "line_of_credit" };
  if (PERSONAL_LENDERS.test(words)) return { kind: "personal_loan" };
  if (CARD.test(words) && PAYMENT.test(words)) return null;
  if (LOAN.test(words)) return { kind: "other_debt" };
  return null;
}
