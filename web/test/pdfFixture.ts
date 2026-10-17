// SPDX-License-Identifier: GPL-3.0-or-later
// Builds small PDFs for tests, by hand: text at given positions in Helvetica,
// nothing else. The statement below is invented from top to bottom (names,
// places, amounts, account numbers): it only copies the layout of a
// Wealthsimple chequing statement, column by column.

export interface Text { x: number; y: number; text: string; size?: number }

// Helvetica's WinAnsi encoding for the few characters beyond ASCII the statement uses.
const WIN_ANSI: Record<string, number> = { "–": 0x96, "®": 0xae, "•": 0x95, "’": 0x92, "é": 0xe9 };

function pdfString(s: string): string {
  let out = "(";
  for (const ch of s) {
    const code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`no WinAnsi code for ${ch}`);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (code < 0x20 || code > 0x7e) out += "\\" + code.toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + ")";
}

/** A PDF with one page per list of texts (459 × 594 points, as the statement). */
export function makePdf(pages: Text[][], opts: { width?: number; height?: number } = {}): Uint8Array {
  const w = opts.width ?? 459;
  const h = opts.height ?? 594;
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) ; // object n is objects[n-1]
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages, filled below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const texts of pages) {
    const stream = texts
      .map((t) => `BT /F1 ${t.size ?? 7.5} Tf ${t.x} ${t.y} Td ${pdfString(t.text)} Tj ET`)
      .join("\n");
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contents = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

export interface Row { date: string; posted?: string; description: string | string[]; amount: string; balance: string }

const COLS = { date: 24.4, posted: 85.1, desc: 145.9, amountRight: 371.6, balanceRight: 434.7 };
// Helvetica is about half its size wide per character; right-aligned columns only need to be roughly right.
const rightAt = (right: number, s: string, size = 7.5) => right - s.length * size * 0.5;

function header(y: number): Text[] {
  return [
    { x: 24.8, y, text: "DATE", size: 6 }, { x: 85.5, y, text: "POSTED DATE", size: 6 }, { x: 146.3, y, text: "DESCRIPTION", size: 6 },
    { x: 325.2, y, text: "AMOUNT (CAD)", size: 6 }, { x: 388, y, text: "BALANCE (CAD)", size: 6 },
  ];
}

function rows(list: Row[], top: number): Text[] {
  const out: Text[] = [];
  let y = top;
  for (const r of list) {
    const desc = Array.isArray(r.description) ? r.description : [r.description];
    out.push(
      { x: COLS.date, y, text: r.date }, { x: COLS.posted, y, text: r.posted ?? r.date }, { x: COLS.desc, y, text: desc[0] },
      { x: rightAt(COLS.amountRight, r.amount), y, text: r.amount }, { x: rightAt(COLS.balanceRight, r.balance), y, text: r.balance },
    );
    desc.slice(1).forEach((d, i) => out.push({ x: COLS.desc, y: y - 10.5 * (i + 1), text: d }));
    y -= 25.5 + 10.5 * (desc.length - 1);
  }
  return out;
}

const footer = (n: number, of: number): Text[] => [
  { x: 24, y: 19.4, text: `Page ${n} of ${of}` },
  { x: 257.6, y: 19.1, text: "Wealthsimple Payments Inc., 1 Example Way, Sampletown" },
];

/** An invented two-page statement: opening $1,000.00, eight lines, closing $1,708.52 when nothing is changed. */
export const SAMPLE_ROWS: Row[] = [
  { date: "2030-01-02", description: "Interac e-Transfer® Out to Example Friend", amount: "–$50.00", balance: "$950.00" },
  { date: "2030-01-02", description: "Interest earned", amount: "$1.25", balance: "$951.25" },
  { date: "2029-12-31", posted: "2030-01-02", description: "Maple Leaf Groceries", amount: "–$42.10", balance: "$909.15" },
  {
    date: "2030-01-03", posted: "2030-01-04",
    description: ["Online bill payment for NORTHWIND", "CARDS, account ••••0000 (executed at", "2030-01-03)"],
    amount: "–$250.00", balance: "$659.15",
  },
  { date: "2030-01-05", description: "Pre-authorized Debit to SAMPLE HYDRO", amount: "–$84.63", balance: "$574.52" },
  // Page two.
  { date: "2030-01-15", description: "Direct deposit from EXAMPLE EMPLOYER", amount: "$2,345.67", balance: "$2,920.19" },
  { date: "2030-01-16", description: "Blue Door Café", amount: "–$6.50", balance: "$2,913.69" },
  { date: "2030-01-20", description: "Transfer out to Savings", amount: "–$1,205.17", balance: "$1,708.52" },
];

/** The statement's pages as texts, with the rows given (split five on the first page, the rest on the second). */
export function samplePages(list: Row[] = SAMPLE_ROWS, closing = "$1,708.52"): Text[][] {
  const page1: Text[] = [
    { x: 24, y: 538.6, text: "Wealthsimple", size: 18 },
    { x: 307.1, y: 553.5, text: "Chequing monthly statement" },
    { x: 356.9, y: 539.3, text: "Jan 1 - Jan 31, 2030" },
    { x: 27.8, y: 510.2, text: "Example Person" },
    { x: 27.8, y: 497, text: "1 Example Street" },
    { x: 27.8, y: 484.4, text: "Sampletown, ON A1A1A1" },
    { x: 27.8, y: 447.2, text: "Account number: 00000000" },
    { x: 42.8, y: 399.3, text: "Your January summary", size: 11 },
    { x: 281.7, y: 402.5, text: "JAN 1 BALANCE", size: 6 },
    { x: 281.7, y: 382.9, text: "$1,000.00", size: 11 },
    { x: 367.6, y: 402.5, text: "JAN 31 BALANCE", size: 6 },
    { x: 367.6, y: 382.9, text: closing, size: 11 },
    { x: 24, y: 333.3, text: "Activity", size: 11 },
    ...header(309.5),
    ...rows(list.slice(0, 5), 283.9),
    ...footer(1, 2),
  ];
  const page2: Text[] = [
    ...header(558.5),
    ...rows(list.slice(5), 533.3),
    { x: 36, y: 380, text: "Date" }, { x: 53, y: 380, text: "is when the transaction happened." },
    { x: 36, y: 371.3, text: "Posted date is when the transaction is processed and finalized." },
    { x: 24, y: 340, text: "Wealthsimple chequing accounts are offered by an example disclosure that runs the width of the page." },
    ...footer(2, 2),
  ];
  return [page1, page2];
}
