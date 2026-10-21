// SPDX-License-Identifier: GPL-3.0-or-later
// Which PDF statement this is, and its reader: Wealthsimple chequing,
// American Express or Capital One cards, Wealthsimple investment accounts.
import type { Currency } from "../money";
import { bankCardLayout, readBankCardStatement } from "./bankCardPdf";
import { readCardStatement, cardIssuer } from "./cardPdf";
import { looksLikeWealthsimpleInvestment, readWealthsimpleInvestment } from "./investmentPdf";
import { type PdfPage, type PdfStatementResult, PdfStatementError, looksLikeWealthsimpleChequing, pdfLines, readWealthsimpleChequing } from "./wealthsimplePdf";

export function readPdfStatement(pages: PdfPage[], currency: Currency): PdfStatementResult {
  const lines = pdfLines(pages);
  if (lines.every((l) => l.cells.every((c) => !c.text.trim()))) throw new PdfStatementError("no-text");
  if (cardIssuer(lines)) return readCardStatement(pages);
  if (bankCardLayout(lines)) return readBankCardStatement(pages);
  if (looksLikeWealthsimpleInvestment(lines)) return readWealthsimpleInvestment(pages);
  const problem = looksLikeWealthsimpleChequing(lines);
  if (!problem) return readWealthsimpleChequing(pages, currency);
  throw new PdfStatementError(problem === "no-text" ? "no-text" : "not-supported");
}
