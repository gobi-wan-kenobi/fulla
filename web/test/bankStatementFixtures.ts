// SPDX-License-Identifier: GPL-3.0-or-later
// Card and line of credit statements for tests, invented from top to bottom
// (names, numbers, shops, amounts): they only copy where each bank's layout
// puts its text, so bankCardPdf.ts can be tested on real PDFs.
import { type Text, makePdf } from "./pdfFixture";

const size = { width: 612, height: 842 };
const row = (y: number, cells: [number, string][], fontSize = 8): Text[] => cells.map(([x, text]) => ({ x, y, text, size: fontSize }));

/** An RBC-style card: previous $1,000.00, new $1,166.00, a panel on the right, one posting date run into its description. */
export function rbcStyle(): Uint8Array {
  return makePdf([[
    ...row(700, [[60, "Example RBC World Mastercard"]]),
    ...row(687, [[60, "EXAMPLE PERSON 5100 12** **** 0042"]]),
    ...row(675, [[60, "STATEMENT FROM JAN 13, 2030 TO FEB 12, 2030"]]),
    ...row(638, [[57, "PREVIOUS ACCOUNT BALANCE"], [301, "$1,000.00"], [391, "IMPORTANT INFORMATION"]]),
    ...row(590, [[59, "TRANSACTION"], [178, "ACTIVITY DESCRIPTION"], [318, "AMOUNT ($)"]]),
    ...row(575, [[59, "JAN 14"], [95, "JAN 15"], [128, "EXAMPLE CAFE TORONTO ON"], [322, "$41.00"]]),
    ...row(567, [[128, "55500000000000000000001"]]),
    ...row(557, [[59, "JAN 20"], [95, "JAN 22"], [128, "EXAMPLE HOTEL SAN FRANCISCOCA"], [312, "$1,405.00"], [391, "Minimum payment"], [561, "$50.00"]]),
    ...row(549, [[128, "55500000000000000000002"]]),
    ...row(541, [[128, "Foreign Currency - USD"], [186, "1,000.00 Exchange rate - 1.405000"]], 6),
    ...row(530, [[59, "JAN 25"], [95, "JAN 25 PAYMENT - THANK YOU / PAIEMENT - MERCI"], [307, "-$1,300.00"]]),
    ...row(512, [[59, "JAN 28"], [95, "JAN 29"], [128, "EXAMPLE SHOP TORONTO ON"], [316, "-$20.00"]]),
    ...row(494, [[59, "FEB 12"], [95, "FEB 12"], [128, "PURCHASE INTEREST 20.99%"], [318, "$40.00"], [391, "Credit limit"], [550, "$9,000.00"]]),
    ...row(485, [[130, "TOTAL ACCOUNT BALANCE"], [300, "$1,166.00"]]),
    ...row(336, [[391, "NEW BALANCE"], [536, "$1,166.00"]]),
    ...row(178, [[95, "RBC ROYAL BANK"], [235, "$1,166.00"]]),
  ]], size);
}

/** A TD-style card: previous $500.00, new $339.00, a payment from another bank, an annual fee. */
export function tdStyle(): Uint8Array {
  return makePdf([[
    ...row(693, [[47, "TD Example Visa Infinite*"]]),
    ...row(671, [[47, "EXAMPLE PERSON"], [209, "4500 12XX XXXX 0077"]]),
    ...row(657, [[47, "STATEMENT DATE: April 22, 2030"]]),
    ...row(631, [[47, "STATEMENT PERIOD: March 24, 2030 to April 22, 2030"], [361, "Example Rewards Program"]]),
    ...row(603, [[49, "DATE"], [97, "DATE"], [140, "ACTIVITY DESCRIPTION"], [309, "AMOUNT($)"]]),
    ...row(591, [[140, "PREVIOUS STATEMENT BALANCE"], [306, "$500.00"], [361, "Points Earned"], [553, "227.00"]]),
    ...row(572, [[47, "MAR 30"], [95, "MAR 31"], [140, "EXAMPLE GROCER TORONTO"], [322, "$85.00"]]),
    ...row(553, [[47, "APR 2"], [95, "APR 3"], [140, "EXAMPLE BANK OF CANADA MONTREAL"], [310, "-$400.00"], [361, "Minimum Payment"], [550, "$10.00"]]),
    ...row(534, [[47, "APR 11"], [95, "APR 13"], [140, "EXAMPLE TICKETS"], [322, "$15.00"]]),
    ...row(525, [[140, "416-555-0100"]]),
    ...row(505, [[47, "APR 22"], [95, "APR 22"], [140, "ANNUAL FEE"], [322, "$139.00"]]),
    ...row(486, [[47, "APR 22"], [95, "APR 22"], [140, "RETAIL INTEREST"], [322, "$0.00"]]),
    ...row(466, [[140, "TOTAL NEW BALANCE"], [305, "$339.00"], [361, "Annual Interest Rate"], [549, "20.99%"]]),
    ...row(192, [[81, "TD CANADA TRUST"]]),
    ...row(180, [[410, "Pay online with EasyWeb"]]),
  ]], size);
}

