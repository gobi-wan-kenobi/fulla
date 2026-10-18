// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The server's half of labelled examples (lib/examples.ts): a change from the
 * browser becomes what is kept, scrubbed here so no name, number or bank ever
 * reaches the table, and the exact amount and date are reduced to a band and
 * a day of the month.
 */
import { amountBand } from "../categorize/facts";
import { scrub } from "./sanitize";

const SOURCES = new Set(["rule", "merchant", "debt", "file", "jev", "model", "user", "none"]);
const VIAS = new Set(["edit", "bulk", "review", "import"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredExample {
  description: string;
  direction: "in" | "out";
  amount_band: string;
  day_of_month: number | null;
  from_category_id: string | null;
  from_source: string;
  from_confidence: number | null;
  to_category_id: string;
  via: string;
}

/** A description as kept: scrubbed, and with any run of four digits or more gone (the database refuses them). */
export function scrubbedDescription(text: string): string | null {
  const s = scrub(text).text.replace(/\d{4,}/g, " ").replace(/@/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return s || null;
}

/** The browser's examples, checked and reduced to what is kept; null when the body is not examples at all. */
export function readExamples(body: unknown): { householdId: string; examples: StoredExample[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { household_id?: unknown; examples?: unknown };
  if (typeof b.household_id !== "string" || !UUID.test(b.household_id) || !Array.isArray(b.examples) || b.examples.length > 200) return null;
  const out: StoredExample[] = [];
  for (const raw of b.examples) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const description = typeof e.description === "string" ? scrubbedDescription(e.description) : null;
    const amount = typeof e.amount_minor === "number" && Number.isFinite(e.amount_minor) ? e.amount_minor : null;
    const units = typeof e.minor_units === "number" && e.minor_units >= 0 && e.minor_units <= 4 ? e.minor_units : 2;
    const day = typeof e.date === "string" ? Number(/^\d{4}-\d{2}-(\d{2})$/.exec(e.date)?.[1]) : NaN;
    const from = typeof e.from_category_id === "string" && UUID.test(e.from_category_id) ? e.from_category_id : null;
    const to = typeof e.to_category_id === "string" && UUID.test(e.to_category_id) ? e.to_category_id : null;
    const source = typeof e.from_source === "string" && SOURCES.has(e.from_source) ? e.from_source : "none";
    const via = typeof e.via === "string" && VIAS.has(e.via) ? e.via : null;
    const conf = typeof e.from_confidence === "number" && e.from_confidence >= 0 && e.from_confidence <= 1 ? e.from_confidence : null;
    if (!description || amount === null || !to || !via || (e.direction !== "in" && e.direction !== "out")) continue;
    out.push({
      description, direction: e.direction, amount_band: amountBand(amount, units), day_of_month: day >= 1 && day <= 31 ? day : null,
      from_category_id: from, from_source: source, from_confidence: conf, to_category_id: to, via,
    });
  }
  return { householdId: b.household_id, examples: out };
}
