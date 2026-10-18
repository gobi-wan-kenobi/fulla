// SPDX-License-Identifier: GPL-3.0-or-later
// Card and investment statements for tests, invented from top to bottom
// (names, numbers, shops, amounts): they only copy where each layout puts
// its text, so the readers in lib/importers can be tested on real PDFs.
import { type Text, makePdf } from "./pdfFixture";

const size = { width: 612, height: 842 };
const row = (y: number, cells: [number, string][], fontSize = 10): Text[] => cells.map(([x, text]) => ({ x, y, text, size: fontSize }));

/** An American Express-style card statement: previous $1,000.00, new $965.00. */
export function amexStyle(opts: { newBalance?: string } = {}): Uint8Array {
  const p1: Text[] = [
    ...row(790, [[65, "Example Rewards American Express Card"]], 14),
    ...row(774, [[65, "Statement of Account"]], 14),
    ...row(700, [[16, "Prepared For"], [332, "Account Number"], [419, "Opening Date"], [500, "Closing Date"]], 6),
    ...row(689, [[16, "EXAMPLE PERSON"], [278, "XXXX XXXXX0 12345"], [398, "Jan 17, 2030"], [475, "Feb 16, 2030"]]),
    ...row(662, [[46, "Previous Balance"], [232, "$1,000.00"]], 8),
    ...row(652, [[17, "Less"], [46, "Payments"], [238, "$200.00"]], 8),
    ...row(642, [[17, "Less"], [46, "Other Credits"], [246, "$10.00"]], 8),
    ...row(633, [[17, "Plus"], [46, "Interest"], [243, "$15.50"]], 8),
    ...row(623, [[17, "Plus"], [46, "Purchases"], [238, "$134.50"]], 8),
    ...row(614, [[17, "Plus"], [46, "Fees"], [246, "$25.00"]], 8),
    ...row(585, [[17, "Equals New Balance"], [232, opts.newBalance ?? "$965.00"]], 8),
  ];
  const p2: Text[] = [
    ...row(788, [[67, "Example Rewards American Express Card"]], 14),
    ...row(661, [[18, "Transaction"], [58, "Posting"], [97, "Details"], [501, "Amount ($)"]], 6),
    ...row(633, [[18, "New Payments"]]),
    ...row(616, [[18, "Jan 20"], [58, "Jan 20"], [97, "PAYMENT RECEIVED - THANK YOU"], [494, "-200.00"]]),
    ...row(608, [[97, "Reference EXAMPLE"]], 6),
    ...row(590, [[18, "Total of Payment Activity"], [495, "-200.00"]]),
    ...row(560, [[18, "New Transactions for EXAMPLE PERSON"]]),
    ...row(543, [[18, "Jan 22"], [58, "Jan 23"], [101, "EXAMPLE CAFE"], [201, "TORONTO"], [505, "24.50"]]),
    ...row(527, [[18, "Jan 25"], [58, "Jan 26"], [101, "EXAMPLE SOFTWARE"], [230, "SAN FRANCISCO"], [505, "70.00"]]),
    ...row(519, [[101, "UNITED STATES DOLLAR 50.00 @ 1.40000"]], 7),
    ...row(506, [[18, "Feb 2"], [58, "Feb 3"], [101, "EXAMPLE GROCER"], [201, "TORONTO"], [505, "40.00"]]),
    ...row(490, [[18, "Feb 5"], [58, "Feb 5"], [101, "EXAMPLE CAFE"], [201, "TORONTO"], [500, "-10.00"]]),
    ...row(461, [[18, "Total of New Transactions for"], [499, "124.50"]]),
    ...row(418, [[18, "Other Account Transactions"]]),
    ...row(403, [[18, "Feb 16"], [58, "Feb 16"], [101, "ANNUAL FEE"], [505, "25.00"]]),
    ...row(388, [[18, "Feb 16"], [58, "Feb 16"], [101, "INTEREST"], [505, "15.50"]]),
    ...row(370, [[18, "Total of Other Account Transactions"], [505, "40.50"]]),
  ];
  return makePdf([p1, p2], size);
}

