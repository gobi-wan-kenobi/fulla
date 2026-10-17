// SPDX-License-Identifier: GPL-3.0-or-later
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256Hex(text: string): string {
  return hex(sha256(enc.encode(text)));
}

function uuidBytes(uuid: string): Uint8Array {
  const h = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new Error(`Not a uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** RFC 4122 version 5 (SHA-1, name-based), as core's DeterministicId.uuid5. */
export function uuid5(namespace: string, name: string): string {
  const ns = uuidBytes(namespace);
  const nameBytes = enc.encode(name);
  const buf = new Uint8Array(ns.length + nameBytes.length);
  buf.set(ns);
  buf.set(nameBytes, ns.length);
  const hash = sha1(buf).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hex(hash);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The id of an imported line: the same file gives the same ids on every phone. */
export function importedId(householdId: string, fingerprint: string): string {
  return uuid5(householdId, fingerprint);
}

export function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for older Safari: RFC 4122 v4 from getRandomValues.
  const b = new Uint8Array(16);
  (globalThis.crypto as Crypto).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
