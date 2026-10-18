// SPDX-License-Identifier: GPL-3.0-or-later
import { type Currency, parseMoney } from "../money";
import { parseDate } from "./dates";
import { decodeText } from "./decode";
import { lastFour, type SkippedLine, type StatementAccountInfo, type StatementLine, type StatementResult } from "./types";

/**
 * OFX 1.x (SGML, tags often left open) and 2.x (XML). QFX, Quicken's name for
 * the same thing with an extra <INTU.BID> tag, reads the same.
 */
const TRANSACTION = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi;

export function detectOfx(bytes: Uint8Array): number {
  const head = decodeText(bytes).slice(0, 2048).toUpperCase();
  return head.includes("OFXHEADER") || head.includes("<OFX>") ? 1 : 0;
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  const v = m?.[1].trim();
  return v ? v : null;
}

/** The currency the statement says it is in (CURDEF), if it says. */
export function ofxCurrency(bytes: Uint8Array): string | null {
  return tag(decodeText(bytes), "CURDEF");
}

export function readOfx(bytes: Uint8Array, currency: Currency): StatementResult {
  const text = decodeText(bytes);
  const lines: StatementLine[] = [];
  const skipped: SkippedLine[] = [];
  let i = 0;
  for (const m of text.matchAll(TRANSACTION)) {
    i++;
    const block = m[1];
    const posted = tag(block, "DTPOSTED");
    const date = posted ? parseDate(posted.slice(0, 8), "yyyyMMdd") : null;
    const raw = tag(block, "TRNAMT");
    const style = raw && raw.includes(",") && !raw.includes(".") ? "comma" : "dot";
    const amount = raw ? parseMoney(raw, currency, style) : null;
    if (!date || amount === null || amount === 0) {
      skipped.push({ line: i, reason: !date ? "date" : "amount" });
      continue;
    }
    const description = [...new Set([tag(block, "NAME"), tag(block, "MEMO")].filter((s): s is string => !!s))].join(" · ");
    lines.push({ date, amountMinor: amount, description, bankId: tag(block, "FITID") });
  }
  return { lines, skipped, statement: ofxAccount(text, currency) };
}

const OFX_TYPES: Record<string, StatementAccountInfo["type"]> = { CHECKING: "checking", SAVINGS: "savings", MONEYMRKT: "savings", CREDITLINE: "other" };

/** The account an OFX file is for: <FI><ORG>, the account type, the last four of <ACCTID>, and <LEDGERBAL>. */
export function ofxAccount(text: string, currency: Currency): StatementAccountInfo | null {
  const card = /<CCACCTFROM>/i.test(text);
  const from = /<(?:BANKACCTFROM|CCACCTFROM)>([\s\S]*?)(?:<\/(?:BANKACCTFROM|CCACCTFROM)>|<BANKTRANLIST>)/i.exec(text)?.[1] ?? "";
  const last4 = lastFour(tag(from, "ACCTID"));
  const acctType = tag(from, "ACCTTYPE")?.toUpperCase() ?? "";
  const ledger = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i.exec(text)?.[1] ?? "";
  const raw = tag(ledger, "BALAMT");
  const asOf = tag(ledger, "DTASOF");
  const balance = raw ? parseMoney(raw, currency, raw.includes(",") && !raw.includes(".") ? "comma" : "dot") : null;
  const org = tag(text, "ORG");
  if (!last4 && balance === null && !org) return null;
  return {
    institution: org ? org.slice(0, 40) : null,
    type: card ? "credit_card" : OFX_TYPES[acctType] ?? (acctType ? "other" : null),
    last4,
    closingBalanceMinor: balance,
    closingDate: asOf ? parseDate(asOf.slice(0, 8), "yyyyMMdd") : null,
  };
}
