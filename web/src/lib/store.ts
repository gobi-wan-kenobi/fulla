// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { reviewed } from "./review";
import { api } from "./api";
import { randomId } from "./ids";
import type { Account, Category, Config, Transaction } from "./model";
import { sharedPotForNew } from "./model";
import { type LocalRow, applyPushResult, createRow, deleteRow, editRow, mergePulled, mutationFor } from "./sync";

const MAX_BATCH = 100;

interface Saved {
  config: Config | null;
  rows: Record<string, LocalRow>;
  cursor: number;
}

function clientId(): string {
  const k = "fulla:client-id";
  let id = localStorage.getItem(k);
  if (!id) {
    id = randomId();
    localStorage.setItem(k, id);
  }
  return id;
}

function load(householdId: string): Saved {
  try {
    const raw = localStorage.getItem(`fulla:household:${householdId}`);
    if (raw) return JSON.parse(raw) as Saved;
  } catch {
    // a damaged copy is only a cache: start again from the server
  }
  return { config: null, rows: {}, cursor: 0 };
}

function save(householdId: string, s: Saved) {
  try {
    localStorage.setItem(`fulla:household:${householdId}`, JSON.stringify(s));
  } catch {
    // storage full or private mode: the server still has everything
  }
}

export interface Household {
  config: Config | null;
  rows: LocalRow[];
  syncing: boolean;
  error: string | null;
  sync: () => Promise<void>;
  saveTransaction: (tx: Transaction, existing?: LocalRow) => Promise<void>;
  deleteTransaction: (row: LocalRow) => Promise<void>;
  /** Several edits at once (bulk recategorize), then one sync. */
  saveTransactions: (changes: { tx: Transaction; existing: LocalRow }[]) => Promise<number>;
  importTransactions: (txs: Transaction[], accounts: Account[], categories: Category[]) => Promise<number>;
  setConfig: (c: Config) => void;
}

/**
 * The household as this browser holds it, and the only way screens write:
 * every edit goes through sync.ts (stamps, base versions, tombstones), then
 * a sync (push, every pull page, at most one more push).
 */
export function useHousehold(householdId: string): Household {
  const state = useRef<Saved>({ config: null, rows: {}, cursor: 0 });
  const [, bump] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const commit = useCallback(() => {
    save(householdId, state.current);
    bump((n) => n + 1);
  }, [householdId]);

  const push = useCallback(async () => {
    const pending = Object.values(state.current.rows).filter((r) => r.state === "pending");
    const cid = clientId();
    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      const batch = pending.slice(i, i + MAX_BATCH).map((row) => ({ row, m: mutationFor(row, cid, randomId()) }));
      const results = await api.push(householdId, batch.map((b) => b.m));
      for (const r of results) {
        const b = batch.find((x) => x.m.mutation_id === r.mutation_id);
        if (!b) continue;
        const current = state.current.rows[b.row.tx.id];
        // A person may have edited again while this push was in flight: that edit stays pending.
        if (current && current.tx.client_updated_at !== b.row.tx.client_updated_at) continue;
        state.current.rows[b.row.tx.id] = applyPushResult(b.row, r);
      }
      commit();
    }
  }, [householdId, commit]);

  const pull = useCallback(async (): Promise<number> => {
    let requeued = 0;
    for (;;) {
      const page = await api.pull(householdId, state.current.cursor, state.current.config?.config_version ?? 0);
      if (page.config) state.current.config = page.config as Config;
      for (const t of page.transactions) {
        const { row, requeue } = mergePulled(state.current.rows[t.id], t);
        state.current.rows[t.id] = row;
        if (requeue) requeued++;
      }
      // The cursor moves on a pull, only forward, only to what the server returned.
      if (page.cursor > state.current.cursor) state.current.cursor = page.cursor;
      commit();
      if (!page.has_more) break;
    }
    return requeued;
  }, [householdId, commit]);

  const sync = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run = (async () => {
      setSyncing(true);
      try {
        do {
          again.current = false;
          if (!state.current.config) {
            state.current.config = await api.configGet(householdId);
            commit();
          }
          await push();
          if ((await pull()) > 0) await push();
        } while (again.current);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSyncing(false);
        running.current = null;
      }
    })();
    running.current = run;
    return run;
  }, [householdId, push, pull, commit]);

  useEffect(() => {
    state.current = load(householdId);
    bump((n) => n + 1);
    void sync();
    const onFocus = () => void sync();
    const onVisible = () => document.visibilityState === "visible" && void sync();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onFocus);
    };
  }, [householdId, sync]);

  const saveTransaction = useCallback(
    async (tx: Transaction, existing?: LocalRow) => {
      const now = new Date();
      const config = state.current.config;
      const row = existing ? editRow(existing, reviewed(existing.tx, tx), now) : createRow(config ? sharedPotForNew(tx, config.household) : tx, now);
      state.current.rows[row.tx.id] = row;
      commit();
      await sync();
    },
    [commit, sync],
  );

  const deleteTransaction = useCallback(
    async (row: LocalRow) => {
      state.current.rows[row.tx.id] = deleteRow(row, new Date());
      commit();
      await sync();
    },
    [commit, sync],
  );

  const saveTransactions = useCallback(
    async (changes: { tx: Transaction; existing: LocalRow }[]) => {
      const now = new Date();
      for (const { tx, existing } of changes) {
        const current = state.current.rows[existing.tx.id] ?? existing;
        state.current.rows[existing.tx.id] = editRow(current, reviewed(current.tx, tx), now);
      }
      commit();
      await sync();
      return changes.length;
    },
    [commit, sync],
  );

  const importTransactions = useCallback(
    async (txs: Transaction[], accounts: Account[], categories: Category[]) => {
      // Accounts and categories first: a row must never reach the server before what it names.
      for (const a of accounts) state.current.config = await api.accountUpsert(householdId, a);
      for (const c of categories) state.current.config = await api.categoryUpsert(householdId, c);
      const now = new Date();
      const household = state.current.config?.household;
      let n = 0;
      for (const t of txs) {
        if (state.current.rows[t.id]) continue;
        state.current.rows[t.id] = createRow(household ? sharedPotForNew(t, household) : t, now);
        n++;
      }
      commit();
      await sync();
      return n;
    },
    [householdId, commit, sync],
  );

  const setConfig = useCallback(
    (c: Config) => {
      state.current.config = c;
      commit();
    },
    [commit],
  );

  return { config: state.current.config, rows: Object.values(state.current.rows), syncing, error, sync, saveTransaction, deleteTransaction, saveTransactions, importTransactions, setConfig };
}