/** A Capital One-style card statement: previous $500.00, new $269.99. */
export function capitalOneStyle(): Uint8Array {
  const p1: Text[] = [
    ...row(754, [[445, "Capital One Mastercard® ending in 0042"]], 8),
    ...row(743, [[433, "Statement Period: Jan 21, 2030 - Feb 20, 2030"]], 8),
    ...row(693, [[333, "Previous Balance"], [549, "$500.00"]], 9),
    ...row(670, [[333, "Payments"], [546, "- $300.00"]], 9),
    ...row(652, [[333, "Other Credits"], [555, "- $0.00"]], 9),
    ...row(631, [[333, "Transactions"], [553, "+ $60.00"]], 9),
    ...row(611, [[333, "Fees Charged"], [553, "+ $0.00"]], 9),
    ...row(592, [[333, "Interest Charged"], [550, "+ $9.99"]], 9),
    ...row(569, [[333, "New Balance"], [537, "= $269.99"]], 9),
  ];
  const p2: Text[] = [
    ...row(687, [[41, "EXAMPLE PERSON # 0042: Payments, Credits & Adjustments"]]),
    ...row(670, [[41, "Transaction Date"], [129, "Posting Date"], [200, "Description"], [502, "Amount"]]),
    ...row(657, [[41, "Jan 30"], [129, "Feb 1"], [200, "PAYMENT"], [502, "- $300.00"]], 9),
    ...row(622, [[41, "EXAMPLE PERSON # 0042: Total Payments, Credits & Adjustments"], [502, "- $300.00"]], 9),
    ...row(596, [[41, "EXAMPLE PERSON # 0042: Transactions"]]),
    ...row(578, [[41, "Transaction Date"], [129, "Posting Date"], [200, "Description"], [502, "Amount"]]),
    ...row(561, [[41, "Feb 3"], [129, "Feb 4"], [200, "EXAMPLE HARDWARE TORONTO"], [502, "$60.00"]], 9),
    ...row(531, [[41, "OTHER CHARGES"]]),
    ...row(499, [[41, "Feb 19"], [129, "Feb 19"], [200, "INTEREST CHARGES"], [502, "$9.99"]], 9),
  ];
  return makePdf([p1, p2], size);
}

/** A Wealthsimple-style TFSA statement: market value $5,000.00; cash $10.00 to $63.00 (CAD) and $1.00 to $1.40 (USD). */
export function investmentStyle(opts: { version?: number; withLoan?: boolean } = {}): Uint8Array {
  const p1: Text[] = [
    ...(opts.version ? row(824, [[30, `Amended - Version: ${opts.version}`]], 9) : []),
    ...row(798, [[224, "ORDER EXECUTION ONLY ACCOUNT"]], 9),
    ...row(762, [[246, "Account No."], [366, "Owner"], [468, "Statement Period"]], 8),
    ...row(749, [[237, "ZZ9EXAMPLE1CAD"], [335, "Example Person"], [457, "2030-01-01 - 2030-01-31"]], 8),
    ...row(700, [[324, "Order Execution Only TFSA Account"]], 8),
    ...row(624, [[222, "Total Portfolio"], [346, "$5,000.00"], [414, "100.00"]], 8),
    ...row(557, [[49, "Portfolio Cash"]], 11),
    ...row(541, [[355, "CAD Transactions ($CAD)"], [467, "USD Transactions ($USD)"]], 8),
    ...row(530, [[37, "Last Statement Cash Balance"], [425, "$10.00"], [540, "$1.00"]], 8),
    ...row(519, [[37, "Total Cash Paid In"], [421, "$203.00"], [540, "$0.50"]], 8),
    ...row(507, [[37, "Total Cash Paid Out"], [421, "$150.00"], [540, "$0.10"]], 8),
    ...row(496, [[37, "Closing Cash Balance"], [425, "$63.00"], [540, "$1.40"]], 8),
    ...row(184, [[34, "* The conversion rate used to convert your month-end Portfolio Closing Cash Balance to CAD is: $1 USD = $1.400000 CAD."]], 7),
    ...row(100, [[34, "Example text: Wealthsimple Investments Inc."]], 7),
  ];
  const p2: Text[] = [
    ...row(797, [[49, "CAD Activity - Current period"]], 11),
    ...row(781, [[48, "Date"], [81, "Transaction"], [128, "Description"], [396, "Debit ($CAD)"], [448, "Credit ($CAD)"], [502, "Balance ($CAD)"]], 8),
    ...row(769, [[37, "2030-01-05"], [81, "CONT"], [128, "Contribution (executed at 2030-01-05)"], [423, "$0.00"], [469, "$200.00"], [531, "$210.00"]], 8),
    ...row(758, [[37, "2030-01-06"], [81, "BUY"], [128, "EXAMPLE ETF: Bought 3.0000 shares at $50.00"], [415, "$150.00"], [478, "$0.00"], [535, "$60.00"]], 8),
    ...row(748, [[128, "per share (executed at 2030-01-05)"]], 8),
    ...row(737, [[37, "2030-01-20"], [81, "DIV"], [128, "EXAMPLE ETF: Cash dividend distribution, received"], [423, "$0.00"], [478, "$3.00"], [535, "$63.00"]], 8),
    ...row(727, [[128, "on 2030-01-20, record date of 2030-01-15"]], 8),
    ...(opts.withLoan === false ? [] : row(716, [[37, "2030-01-21"], [81, "LOAN"], [128, "EXAMPLE ETF: 1.0000 Shares on loan"], [423, "$0.00"], [478, "$0.00"], [535, "$63.00"]], 8)),
    ...row(680, [[49, "USD Activity - Current period"]], 11),
    ...row(664, [[48, "Date"], [81, "Transaction"], [128, "Description"], [397, "Debit ($USD)"], [448, "Credit ($USD)"], [502, "Balance ($USD)"]], 8),
    ...row(652, [[37, "2030-01-10"], [81, "DIV"], [128, "EXAMPLECO: Cash dividend distribution"], [424, "$0.00"], [478, "$0.50"], [539, "$1.50"]], 8),
    ...row(641, [[37, "2030-01-10"], [81, "NRT"], [128, "Non-resident tax (executed at 2030-01-10)"], [424, "$0.10"], [478, "$0.00"], [539, "$1.40"]], 8),
  ];
  return makePdf([p1, p2], size);
}

