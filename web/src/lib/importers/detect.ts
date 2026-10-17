// SPDX-License-Identifier: GPL-3.0-or-later
import { detectCsv } from "./csv";
import { detectOfx } from "./ofx";
import { detectQif } from "./qif";
import type { StatementLine } from "./types";

export type StatementFormat = "ofx" | "qif" | "csv";

/**
 * Which importer reads a file, from its content and never its name: a bank's
 * .qfx, .ofx or a .txt that is really OFX all read as OFX (the same order as
 * the Android import screen: OFX, then QIF, else CSV). Null when nothing can.
 */
export function detectFormat(bytes: Uint8Array): StatementFormat | null {
  if (bytes.length === 0) return null;
  if (detectOfx(bytes) > 0.5) return "ofx";
  if (detectQif(bytes) > 0.5) return "qif";
  if (detectCsv(bytes) > 0) return "csv";
  return null;
}

/**
 * Web addition: a line whose bank id (OFX/QFX FITID) already appeared earlier
 * in the same file is the bank repeating itself, not a second purchase, and
 * is dropped. Lines without an id are all kept: two identical coffees on one
 * day are two coffees (ImportPlan's ordinal keeps them apart).
 */
export function dropRepeatedBankIds(lines: StatementLine[]): { lines: StatementLine[]; repeated: number } {
  const seen = new Set<string>();
  const out: StatementLine[] = [];
  let repeated = 0;
  for (const l of lines) {
    if (l.bankId) {
      if (seen.has(l.bankId)) {
        repeated++;
        continue;
      }
      seen.add(l.bankId);
    }
    out.push(l);
  }
  return { lines: out, repeated };
}