/** A Tangerine-style card: a description over two lines around its row, rewards in their own column. */
export function tangerineCardStyle(): Uint8Array {
  return makePdf([[
    ...row(945, [[36, "Tangerine Money-Back World Mastercard"]], 10),
    ...row(714, [[387, "Account number"], [500, "5300 xxxx xxxx 0055"]]),
    ...row(702, [[387, "Statement period"], [492, "Dec 21 to Jan 20, 2030"]]),
    ...row(665, [[387, "Previous balance"], [539, "$700.00"]]),
    ...row(575, [[387, "New balance"], [539, "$730.00"]]),
  ], [
    ...row(942, [[42, "Previous Balance"], [295, "$700.00"]]),
    ...row(920, [[42, "Transaction"], [91, "Posted"], [140, "Description"], [259, "Category"], [300, "Amount"], [334, "Reward"]]),
    ...row(901, [[42, "20-Jan-2030"], [91, "20-Jan-2030"], [140, "PURCHASE INTEREST"], [269, "–"], [300, "$10.00"], [342, "–"]]),
    ...row(888, [[140, "EXAMPLE CHARITY"]]),
    ...row(884, [[42, "19-Jan-2030"], [91, "20-Jan-2030"], [300, "$30.00"], [336, "$0.60"]]),
    ...row(880, [[140, "TORONTO ON"]]),
    ...row(861, [[42, "05-Jan-2030"], [91, "06-Jan-2030"], [140, "EXAMPLE EMAIL GENEVA"], [300, "$90.00"], [336, "$0.37"]]),
    ...row(853, [[140, "64.00 USD @ 1.406250"]]),
    ...row(840, [[42, "02-Jan-2030"], [91, "02-Jan-2030"], [140, "PAYMENT - THANK YOU"], [269, "–"], [293, "-$100.00"], [342, "–"]]),
    ...row(751, [[41, "New Balance – Example Person"], [295, "$730.00"], [336, "$0.97"]]),
  ]], { width: 612, height: 1000 });
}

/** A Triangle-style card: payments and purchases in sections, a province on the next line, and the store's own item list after. */
export function triangleStyle(): Uint8Array {
  return makePdf([[
    ...row(789, [[2, "Your account number starting with 5400 and ending with 0099"]]),
    ...row(703, [[63, "For the period: April 4, 2030 to May 3, 2030"]]),
    ...row(650, [[72, "Balance from your last statement"], [320, "$1,000.00"]]),
    ...row(530, [[75, "Your New Balance"], [308, "$835.00"]]),
    ...row(300, [[397, "Canadian Tire Bank issues the Triangle Example Mastercard."]]),
  ], [
    ...row(693, [[34, "Payments received - Apr 4 to May 3, 2030"]]),
    ...row(668, [[47, "DATE"], [90, "DATE"], [127, "TRANSACTION DESCRIPTION"], [341, "AMOUNT ($)"]]),
    ...row(657, [[47, "Apr 29"], [90, "Apr 30"], [127, "EXAMPLE TELEPAYMENTS"], [334, "-300.00"]]),
    ...row(643, [[39, "Total payments received"], [319, "-$300.00"]]),
    ...row(576, [[34, "Purchases - Card #5400 12XX XXXX 0099"]]),
    ...row(565, [[47, "Apr 12"], [90, "Apr 13"], [128, "EXAMPLE PHONE CO EDMONTON"], [344, "60.00"]]),
    ...row(555, [[128, "AB"]]),
    ...row(545, [[47, "Apr 19"], [90, "Apr 20"], [128, "EXAMPLE SPORTS AJAX ON"], [348, "40.00"]]),
    ...row(520, [[40, "Total purchases"], [333, "$100.00"]]),
    ...row(441, [[47, "May 03"], [90, "May 03"], [127, "INTEREST CHARGES"], [345, "35.00"]]),
    ...row(428, [[39, "Total interest charges"], [333, "$35.00"]]),
    ...row(380, [[89, "Details of your Example Sports store purchases"]]),
    ...row(350, [[66, "Apr 19"], [111, "Apr 20"], [166, "1"], [177, "EXAMPLE SHOES"], [371, "40.00"]]),
  ]], size);
}

/** A Tangerine-style line of credit: amounts without signs, opening and closing rows, payments from another account. */
export function tangerineLocStyle(): Uint8Array {
  return makePdf([[
    ...row(865, [[49, "Your New Balance"], [194, "$1,215.00"]]),
    ...row(802, [[387, "Account Number"], [535, "1234560042"]]),
    ...row(792, [[387, "Statement Period"], [481, "Aug 1, 2030 to Aug 31, 2030"]]),
    ...row(738, [[42, "Transaction/Posted Date"], [123, "Description"], [322, "Amount"], [387, "Previous Balance"], [540, "$1,000.00"]]),
    ...row(723, [[42, "01-Aug-2030"], [123, "Opening Balance"], [314, "$1,000.00"]]),
    ...row(709, [[42, "14-Aug-2030"], [123, "Payment from Example Chequing Account -"], [320, "$100.00"]]),
    ...row(701, [[123, "- 9990000001"]]),
    ...row(691, [[42, "20-Aug-2030"], [123, "Interest Rate Change to 9.95%"], [327, "$0.00"], [387, "Fees"], [556, "$0.00"]]),
    ...row(672, [[42, "23-Aug-2030"], [123, "Loan Advance to Example Chequing Account -"], [320, "$300.00"], [387, "New Balance*"], [540, "$1,215.00"]]),
    ...row(653, [[42, "31-Aug-2030"], [123, "Interest (01 Aug 2030 - 31 Aug 2030)"], [324, "$15.00"]]),
    ...row(639, [[42, "31-Aug-2030"], [123, "Closing Balance"], [314, "$1,215.00"]]),
    ...row(146, [[45, "Online at tangerine.ca"], [206, "Tangerine Line of Credit"]]),
  ]], { width: 612, height: 1000 });
}