/**
 * A non-registered account's statement in one currency: no CAD and USD
 * columns, the cash summary's amounts beside their labels, and its activity
 * under "Activity - Current period" on two pages. Invented, like the rest.
 */
export function singleCurrencyInvestmentStyle(): Uint8Array {
  const p1: Text[] = [
    ...row(798, [[224, "ORDER EXECUTION ONLY ACCOUNT"]], 9),
    ...row(782, [[224, "All figures in $CAD unless otherwise specified"]], 8),
    ...row(762, [[246, "Account No."], [366, "Owner"], [468, "Statement Period"]], 8),
    ...row(749, [[237, "ZZ9EXAMPLE7CAD"], [335, "Example Person"], [457, "2030-02-01 - 2030-02-28"]], 8),
    ...row(700, [[295, "Order Execution Only Non-Registered Cash Account"]], 8),
    ...row(605, [[222, "Total Portfolio"], [327, "$1,234.56"], [369, "100.00"]], 8),
    ...row(528, [[49, "Portfolio Cash"]], 11),
    ...row(500, [[49, "Last Statement Cash Balance"], [183, "$5.00"], [241, "Cash Paid In"], [302, "Deposits"], [370, "$100.00"]], 8),
    ...row(488, [[49, "Total Cash Paid In"], [175, "$100.53"], [302, "Proceeds from"]], 8),
    ...row(477, [[49, "Total Cash Paid Out"], [175, "$100.43"], [302, "sales"], [378, "$0.00"]], 8),
    ...row(466, [[49, "Closing Cash Balance"], [183, "$5.10"], [302, "Dividends"], [378, "$0.40"]], 8),
    ...row(100, [[34, "Example text: Wealthsimple Investments Inc."]], 7),
  ];
  const head = (y: number) => [
    ...row(y, [[49, "Activity - Current period"]], 11),
    ...row(y - 16, [[48, "Date"], [81, "Transaction"], [128, "Description"], [440, "Debit"], [480, "Credit"], [530, "Balance"]], 8),
  ];
  const p2: Text[] = [
    ...head(797),
    ...row(760, [[37, "2030-02-02"], [81, "DIV"], [129, "EXAMPLECO: Cash dividend distribution"], [456, "$0.00"], [494, "$0.40"], [539, "$5.40"]], 8),
    ...row(740, [[37, "2030-02-03"], [81, "REIMB"], [129, "MANAGEMENT_FEE_REIMBURSEMENT (executed at 2030-02-03)"], [456, "$0.00"], [494, "$0.13"], [539, "$5.53"]], 8),
    ...row(720, [[37, "2030-02-07"], [81, "TRFIN"], [129, "Money transfer into the account (executed at 2030-02-07)"], [456, "$0.00"], [490, "$100.00"], [535, "$105.53"]], 8),
  ];
  const p3: Text[] = [
    ...head(797),
    ...row(760, [[37, "2030-02-08"], [81, "BUY"], [129, "EXAMPLE ETF: Bought 1.0000 shares at $100.00 per share"], [450, "$100.00"], [494, "$0.00"], [539, "$5.53"]], 8),
    ...row(740, [[37, "2030-02-09"], [81, "NRT"], [129, "Non-resident tax (executed at 2030-02-09)"], [456, "$0.05"], [494, "$0.00"], [539, "$5.48"]], 8),
    ...row(720, [[37, "2030-02-28"], [81, "FEE"], [129, "Example Portfolio Service Fee (executed at 2030-02-28)"], [456, "$0.38"], [494, "$0.00"], [539, "$5.10"]], 8),
  ];
  return makePdf([p1, p2, p3], size);
}
