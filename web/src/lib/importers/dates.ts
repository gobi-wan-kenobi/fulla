// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The date patterns the importers use, read the way java.time's
 * DateTimeFormatter.ofPattern reads them: `dd`/`MM` exactly two digits,
 * `d`/`M` one or two, `yyyy` four, `yy` two (2000-2099). Anything else in
 * the pattern must appear literally. Returns YYYY-MM-DD or null.
 */
export function parseDate(text: string | null | undefined, pattern: string): string | null {
  if (text == null) return null;
  const s = text.trim();
  let i = 0;
  let p = 0;
  let day = -1;
  let month = -1;
  let year = -1;
  const digits = (min: number, max: number): number | null => {
    let j = i;
    while (j < s.length && j - i < max && s[j] >= "0" && s[j] <= "9") j++;
    if (j - i < min) return null;
    const v = parseInt(s.slice(i, j), 10);
    i = j;
    return v;
  };
  while (p < pattern.length) {
    const ch = pattern[p];
    let run = 1;
    while (p + run < pattern.length && pattern[p + run] === ch) run++;
    if (ch === "d" || ch === "M" || ch === "y") {
      let v: number | null;
      if (ch === "y") {
        if (run === 2) {
          v = digits(2, 2);
          if (v !== null) v += 2000;
        } else v = digits(4, 4);
      } else v = run >= 2 ? digits(2, 2) : digits(1, 2);
      if (v === null) return null;
      if (ch === "d") day = v;
      else if (ch === "M") month = v;
      else year = v;
      p += run;
    } else {
      for (let k = 0; k < run; k++) {
        if (s[i] !== ch) return null;
        i++;
      }
      p += run;
    }
  }
  if (i !== s.length || day < 1 || month < 1 || month > 12 || year < 0) return null;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > dim) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The patterns the import screen offers, in core's order, then two more for North American files. */
export const DATE_FORMATS = ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd.MM.yyyy", "dd-MM-yyyy", "d/M/yyyy", "M/d/yyyy", "yyyy/MM/dd"];
