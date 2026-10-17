// SPDX-License-Identifier: GPL-3.0-or-later

// The same combining-mark blocks core's normalizeName and the database's
// fulla.normalize_name strip, listed explicitly so all three remove exactly
// the same characters (testdata/vectors/normalize_name.json).
const COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;

/** Java's String.trim(): every char up to U+0020 at either end. */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/** A name as it is compared: accents removed, lower case, trimmed. */
export function normalizeName(s: string): string {
  return javaTrim(s.normalize("NFD").replace(COMBINING, "").toLowerCase());
}
