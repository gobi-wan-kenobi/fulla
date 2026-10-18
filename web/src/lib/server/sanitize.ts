// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A statement line as the categorizer may see it: what was bought or paid
 * stays, the people and numbers go. Run on the server before anything leaves
 * for an outside categorizer (Jev). Generic patterns only; nothing here names
 * a household, a person or an account.
 *
 *  - Interac e-Transfers lose the other person: "INTERAC e-Transfer sent" / "… received".
 *  - "Transfer to Firstname Lastname" becomes "Transfer to a person" (not for a business word).
 *  - E-mail addresses, phone numbers, masked and long account or card numbers,
 *    and reference codes (letters and two digits or more mixed) are removed;
 *    a store number glued to a name ("SAQ23167") keeps the name.
 *  - Bank and card-issuer names become "bank": in testing they pulled
 *    ordinary purchases into Savings & Investing.
 */

const BANKS = [
  String.raw`wealth\s*simple`, String.raw`\bws\b`, String.raw`royal\s*bank`, String.raw`\brbc\b`, String.raw`\btd(\s*canada\s*trust)?\b`,
  String.raw`\bbmo\b`, String.raw`\bcibc\b`, String.raw`scotia\s*bank`, String.raw`\bscotia\b`, String.raw`tangerine`, String.raw`desjardins`,
  String.raw`national\s+bank`, String.raw`\bhsbc\b`, String.raw`simplii`, String.raw`\beq\s*bank\b`, String.raw`\bneo(\s+financial|\s+money)?\b`,
  String.raw`\bkoho\b`, String.raw`pc\s+financial`, String.raw`capital\s+one`, String.raw`american\s+express`, String.raw`\bamex\b`,
  String.raw`\btriangle\b`, String.raw`\bmbna\b`, String.raw`\batb\b`, String.raw`\bmeridian\b`,
];
const BANK_RE = new RegExp(BANKS.join("|"), "gi");
const BUSINESS = new Set([
  "canada", "inc", "ltd", "llc", "corp", "co", "investments", "invest", "crypto", "bank", "financial", "money", "savings", "account", "pay",
  "store", "services", "group", "insurance", "capital", "coinbase", "virgocx", "wonderfi", "newton", "shakepay", "bitbuy", "ndax",
]);

function code(t: string): string {
  const m = /^([A-Za-z]{2,})(\d+)$/.exec(t);
  if (m) return m[1]; // a store number on a name
  if ((t.match(/\d/g) ?? []).length < 2) return t; // FIT4LESS, A1
  return "";
}

const RULES: [string, RegExp, (m: string) => string][] = [
  ["etransfer_to", /\b(interac\s+)?e-?\s?transfer\S*\s*(out\s+to|to|sent\s+to)\s*:?\s*.+$/i, () => "INTERAC e-Transfer sent"],
  ["etransfer_from", /\b(interac\s+)?e-?\s?transfer\S*\s*(in\s+from|from|received\s+from)\s*:?\s*.+$/i, () => "INTERAC e-Transfer received"],
  ["executed_at", /\(\s*executed at[^)]*\)?/gi, () => ""],
  ["email", /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, () => ""],
  ["phone", /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, () => ""],
  ["masked_number", /(account\s*)?[∙•·*xX#]{2,}\s*\d{2,}/gi, () => ""],
  ["ref_code", /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,}\b/g, (m) => code(m)],
  ["digit_run", /#?\b\d{4,}\b/g, () => ""],
  ["bank_name", BANK_RE, () => "bank"],
];
const PERSON = /\b(?:transfer|payment|deposit|sent|send)\s+(?:to|from)\s+((?:[A-Z][a-zA-Z'.-]*\s*){1,3})$/i;
const CAPITALISED = /^(?:[A-Z][a-zA-Z'.-]*\s*){1,3}$/;

/** The line without people, numbers or bank names, and which rules removed something. */
export function scrub(description: string): { text: string; fired: string[] } {
  let s = description.replace(/\s+/g, " ").trim();
  const fired: string[] = [];
  for (const [name, rx, rep] of RULES) {
    const next = s.replace(rx, (m) => rep(m));
    if (next !== s) {
      fired.push(name);
      s = next;
    }
  }
  const m = PERSON.exec(s);
  if (m && CAPITALISED.test(m[1]) && !m[1].split(/\s+/).some((w) => BUSINESS.has(w.toLowerCase().replace(/\.$/, "")))) {
    s = s.slice(0, m.index + m[0].length - m[1].length).trimEnd() + " a person";
    fired.push("person_name");
  }
  s = s.replace(/\b(bank)(\s+bank)+\b/gi, "$1").replace(/\s*,\s*(?=,|$)/g, "").replace(/\s{2,}/g, " ").replace(/^[\s,\-/]+|[\s,\-/]+$/g, "");
  return { text: s || "unknown", fired };
}
