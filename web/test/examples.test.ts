// SPDX-License-Identifier: GPL-3.0-or-later
// Labelled category examples. Invented lines only.
import { describe, expect, it } from "vitest";
import { examplesFor, sortedBy, sourceOf } from "@/lib/examples";
import type { Transaction } from "@/lib/model";
import { readExamples, scrubbedDescription } from "@/lib/server/examples";

const A = "00000000-0000-4000-8000-000000000c01";
const B = "00000000-0000-4000-8000-000000000c02";
const H = "00000000-0000-4000-8000-000000000c99";
const tx = (extra: Partial<Transaction> = {}): Transaction => ({
  id: "00000000-0000-4000-8000-000000000c10", kind: "expense", date: "2030-03-15", amount_minor: 4211, category_id: A, account_id: null,
  to_account_id: null, paid_by_member_id: null, to_member_id: null, split: null, recurrence: "variable", note: "Pre-authorized Debit to EXAMPLEINS-LIFE",
  tags: [], extras: {}, status: "active", recurring_rule_id: null, occurrence_date: null, import_fingerprint: null, original_currency: null,
  created_at: "", client_updated_at: "", ...extra,
});

describe("labelled examples", () => {
  it("remember how a row was sorted, in its tags", () => {
    const t = sortedBy(tx({ tags: ["fulla:review"] }), "jev", 0.4249);
    expect(t.tags).toEqual(["fulla:review", "fulla:by:jev", "fulla:conf:42"]);
    expect(sourceOf(t)).toEqual({ source: "jev", confidence: 0.42 });
    expect(sourceOf(sortedBy(t, "user")).source).toBe("user");
    expect(sourceOf(tx())).toEqual({ source: "none", confidence: null });
  });

  it("are made only for a move to another category, with what it was and how", () => {
    const before = sortedBy(tx(), "merchant");
    const [e] = examplesFor([{ before, after: { ...before, category_id: B } }], "edit");
    expect(e).toMatchObject({ from_category_id: A, to_category_id: B, from_source: "merchant", direction: "out", via: "edit", amount_minor: 4211 });
    expect(examplesFor([{ before, after: { ...before, note: "changed" } }], "edit")).toEqual([]);
    expect(examplesFor([{ before, after: { ...before, kind: "transfer", category_id: null } }], "bulk")).toEqual([]);
    expect(examplesFor([{ before: { ...before, note: "" }, after: { ...before, note: "", category_id: B } }], "bulk")).toEqual([]);
    expect(examplesFor([{ before: tx({ kind: "income" }), after: tx({ kind: "income", category_id: B }) }], "review")[0].direction).toBe("in");
  });

  it("keep nothing of a person, a number or a bank, and only a band and a day of the amount and date", () => {
    expect(scrubbedDescription("Interac e-Transfer® Out to Example Person")).not.toMatch(/Example Person/);
    expect(scrubbedDescription("POS 4500123412341234 EXAMPLE SHOP ref 99887766")).not.toMatch(/\d{4}/);
    expect(scrubbedDescription("paid someone@example.com")).not.toMatch(/@/);
    const r = readExamples({
      household_id: H,
      examples: [
        { description: "Pre-authorized Debit to EXAMPLEINS-LIFE", direction: "out", amount_minor: 4211, minor_units: 2, date: "2030-03-15",
          from_category_id: A, from_source: "jev", from_confidence: 0.42, to_category_id: B, via: "review" },
        { description: "x", direction: "sideways", amount_minor: 1, date: "2030-03-15", to_category_id: B, via: "edit" },
        { description: "y", direction: "out", amount_minor: 1, date: "2030-03-15", to_category_id: "not-a-uuid", via: "edit" },
      ],
    })!;
    expect(r.householdId).toBe(H);
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toEqual({
      description: expect.any(String), direction: "out", amount_band: "$30 to $100", day_of_month: 15,
      from_category_id: A, from_source: "jev", from_confidence: 0.42, to_category_id: B, via: "review",
    });
    expect(JSON.stringify(r.examples[0])).not.toMatch(/4211|2030/);
    expect(readExamples({ household_id: "nope", examples: [] })).toBeNull();
    expect(readExamples({ household_id: H, examples: new Array(201).fill({}) })).toBeNull();
  });
});
