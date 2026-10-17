// SPDX-License-Identifier: GPL-3.0-or-later
// A saved CSV column mapping, in the shape fulla.save_import_profile stores
// (client/.../local/ImportProfiles.kt), so a mapping saved on the web is the
// same one the Android app offers, and the other way round.
import type { SavedImportProfile } from "../model";
import { type ImportProfile, profile } from "./types";

export interface SavedProfile {
  id: string;
  name: string;
  accountId: string | null;
  profile: ImportProfile;
}

export function profileToJson(p: SavedProfile): SavedImportProfile {
  const m = p.profile;
  const mapping: Record<string, unknown> = {};
  if (m.encoding) mapping.encoding = m.encoding;
  Object.assign(mapping, {
    delimiter: m.delimiter,
    skip_rows: m.skipRows,
    has_header: m.hasHeader,
    date_column: m.dateColumn,
    date_format: m.dateFormat,
    decimal: m.decimal === "comma" ? "," : ".",
    amount:
      m.amount.mode === "single"
        ? { mode: "single", column: m.amount.column, negative_is_expense: m.amount.negativeIsExpense ?? true }
        : { mode: "split", debit_column: m.amount.debitColumn, credit_column: m.amount.creditColumn },
    description_columns: m.descriptionColumns,
    category_column: m.categoryColumn ?? null,
    kind_column: m.kindColumn ?? null,
    income_values: m.incomeValues ?? [],
    payer_column: m.payerColumn ?? null,
    account_column: m.accountColumn ?? null,
    fixed_column: m.fixedColumn ?? null,
    fixed_values: m.fixedValues ?? [],
  });
  return { id: p.id, name: p.name, format: "csv", account_id: p.accountId, mapping };
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function profileFromJson(o: SavedImportProfile): SavedProfile | null {
  try {
    const m = o.mapping as Record<string, unknown>;
    const a = m.amount as Record<string, unknown>;
    const dateColumn = int(m.date_column);
    const dateFormat = typeof m.date_format === "string" ? m.date_format : null;
    if (dateColumn === null || !dateFormat || !a) return null;
    const amount =
      a.mode === "split"
        ? { mode: "split" as const, debitColumn: int(a.debit_column)!, creditColumn: int(a.credit_column)! }
        : { mode: "single" as const, column: int(a.column)!, negativeIsExpense: a.negative_is_expense !== false };
    if (amount.mode === "split" ? amount.debitColumn === null || amount.creditColumn === null : amount.column === null) return null;
    return {
      id: o.id,
      name: o.name,
      accountId: o.account_id ?? null,
      profile: profile({
        encoding: typeof m.encoding === "string" ? m.encoding : null,
        delimiter: typeof m.delimiter === "string" && m.delimiter ? m.delimiter[0] : ",",
        skipRows: int(m.skip_rows) ?? 0,
        hasHeader: m.has_header !== false,
        dateColumn,
        dateFormat,
        amount,
        decimal: m.decimal === "," ? "comma" : "dot",
        descriptionColumns: (Array.isArray(m.description_columns) ? m.description_columns : []).map(int).filter((x): x is number => x !== null),
        categoryColumn: int(m.category_column),
        kindColumn: int(m.kind_column),
        incomeValues: strs(m.income_values),
        payerColumn: int(m.payer_column),
        accountColumn: int(m.account_column),
        fixedColumn: int(m.fixed_column),
        fixedValues: strs(m.fixed_values),
      }),
    };
  } catch {
    return null;
  }
}
