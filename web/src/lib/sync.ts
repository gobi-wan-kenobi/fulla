// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The web side of docs/sync.md. The browser keeps the household's rows in
 * memory (and a copy in localStorage so a reopened app draws at once), and
 * talks to the same fulla_sync_push / fulla_sync_pull the phones use, with
 * the same rules:
 *
 *  - an edit is stamped with this clock, or one millisecond after the version
 *    it edits, whichever is later (SyncEngine.stampFor);
 *  - a push carries the version the edit started from, and never moves the
 *    cursor; only a pull does, and only to a value the server returned;
 *  - a delete is a tombstone (status "deleted"), never a removal;
 *  - a push answer's server_transaction is adopted at once.
 */
import type { Transaction } from "./model";

export type SyncState = "pending" | "synced" | "rejected";

export interface LocalRow {
  tx: Transaction;
  state: SyncState;
  /** The client_updated_at this edit started from (null for a new row). */
  base: string | null;
  error?: string | null;
}

export interface Mutation {
  mutation_id: string;
  type: "upsert" | "delete";
  client_id: string;
  client_updated_at: string;
  base_client_updated_at?: string;
  transaction: Transaction;
}

export interface PushResult {
  mutation_id: string;
  transaction_id: string;
  ok: boolean;
  applied: boolean;
  conflict?: { winner: "server" | "client"; overwritten: { field: string; before: unknown; after: unknown }[] };
  server_transaction?: Transaction;
  warnings: string[];
  error?: { code: string; message: string };
}

export interface PullPage {
  transactions: Transaction[];
  cursor: number;
  has_more: boolean;
  config_version: number;
  config?: unknown;
  server_time?: string;
}

/** ISO-8601 UTC with milliseconds, as SyncEngine.iso writes it. */
export function iso(d: Date): string {
  return d.toISOString();
}

/** The client_updated_at for a new edit of a row last stamped previous. */
export function stampFor(previous: string | null | undefined, now: Date): string {
  const prev = previous ? Date.parse(previous) : NaN;
  const t = Math.floor(now.getTime());
  if (!Number.isNaN(prev) && t <= prev) return iso(new Date(prev + 1));
  return iso(new Date(t));
}

/** A new row (client's Edits.create). */
export function createRow(tx: Transaction, now: Date): LocalRow {
  const stamp = iso(now);
  return { tx: { ...tx, created_at: stamp, client_updated_at: stamp, server_seq: 0 }, state: "pending", base: null };
}

/** A change to a held row (Edits.edit): stamped after it, remembering the version the server confirmed. */
export function editRow(existing: LocalRow, changed: Transaction, now: Date): LocalRow {
  const stamp = stampFor(existing.tx.client_updated_at, now);
  const base = existing.state === "synced" ? existing.tx.client_updated_at : existing.base;
  return {
    tx: {
      ...changed,
      id: existing.tx.id,
      created_at: existing.tx.created_at,
      client_updated_at: stamp,
      server_seq: existing.tx.server_seq,
      created_by_member_id: existing.tx.created_by_member_id,
    },
    state: "pending",
    base,
    error: null,
  };
}

/** A deletion is a tombstone: the row stays, so the deletion can travel. */
export function deleteRow(existing: LocalRow, now: Date): LocalRow {
  return editRow(existing, { ...existing.tx, status: "deleted" }, now);
}

/** The row as the wire carries it: server-assigned fields are not sent. */
export function wireTransaction(tx: Transaction): Transaction {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { server_seq, created_by_member_id, ...rest } = tx;
  return rest as Transaction;
}

export function mutationFor(row: LocalRow, clientId: string, mutationId: string): Mutation {
  const m: Mutation = {
    mutation_id: mutationId,
    type: row.tx.status === "deleted" ? "delete" : "upsert",
    client_id: clientId,
    client_updated_at: row.tx.client_updated_at,
    transaction: wireTransaction(row.tx),
  };
  if (row.base) m.base_client_updated_at = row.base;
  return m;
}

/** What a push answer does to the row it was for. */
export function applyPushResult(row: LocalRow, result: PushResult): LocalRow {
  if (!result.ok) return { ...row, state: "rejected", error: result.error?.message ?? result.error?.code ?? "Refused" };
  if (result.server_transaction) return { tx: result.server_transaction, state: "synced", base: null, error: null };
  return { ...row, state: "synced", base: null, error: null };
}

/**
 * One pulled row against what this browser holds (docs/sync.md, "Merging on
 * the phone"). Returns the row to keep and whether it must be pushed again.
 */
export function mergePulled(local: LocalRow | undefined, remote: Transaction): { row: LocalRow; requeue: boolean } {
  if (!local) return { row: { tx: remote, state: "synced", base: null }, requeue: false };
  if (local.state === "synced") return { row: { tx: remote, state: "synced", base: null }, requeue: false };
  if (remote.status === "deleted" && local.state !== "pending") return { row: { tx: remote, state: "synced", base: null }, requeue: false };
  if (local.tx.client_updated_at > remote.client_updated_at) {
    return { row: { ...local, base: remote.client_updated_at, tx: { ...local.tx, server_seq: remote.server_seq } }, requeue: true };
  }
  return { row: { tx: remote, state: "synced", base: null }, requeue: false };
}
