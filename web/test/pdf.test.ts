// SPDX-License-Identifier: GPL-3.0-or-later
// Wealthsimple chequing PDF statements. Every statement here is invented
// (test/pdfFixture.ts builds it as a real PDF) and read with PDF.js's Node
// build, as the browser reads the real thing.
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  type PdfJs, type PdfPage, PdfStatementError, extractPdfPages, isPdf, parseStatementMoney, pdfLines, propose, readWealthsimpleChequing, utf8,
  detectFormat,
} from "@/lib/importers";
import { requireCurrency } from "@/lib/money";
import { ALICE, HOUSEHOLD, LEISURE, MAIN, SALARY, config } from "./support";
import { type Row, SAMPLE_ROWS, makePdf, samplePages } from "./pdfFixture";

const cad = requireCurrency("CAD");
const lib = pdfjs as unknown as PdfJs;
const read = async (bytes: Uint8Array) => readWealthsimpleChequing(await extractPdfPages(bytes, lib), cad);

describe("Wealthsimple chequing PDF", () => {
  it("is told apart from CSV, OFX and QIF by its first bytes", () => {
    const pdf = makePdf(samplePages());
    expect(isPdf(pdf)).toBe(true);
    expect(isPdf(utf8("date,description,amount\n2030-01-01,x,1.00\n"))).toBe(false);
    expect(isPdf(utf8("\n\n%PDF-1.4 after a little junk"))).toBe(true);
    expect(detectFormat(utf8("OFXHEADER:100\n<OFX>"))).toBe("ofx");
  });

  it("reads every line across pages, with wrapped descriptions, signs and the date it happened", async () => {
    const r = await read(makePdf(samplePages()));
    expect(r.lines).toHaveLength(8);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([-5000, 125, -4210, -25000, -8463, 234567, -650, -120517]);
    expect(r.lines[0]).toEqual({ date: "2030-01-02", amountMinor: -5000, description: "Interac e-Transfer® Out to Example Friend" });
    expect(r.lines[2].date).toBe("2029-12-31");
    expect(r.posted[2]).toBe("2030-01-02");
    expect(r.lines[3].description).toBe("Online bill payment for NORTHWIND CARDS, account ••••0000 (executed at 2030-01-03)");
    expect(r.lines[6].description).toBe("Blue Door Café");
    // Nothing from the header, the footer or the disclosure became a line or part of one.
    for (const l of r.lines) expect(l.description).not.toMatch(/Page \d|DESCRIPTION|Date is when|disclosure|Sampletown/);
    expect(r.period).toBe("Jan 1 - Jan 31, 2030");
    expect(r.currency).toBe("CAD");
  });

  it("checks every running balance against the opening and closing balances", async () => {
    const r = await read(makePdf(samplePages()));
    expect(r.balance).toMatchObject({ openingMinor: 100000, closingMinor: 170852, mismatches: [], closingMatches: true, ok: true });
    expect(r.balance.balancesMinor.at(-1)).toBe(170852);
  });

  it("marks a line whose balance does not add up, and a wrong closing balance", async () => {
    const rows: Row[] = SAMPLE_ROWS.map((x, i) => (i === 4 ? { ...x, amount: "–$84.36" } : x));
    const r = await read(makePdf(samplePages(rows)));
    expect(r.balance.ok).toBe(false);
    expect(r.balance.mismatches).toEqual([{ index: 4, expectedMinor: 57479, statedMinor: 57452 }]);
    expect(r.balance.closingMatches).toBe(true);

    const missing = SAMPLE_ROWS.filter((_, i) => i !== 1); // a line the reader lost
    const m = await read(makePdf(samplePages(missing)));
    expect(m.balance.mismatches.map((x) => x.index)).toEqual([1]);

    const c = await read(makePdf(samplePages(SAMPLE_ROWS, "$1,708.53")));
    expect(c.balance).toMatchObject({ mismatches: [], closingMatches: false, ok: false });
  });

  it("reads a balance below zero (an overdraft) and checks it like any other", async () => {
    const rows: Row[] = [
      ...SAMPLE_ROWS,
      { date: "2030-01-28", description: "Transfer out", amount: "–$1,710.00", balance: "–$1.48" },
      { date: "2030-01-29", description: "Example 💰 Interest Fee", amount: "–$0.02", balance: "–$1.50" },
    ];
    const pages = samplePages(rows, "–$1.50");
    const r = await read(makePdf(pages.map((p) => p.map((t) => ({ ...t, text: t.text.replace("💰 ", "") })))));
    expect(r.lines.slice(-2).map((l) => l.amountMinor)).toEqual([-171000, -2]);
    expect(r.balance.balancesMinor.slice(-2)).toEqual([-148, -150]);
    expect(r.balance).toMatchObject({ closingMinor: -150, mismatches: [], ok: true });
  });

  it("says why a PDF is not one it reads", async () => {
    const problem = async (bytes: Uint8Array) => {
      try {
        await read(bytes);
        return null;
      } catch (e) {
        return e instanceof PdfStatementError ? e.problem : "threw";
      }
    };
    expect(await problem(makePdf([[]]))).toBe("no-text");
    expect(await problem(makePdf([[{ x: 30, y: 500, text: "Example Bank statement" }, { x: 30, y: 480, text: "2030-01-01 Coffee $3.00" }]]))).toBe("not-wealthsimple");
    expect(await problem(makePdf([[{ x: 30, y: 500, text: "Wealthsimple" }, { x: 30, y: 480, text: "TFSA quarterly statement" }]]))).toBe("not-chequing");
    expect(await problem(makePdf([samplePages()[0].filter((t) => !/^\d{4}-/.test(t.text) && !t.text.includes("$") && !/^Interac|^Online|^CARDS|^2030-01-03\)|^Interest|^Maple|^Pre-auth/.test(t.text))]))).toBe("no-rows");
    expect(await problem(utf8("%PDF-1.7\nthis is not really a pdf"))).toBe("unreadable");
  });

  it("reads statement money without floats", () => {
    expect(parseStatementMoney("–$1,234.56", cad)).toBe(-123456);
    expect(parseStatementMoney("-$0.07", cad)).toBe(-7);
    expect(parseStatementMoney("−$10.00", cad)).toBe(-1000);
    expect(parseStatementMoney("$12,345,678.90", cad)).toBe(1234567890);
    expect(parseStatementMoney("$1,23.45", cad)).toBeNull();
    expect(parseStatementMoney("1.00", cad)).toBeNull();
    expect(parseStatementMoney("$1.5", cad)).toBeNull();
  });

  it("joins runs of one word and keeps columns apart", () => {
    const page: PdfPage = {
      cells: [
        { text: "2030-01-02", x: 24, y: 100, width: 38, height: 7.5 },
        { text: "account", x: 146, y: 100.4, width: 25, height: 7.5 },
        { text: " ", x: 171, y: 100, width: 2, height: 0 },
        { text: "••••0000", x: 173, y: 100, width: 30, height: 7.5 },
        { text: "Coff", x: 146, y: 80, width: 15, height: 7.5 },
        { text: "ee", x: 161, y: 80, width: 8, height: 7.5 },
        { text: "–$1.00", x: 340, y: 100, width: 25, height: 7.5 },
      ],
    };
    const lines = pdfLines([page]);
    expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual([["2030-01-02", "account ••••0000", "–$1.00"], ["Coffee"]]);
  });

  it("goes through the same plan as every import: the same file twice adds nothing", async () => {
    const r = await read(makePdf(samplePages()));
    const plan = (existing: Set<string>) => propose({
      householdId: HOUSEHOLD, accountId: MAIN, lines: r.lines, rules: [], uncategorizedExpenseId: LEISURE, uncategorizedIncomeId: SALARY,
      payerMemberId: ALICE, defaultSplit: null, existingIds: existing, now: "2030-02-01T00:00:00.000Z",
      names: { categories: config.categories, members: config.members, accounts: config.accounts }, knownMerchants: true,
    });
    const first = plan(new Set());
    expect(first.filter((p) => !p.alreadyImported)).toHaveLength(8);
    const again = plan(new Set(first.map((p) => p.transaction.id)));
    expect(again.filter((p) => !p.alreadyImported)).toHaveLength(0);
    expect(first.map((p) => p.transaction.kind)).toEqual(["expense", "income", "expense", "expense", "expense", "income", "expense", "expense"]);
  });
});
