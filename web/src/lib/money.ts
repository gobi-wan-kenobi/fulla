// SPDX-License-Identifier: GPL-3.0-or-later
import currencies from "@/data/currencies.json";

/** Minor units per ISO 4217 code, from testdata/defaults/currencies.json. */
export const MINOR_UNITS: Record<string, number> = currencies.minor_units;

/** What a new household is proposed: Canadian dollars (core's Currency.DEFAULT_FOR_NEW_HOUSEHOLD). */
export const DEFAULT_FOR_NEW_HOUSEHOLD = "CAD";

export interface Currency {
  code: string;
  minorUnits: number;
}

export function currencyOf(code: string): Currency | null {
  const c = code.toUpperCase();
  const units = MINOR_UNITS[c];
  return units === undefined ? null : { code: c, minorUnits: units };
}

export function requireCurrency(code: string): Currency {
  const c = currencyOf(code);
  if (!c) throw new Error(`Unknown currency: ${code}`);
  return c;
}

/** Which character separates the decimals; the other of . and , groups. */
export type DecimalStyle = "dot" | "comma";
const DECIMAL: Record<DecimalStyle, [string, string]> = { dot: [".", ","], comma: [",", "."] };

const CLEAN = /[\s\u00a0\u202f'’\p{Sc}A-Za-z]/gu;
const NUMBER = /^\d+(\.\d+)?$/;

/**
 * Text → minor units (core's MoneyParser.parse). Rounding is half away from
 * zero on the decimal text itself, never through a float.
 */
export function parseMoney(text: string, currency: Currency, style: DecimalStyle): number | null {
  let s = text.trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(CLEAN, "");
  if (s.startsWith("-") || s.startsWith("−")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-") || s.endsWith("−")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const [decimal, grouping] = DECIMAL[style];
  s = s.split(grouping).join("").split(decimal).join(".");
  if (!NUMBER.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const units = currency.minorUnits;
  const kept = (frac + "0".repeat(units)).slice(0, units);
  let minor = BigInt(whole + kept);
  const next = frac.length > units ? frac.charCodeAt(units) - 48 : 0;
  if (next >= 5) minor += BigInt(1);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(minor);
  return negative ? -n : n;
}

/**
 * What a person typed (core's MoneyParser.parseTyped): the separator is
 * whichever of . and , comes last with one or two digits after it; when
 * nothing says, [fallback] decides.
 */
export function parseTyped(text: string, currency: Currency, fallback: DecimalStyle): number | null {
  const trimmed = text.trim();
  const s = trimmed.startsWith(".") || trimmed.startsWith(",") ? "0" + trimmed : trimmed;
  const at = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  const tail = at >= 0 ? s.slice(at + 1) : "";
  const style: DecimalStyle =
    at >= 0 && tail.length >= 1 && tail.length <= 2 && /^\d+$/.test(tail) ? (s[at] === "," ? "comma" : "dot") : fallback;
  return parseMoney(s, currency, style);
}

/**
 * Minor units → text the way the locale writes money, with a real minus sign
 * (U+2212) and, when [signed], a + on money in (core's MoneyFormatter).
 */
export function formatMoney(minor: number, currencyCode: string, locale = "en-CA", signed = false): string {
  const c = currencyOf(currencyCode) ?? { code: currencyCode, minorUnits: 2 };
  const abs = Math.abs(minor) / 10 ** c.minorUnits;
  let text: string;
  try {
    text = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: c.code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: c.minorUnits,
      maximumFractionDigits: c.minorUnits,
    }).format(abs);
  } catch {
    text = `${abs.toFixed(c.minorUnits)} ${c.code}`;
  }
  if (minor < 0) return "−" + text;
  if (signed && minor > 0) return "+" + text;
  return text;
}
