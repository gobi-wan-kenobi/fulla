// SPDX-License-Identifier: GPL-3.0-or-later
import { DATE_FORMATS } from "./dates";
import { guessColumns, guessDateFormat, guessDecimal, guessExtras, guessFixedValues, guessIncomeValues } from "./columnGuess";
import { guessDelimiter, previewCsv } from "./csv";
import { decodeText } from "./decode";
import { type ImportProfile, profile } from "./types";

/**
 * A new CSV starts from what its header and first values suggest, as the
 * Android import screen's guess() does, plus two corrections for Canadian
 * bank exports: a column that says "type" but holds no money-in word (RBC's
 * "Account Type": Chequing) does not decide the sign, and an "account"
 * column holding only numbers (RBC's "Account Number") is not a list of
 * account names.
 */
export function guessProfile(bytes: Uint8Array, householdCurrency: string): ImportProfile {
  const rows = previewCsv(bytes, 30);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const found = guessColumns(header);
  const column = (i: number | undefined | null) => (i == null ? [] : body.map((r) => r[i]).filter((v): v is string => v !== undefined));
  const extras = guessExtras(header, householdCurrency, found);
  const dateColumn = found.date ?? 0;
  const amountColumn = extras.amount ?? 1;
  let kindColumn = found.kind ?? null;
  let incomeValues = guessIncomeValues([...new Set(column(kindColumn))]);
  if (kindColumn !== null && incomeValues.length === 0) {
    kindColumn = null;
    incomeValues = [];
  }
  let accountColumn = found.account ?? null;
  if (accountColumn !== null && column(accountColumn).every((v) => /^[\d\s-]*$/.test(v))) accountColumn = null;
  const fixedColumn = found.recurrence ?? null;
  return profile({
    delimiter: guessDelimiter(decodeText(bytes)),
    dateColumn,
    dateFormat: guessDateFormat(column(dateColumn), DATE_FORMATS) ?? DATE_FORMATS[0],
    amount: { mode: "single", column: amountColumn },
    decimal: guessDecimal(column(amountColumn)) ?? "dot",
    descriptionColumns: extras.descriptions.length ? extras.descriptions : [2],
    categoryColumn: found.category ?? null,
    kindColumn,
    incomeValues,
    payerColumn: found.payer ?? null,
    accountColumn,
    fixedColumn,
    fixedValues: guessFixedValues([...new Set(column(fixedColumn))]),
  });
}
