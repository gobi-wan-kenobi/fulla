// SPDX-License-Identifier: GPL-3.0-or-later
import { type Currency, parseMoney } from "../money";
import { normalizeName } from "../text";
import { parseDate } from "./dates";
import { decodeText } from "./decode";
import type { ImportProfile, SkippedLine, StatementLine, StatementResult } from "./types";

/** RFC 4180: quoted fields may contain the delimiter, newlines and doubled quotes. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // dropped
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

/** The delimiter that splits the first lines most consistently into more than one column. */
export function guessDelimiter(text: string): string {
  const sample = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 10);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((line) => parseCsv(line, d)[0]?.length ?? 0);
    const score =
      counts.length === 0 || Math.min(...counts) < 2
        ? 0
        : counts.filter((c) => c === counts[counts.length - 1]).length * 100 + counts[counts.length - 1];
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** How sure the CSV importer is that it can read the file, 0..1. */
export function detectCsv(bytes: Uint8Array): number {
  const text = decodeText(bytes).slice(0, 4096);
  if (text.trimStart().startsWith("<") || text.includes("OFXHEADER") || text.startsWith("!Type")) return 0;
  return (parseCsv(text, guessDelimiter(text))[0]?.length ?? 0) >= 2 ? 0.5 : 0;
}

/** The first rows as cells, for the column-mapping screen. */
export function previewCsv(bytes: Uint8Array, rows = 6): string[][] {
  const text = decodeText(bytes);
  return parseCsv(text, guessDelimiter(text)).slice(0, rows);
}

/** The different values a column holds below the header, most frequent first. */
export function columnValues(bytes: Uint8Array, p: ImportProfile, column: number, limit = 12): string[] {
  const rows = parseCsv(decodeText(bytes, p.encoding), p.delimiter).slice(p.skipRows + (p.hasHeader ? 1 : 0));
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, string>();
  for (const r of rows) {
    const v = r[column]?.trim();
    if (!v) continue;
    const k = normalizeName(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!firstSeen.has(k)) firstSeen.set(k, v);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => firstSeen.get(k)!);
}

/** A statement read through a column mapping (core's CsvImporter.read). */
export function readCsv(bytes: Uint8Array, p: ImportProfile, currency: Currency): StatementResult {
  const income = new Set((p.incomeValues ?? []).map(normalizeName));
  const fixed = new Set((p.fixedValues ?? []).map(normalizeName));
  const rows = parseCsv(decodeText(bytes, p.encoding), p.delimiter);
  const head = p.skipRows + (p.hasHeader ? 1 : 0);
  const body = rows.slice(head);
  const lines: StatementLine[] = [];
  const skipped: SkippedLine[] = [];
  body.forEach((cells, index) => {
    const lineNo = head + 1 + index;
    const cell = (i: number | null | undefined): string | null => (i == null ? null : (cells[i]?.trim() ?? null));
    const date = parseDate(cell(p.dateColumn), p.dateFormat);
    if (!date) {
      skipped.push({ line: lineNo, reason: "date" });
      return;
    }
    let amount: number | null;
    const a = p.amount;
    if (a.mode === "single") {
      const v = parseMoney(cell(a.column) ?? "", currency, p.decimal);
      amount = v === null ? null : a.negativeIsExpense === false ? -v : v;
    } else {
      const d = cell(a.debitColumn) || "";
      const c = cell(a.creditColumn) || "";
      const debit = d ? parseMoney(d, currency, p.decimal) : null;
      const credit = c ? parseMoney(c, currency, p.decimal) : null;
      amount = debit !== null && debit !== 0 ? -Math.abs(debit) : credit !== null ? Math.abs(credit) : null;
    }
    if (amount === null || amount === 0) {
      skipped.push({ line: lineNo, reason: "amount" });
      return;
    }
    const signed = p.kindColumn == null ? amount : income.has(normalizeName(cell(p.kindColumn) ?? "")) ? Math.abs(amount) : -Math.abs(amount);
    const description = p.descriptionColumns
      .map((i) => cell(i))
      .filter((s): s is string => !!s)
      .join(" · ");
    lines.push({
      date,
      amountMinor: signed,
      description,
      bankCategory: cell(p.categoryColumn) || null,
      payer: cell(p.payerColumn) || null,
      account: cell(p.accountColumn) || null,
      fixed: p.fixedColumn == null ? null : fixed.has(normalizeName(cell(p.fixedColumn) ?? "")),
    });
  });
  return { lines, skipped };
}
