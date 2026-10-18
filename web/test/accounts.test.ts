// SPDX-License-Identifier: GPL-3.0-or-later
// Account types, investment ones included (0029). Every name here is invented.
import { describe, expect, it } from "vitest";
import { suggest } from "@/lib/categorize";
import { ACCOUNT_TYPE_ICONS, ACCOUNT_TYPES, accountTypeLabel } from "@/lib/model";
import { proposedStatementAccount } from "@/lib/statementAccount";
import { HOUSEHOLD, LEISURE, category, config } from "./support";

describe("account types", () => {
  it("are the database's list, investment included, each with a label and an icon", () => {
    expect(ACCOUNT_TYPES).toEqual(["cash", "checking", "savings", "credit_card", "investment", "other"]);
    for (const t of ACCOUNT_TYPES) {
      expect(accountTypeLabel(t)).not.toContain("_");
      expect(ACCOUNT_TYPE_ICONS[t]).toBeTruthy();
    }
    expect(accountTypeLabel("investment")).toBe("investment");
    expect(accountTypeLabel("credit_card")).toBe("credit card");
    expect(accountTypeLabel("some_new_kind")).toBe("some new kind"); // a type from a newer server still reads
  });

  it("an investment statement proposes an investment account, named for the plan and its last four", () => {
    const a = proposedStatementAccount(HOUSEHOLD, config.accounts, {
      institution: "Example Broker", type: "investment", last4: "XY7Z", closingBalanceMinor: 100000, closingDate: "2030-01-31", label: "Example Broker TFSA",
    });
    expect(a).toMatchObject({ type: "investment", last4: "XY7Z", name: "Example Broker TFSA ••XY7Z" });
    const plain = proposedStatementAccount(HOUSEHOLD, config.accounts, { institution: "Example Broker", type: "investment", last4: "AB12", closingBalanceMinor: 1, closingDate: "2030-01-31" });
    expect(plain.name).toBe("Example Broker investment ••AB12");
  });
});

describe("re-sorting a PayPal Pay in 4 charge", () => {
  const DEBT = "00000000-0000-4000-8000-000000000401";
  const BNPL = "00000000-0000-4000-8000-000000000402";
  const categories = [
    ...config.categories,
    category(DEBT, "Debt payments", "expense", { fixed: true }),
    category(BNPL, "Buy now pay later", "expense", { parent_id: DEBT, fixed: true }),
  ];

  it("suggests Debt payments > Buy now pay later, as fixed", () => {
    expect(suggest("PAYPAL *PYPL PAYIN4 5550000000", "expense", [], categories)).toMatchObject({ category: { id: BNPL }, source: "debt", fixed: true });
  });

  it("but a household rule still wins", () => {
    const rules = [{ id: "r1", pattern: "payin4", action: { category_id: LEISURE }, sort: 0, active: true }];
    expect(suggest("PAYPAL *PYPL PAYIN4 5550000000", "expense", rules, categories)?.source).toBe("rule");
  });
});
