// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from core/.../importers/ColumnGuess.kt; keep the two in step.
import type { DecimalStyle } from "../money";
import { MINOR_UNITS } from "../money";
import { normalizeName } from "../text";
import { parseDate } from "./dates";

export type ColumnRole = "date" | "amount" | "description" | "category" | "kind" | "payer" | "account" | "recurrence";
export const COLUMN_ROLES: ColumnRole[] = ["date", "amount", "description", "category", "kind", "payer", "account", "recurrence"];

const WORDS: Record<ColumnRole, string[]> = {
  date: ["date", "fecha", "datum", "data", "booking date", "fecha operacion", "buchungstag", "date operation", "data operazione", "data movimento", "day", "dia"],
  amount: ["amount", "importe", "monto", "cantidad", "betrag", "montant", "importo", "valor", "quantia", "sum", "value", "total"],
  description: ["description", "descripcion", "concepto", "note", "nota", "notes", "memo", "payee", "details", "detalle", "beschreibung", "verwendungszweck", "libelle", "descrizione", "causale", "descricao", "text"],
  category: ["category", "categoria", "kategorie", "categorie"],
  kind: ["type", "tipo", "kind", "flow", "flujo", "typ", "art", "sens", "direction", "movimiento"],
  payer: ["paid by", "payer", "who", "quien", "pagado por", "pagador", "bezahlt von", "wer", "paye par", "qui", "pagato da", "chi", "pago por", "quem", "person", "member", "miembro"],
  account: ["account", "cuenta", "konto", "compte", "conto", "conta", "wallet"],
  recurrence: ["recurrence", "recurrencia", "recurring", "repeats", "repeat", "fixed", "fijo", "recurrente", "wiederkehrend", "fest", "fixe", "ricorrenza", "ricorrente", "fisso", "recorrencia", "recorrente", "fixo"],
};

const FIXED = new Set(["fixed", "fijo", "fija", "fixe", "fest", "fix", "fisso", "fissa", "fixo", "fixa", "recurring", "recurrente", "ricorrente", "recorrente", "wiederkehrend", "yes", "si", "oui", "ja", "sim", "true"]);

const INCOME = new Set(["in", "income", "ingreso", "ingresos", "entrada", "entradas", "credit", "credito", "haber", "abono", "einnahme", "einnahmen", "gutschrift", "revenu", "revenus", "entree", "recette", "entrata", "entrate", "receita", "receitas", "+"]);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which column plays which part. A column plays at most one. */
export function guessColumns(header: string[]): Partial<Record<ColumnRole, number>> {
  const names = header.map(normalizeName);
  const taken = new Set<number>();
  const found: Partial<Record<ColumnRole, number>> = {};
  for (const exact of [true, false]) {
    for (const role of COLUMN_ROLES) {
      if (found[role] !== undefined) continue;
      const words = WORDS[role];
      const i = names.findIndex(
        (n, idx) =>
          !taken.has(idx) &&
          words.some((w) => (exact ? n === w : new RegExp(`(^|[^\\p{L}])${escape(w)}([^\\p{L}]|$)`, "u").test(n))),
      );
      if (i < 0) continue;
      found[role] = i;
      taken.add(i);
    }
  }
  return found;
}

/**
 * Web addition: the columns a North American bank export uses that core's
 * words miss. An amount column named after a currency ("CAD$", "USD $") is
 * the amount when it is the household's currency; and every further column
 * that reads as a description ("Description 1", "Description 2") is joined to
 * the first. Returns the amount column (or undefined) and the description columns.
 */
export function guessExtras(header: string[], householdCurrency: string, found: Partial<Record<ColumnRole, number>>): { amount?: number; descriptions: number[] } {
  const names = header.map(normalizeName);
  let amount = found.amount;
  if (amount === undefined) {
    const own = householdCurrency.toLowerCase();
    const currencyCol = (n: string) => /^([a-z]{3})\s*\$?$/.exec(n)?.[1];
    const exact = names.findIndex((n) => currencyCol(n) === own);
    const any = names.findIndex((n) => {
      const c = currencyCol(n);
      return c !== undefined && MINOR_UNITS[c.toUpperCase()] !== undefined;
    });
    if (exact >= 0) amount = exact;
    else if (any >= 0) amount = any;
  }
  const descriptions: number[] = [];
  if (found.description !== undefined) descriptions.push(found.description);
  const taken = new Set(Object.values(found).filter((v): v is number => v !== undefined));
  if (amount !== undefined) taken.add(amount);
  names.forEach((n, i) => {
    if (taken.has(i) || descriptions.includes(i)) return;
    if (WORDS.description.some((w) => new RegExp(`(^|[^\\p{L}])${escape(w)}([^\\p{L}]|$)`, "u").test(n))) descriptions.push(i);
  });
  return { amount, descriptions };
}

/** The first of candidates that reads every non-blank value, or null. */
export function guessDateFormat(values: string[], candidates: string[]): string | null {
  const sample = values
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, 30);
  if (sample.length === 0) return null;
  return candidates.find((p) => sample.every((v) => parseDate(v, p) !== null)) ?? null;
}

/** Comma or dot, when the amounts make it plain; null when they do not. */
export function guessDecimal(values: string[]): DecimalStyle | null {
  const sample = values.map((v) => v.trim());
  if (sample.some((v) => /\d,\d{1,2}$/.test(v))) return "comma";
  if (sample.some((v) => /\d\.\d{1,2}$/.test(v))) return "dot";
  return null;
}

/** Which of a type column's values mean money in. */
export function guessIncomeValues(values: string[]): string[] {
  return values.filter((v) => INCOME.has(normalizeName(v)));
}

/** Which of a recurrence column's values mean a fixed amount. */
export function guessFixedValues(values: string[]): string[] {
  return values.filter((v) => FIXED.has(normalizeName(v)));
}
