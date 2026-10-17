// SPDX-License-Identifier: GPL-3.0-or-later
import { type Currency, type DecimalStyle, parseMoney } from "../money";
import { parseDate } from "./dates";
import { decodeText } from "./decode";
import type { SkippedLine, StatementLine, StatementResult } from "./types";

export function detectQif(bytes: Uint8Array): number {
  return decodeText(bytes).trimStart().toLowerCase().startsWith("!type") ? 1 : 0;
}

/** QIF has no standard date order; dateFormat says which (e.g. "MM/dd/yyyy" or "dd/MM/yyyy"). */
export function readQif(bytes: Uint8Array, currency: Currency, dateFormat: string, decimal: DecimalStyle = "dot"): StatementResult {
  const lines: StatementLine[] = [];
  const skipped: SkippedLine[] = [];
  let fields = new Map<string, string>();
  let record = 0;
  for (const raw of decodeText(bytes).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("!")) continue;
    if (line === "^") {
      record++;
      // Some writers use an apostrophe before a two-digit year: 1/15'30.
      const dateText = fields.get("D")?.replace(/'/g, "/").replace(/ /g, "0");
      const date = dateText ? parseDate(dateText, dateFormat) : null;
      const t = fields.get("T") ?? fields.get("U");
      const amount = t ? parseMoney(t, currency, decimal) : null;
      if (!date || amount === null || amount === 0) {
        skipped.push({ line: record, reason: !date ? "date" : "amount" });
      } else {
        const description = [...new Set([fields.get("P"), fields.get("M")].filter((s): s is string => !!s))].join(" · ");
        lines.push({ date, amountMinor: amount, description, bankCategory: fields.get("L") ?? null });
      }
      fields = new Map();
      continue;
    }
    fields.set(line[0], line.slice(1).trim());
  }
  return { lines, skipped };
}
