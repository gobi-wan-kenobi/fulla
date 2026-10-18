// SPDX-License-Identifier: GPL-3.0-or-later
// Wealthsimple's activity export of an investment account, as CSV. Every row
// here is invented.
import { describe, expect, it } from "vitest";
import { looksLikeWealthsimpleActivityCsv, readWealthsimpleActivityCsv } from "@/lib/importers";

const HEAD = '"date","transaction","description","amount","balance","currency"';
const csv = (...rows: string[]) => [HEAD, ...rows].join("\n") + "\n";
const RESP = csv(
  '"2030-03-01","BUY","EXA - Example Index ETF: Bought 0.1000 shares at $100.00 per share (executed at 2030-02-28)","-10.0","40.0","CAD"',
  '"2030-03-02","DIV","EXA - Example Index ETF: Cash dividend distribution, received on 2030-03-02, record date of 2030-02-27","1.25","41.25","CAD"',
  '"2030-03-07","DEP","Deposit (executed at 2030-03-07)","100.0","141.25","CAD"',
  '"2030-03-09","BUY","EXB - Example Bond ETF: Bought 1.0000 shares at $50.00 per share (executed at 2030-03-08), FX Rate: 1.3900","-50.0","91.25","CAD"',
  '"2030-03-14","GRANT","Grant payment (executed at 2030-03-14)","20.0","111.25","CAD"',
  '"2030-03-31","NRT","Non-resident tax (executed at 2030-03-31)","-0.19","111.06","CAD"',
  '"2030-03-31","FEE","Management fees (executed at 2030-03-31)","-1.06","110.0","CAD"',
);

describe("a Wealthsimple activity export", () => {
  it("is told apart from other CSVs", () => {
    expect(looksLikeWealthsimpleActivityCsv(RESP)).toBe(true);
    expect(looksLikeWealthsimpleActivityCsv("\uFEFF" + RESP)).toBe(true);
    // The same columns from an everyday account: no trades, dividends or grants.
    expect(looksLikeWealthsimpleActivityCsv(csv('"2030-03-01","SPEND","EXAMPLE COFFEE","-4.5","95.5","CAD"'))).toBe(false);
    expect(looksLikeWealthsimpleActivityCsv("Date,Description,Amount\n2030-03-01,EXAMPLE COFFEE,-4.50\n")).toBe(false);
    expect(readWealthsimpleActivityCsv("Date,Description,Amount\n")).toBeNull();
  });

  it("reads deposits, dividends, grants, fees and taxes, leaves trades out, and checks every balance", () => {
    const r = readWealthsimpleActivityCsv(RESP)!;
    expect(r.kind).toBe("investment");
    expect(r.period).toBe("2030-03-01 to 2030-03-31");
    expect(r.ignored).toBe(2);
    expect(r.balance).toMatchObject({ ok: true, openingMinor: 5000, closingMinor: 11000, mismatches: [] });
    // It names no account and no market value: the account is picked, and no balance is saved for net worth.
    expect(r.statement).toEqual({
      institution: "Wealthsimple", type: "investment", last4: null, closingBalanceMinor: null, closingDate: "2030-03-31",
      label: "Wealthsimple RESP", periodStart: "2030-03-01", version: 1,
    });
    expect(r.lines.map((l) => [l.date, l.amountMinor, l.role, l.description])).toEqual([
      ["2030-03-02", 125, "dividend", "EXA - Example Index ETF: Cash dividend distribution"],
      ["2030-03-07", 10000, "transfer", "Deposit"],
      ["2030-03-14", 2000, "dividend", "Grant payment"],
      ["2030-03-31", -19, "fee", "Non-resident tax"],
      ["2030-03-31", -106, "fee", "Management fees"],
    ]);
  });

  it("marks a row whose balance does not follow, and calls an account without grants an investment account", () => {
    const r = readWealthsimpleActivityCsv(csv(
      '"2030-03-01","DEP","Deposit","100.0","100.0","CAD"',
      '"2030-03-02","DIV","EXA: Cash dividend distribution","1.0","102.0","CAD"',
      '"2030-03-03","WD","Withdrawal","-50.0","52.0","CAD"',
    ))!;
    expect(r.balance.ok).toBe(false);
    expect(r.balance.mismatches).toEqual([{ index: 1, expectedMinor: 10100, statedMinor: 10200 }]);
    expect(r.statement.label).toBe("Wealthsimple investment");
    expect(r.lines.map((l) => [l.amountMinor, l.role])).toEqual([[10000, "transfer"], [100, "dividend"], [-5000, "transfer"]]);
  });
});
