// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The file's text (core's TextDecoding.decode): the named encoding if given,
 * else UTF-8 when the bytes are valid UTF-8 (a BOM is dropped), else
 * Windows-1252, which is what most spreadsheet exports that are not UTF-8
 * turn out to be.
 */
export function decodeText(bytes: Uint8Array, encoding?: string | null): string {
  if (encoding && encoding.toUpperCase() !== "UTF-8") {
    return new TextDecoder(encoding.toLowerCase()).decode(bytes);
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    if (encoding) return new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
    return new TextDecoder("windows-1252").decode(body);
  }
}

/** Test and fixture helper: text to bytes in UTF-8. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Text to Windows-1252 bytes, for fixtures only (Latin-1 range is enough). */
export function windows1252(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) throw new Error("Not representable in this helper");
    out[i] = c;
  }
  return out;
}
