// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/**
 * The backend suite. Every test gets its own database cloned from a template
 * that has the shim and every migration applied, so tests cannot interfere
 * with each other and run in any order.
 *
 * Anything a phone can do is done through db.as(user, ...), which runs as the
 * `authenticated` role with that user's JWT claims, exactly as PostgREST
 * would. db.admin() is only for setting up state and for asserting about what
 * was stored.
 *
 * Usage: node supabase/tests/run.js [filter]
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

const ROOT = path.join(__dirname, '..', '..');
const vectors = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata', 'vectors', name), 'utf8')).vectors;
const uuid = () => crypto.randomUUID();

// ── plumbing ────────────────────────────────────────────────────────────────

const tests = [];
/** A test with a household already set up by Alice (owner). */
function test(name, fn) { tests.push({ name, fn, raw: false }); }
/** A test that starts from an empty database. */
function rawTest(name, fn) { tests.push({ name, fn, raw: true }); }

function sqlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return `${h.literal(JSON.stringify(v))}::jsonb`;
  return h.literal(v);
}

function callSql(fn, args = {}) {
  const list = Object.entries(args).map(([k, v]) => `${k} => ${sqlValue(v)}`).join(', ');
  return `select public.${fn}(${list})::text;`;
}

/** Calls an API function as a user and returns its JSON result. */
function rpc(db, user, fn, args) {
  const r = db.as(user, callSql(fn, args), { expectFailure: true });
  if (!r.ok) throw new Error(`${fn} failed: ${r.err.sqlstate} ${r.err.detail}: ${r.err.message}`);
  return JSON.parse(r.out);
}

/** Calls an API function expecting it to fail; returns {status, code, message}. */
function rpcFails(db, user, fn, args) {
  const r = db.as(user, callSql(fn, args), { expectFailure: true });
  assert.ok(!r.ok, `${fn} was expected to fail but returned ${r.out}`);
  const status = r.err.sqlstate && r.err.sqlstate.startsWith('PT') ? Number(r.err.sqlstate.slice(2)) : null;
  return { status, code: r.err.detail, message: r.err.message, sqlstate: r.err.sqlstate };
}

function expectError(db, user, fn, args, code, status) {
  const e = rpcFails(db, user, fn, args);
  assert.equal(e.code, code, `${fn}: expected ${code}, got ${e.code} (${e.message})`);
  if (status) assert.equal(e.status, status, `${fn}: expected HTTP ${status}, got ${e.status}`);
  return e;
}

function newUser(db, email) {
  return db.admin(`insert into auth.users (email) values (${h.literal(email)}) returning id;`).out;
}

function iso(offsetMinutes = 0) {
  return new Date(Date.UTC(2030, 0, 15, 12, 0, 0) + offsetMinutes * 60000).toISOString();
}

// ── a household ─────────────────────────────────────────────────────────────

function setup(db) {
  const alice = newUser(db, 'alice@example.com');
  const created = rpc(db, alice, 'fulla_household_create', {
    p_name: 'Demo household', p_currency: 'EUR', p_locale: 'en-GB',
    p_display_name: 'Alice', p_initials: 'A', p_color_index: 0,
  });
  const ctx = { db, alice, hh: created.household_id, aliceMember: created.member_id, users: {} };
  ctx.config = () => rpc(db, alice, 'fulla_config_get', { p_household_id: ctx.hh });
  const cfg = created.config;
  ctx.cat = (name) => cfg.categories.find((c) => c.name === name).id;
  ctx.account = (name) => cfg.accounts.find((a) => a.name === name).id;
  return ctx;
}

/** Invites a new user into the household and returns {user, member}. */
function join(ctx, name, role = 'member') {
  const inviter = ctx.alice;
  const user = newUser(ctx.db, `${name.toLowerCase()}@example.com`);
  const invite = rpc(ctx.db, inviter, 'fulla_invite_create', { p_household_id: ctx.hh, p_role: role });
  const r = rpc(ctx.db, user, 'fulla_invite_accept', {
    p_code: invite.code, p_display_name: name, p_initials: name[0], p_color_index: 1,
  });
  assert.equal(r.ok, true, `join failed: ${JSON.stringify(r)}`);
  return { user, member: r.member_id };
}

function virtual(ctx, name, id = uuid()) {
  rpc(ctx.db, ctx.alice, 'fulla_member_create_virtual', {
    p_household_id: ctx.hh, p_member: { id, display_name: name, initials: name[0], color_index: 2 },
  });
  return id;
}

/** A valid expense paid by Alice, split between the given members. */
function expense(ctx, over = {}) {
  const members = over.members || [ctx.aliceMember];
  const tx = {
    id: uuid(), kind: 'expense', date: '2030-01-15', amount_minor: 1234,
    category_id: ctx.cat('Groceries'), account_id: ctx.account('Main account'),
    paid_by_member_id: ctx.aliceMember, split: { mode: 'equal', members },
    note: 'GROCERY STORE 01', tags: [], extras: {},
  };
  delete over.members;
  return Object.assign(tx, over);
}

function upsert(tx, stamp = iso(), base) {
  const m = { mutation_id: uuid(), type: 'upsert', client_id: 'device-1', client_updated_at: stamp, transaction: tx };
  if (base !== undefined) m.base_client_updated_at = base;
  return m;
}

function del(tx, stamp = iso()) {
  return { mutation_id: uuid(), type: 'delete', client_id: 'device-1', client_updated_at: stamp,
           transaction: Object.assign({}, tx, { status: 'deleted' }) };
}

function push(ctx, user, mutations) {
  return rpc(ctx.db, user, 'fulla_sync_push', { p_household_id: ctx.hh, p_mutations: mutations }).results;
}

function pull(ctx, user, since = 0, configVersion = null, limit = 500) {
  return rpc(ctx.db, user, 'fulla_sync_pull', {
    p_household_id: ctx.hh, p_since: since, p_config_version: configVersion, p_limit: limit,
  });
}

function stored(ctx, id) {
  const out = ctx.db.admin(`select to_jsonb(t)::text from fulla.transactions t where id = ${h.literal(id)};`).out;
  return out ? JSON.parse(out) : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Security
// ═════════════════════════════════════════════════════════════════════════════

rawTest('anon can execute no API function', ({ db }) => {
  const exposed = db.admin(`
    select string_agg(p.proname, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'fulla\\_%'
       and has_function_privilege('anon', p.oid, 'execute');`).out;
  assert.equal(exposed, '', `anon can execute: ${exposed}`);
  const r = db.anon('select public.fulla_ping();', { expectFailure: true });
  assert.ok(!r.ok && /permission denied/.test(r.err.message));
});

rawTest('every API function is executable by authenticated and is security definer with an empty search_path', ({ db }) => {
  const rows = db.admin(`
    select p.proname || ':' || has_function_privilege('authenticated', p.oid, 'execute') || ':' || p.prosecdef
           || ':' || coalesce(array_to_string(p.proconfig, ','), '')
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'fulla\\_%'
     order by 1;`).out.split('\n');
  assert.ok(rows.length >= 25, `only ${rows.length} API functions`);
  for (const row of rows) {
    const [name, exec, definer, config] = row.split(':');
    assert.equal(exec, 'true', `${name} not executable by authenticated`);
    assert.equal(definer, 'true', `${name} is not security definer`);
    assert.match(config, /search_path=""/, `${name} does not pin search_path`);
  }
});

rawTest('no internal function is executable by anon or authenticated', ({ db }) => {
  const exposed = db.admin(`
    select string_agg(p.proname, ', ') from pg_proc p
     where p.pronamespace = 'fulla'::regnamespace
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`).out;
  assert.equal(exposed, '');
});

test('authenticated holds no privilege on the fulla schema or its tables', (ctx) => {
  const { db } = ctx;
  assert.equal(db.admin(`select has_schema_privilege('authenticated', 'fulla', 'usage');`).out, 'f');
  const tables = db.admin(`
    select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'fulla'::regnamespace and c.relkind in ('r', 'v')
       and (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select')
         or has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
         or has_table_privilege('authenticated', c.oid, 'delete'));`).out;
  assert.equal(tables, '');
  const r = db.as(ctx.alice, 'select count(*) from fulla.transactions;', { expectFailure: true });
  assert.ok(!r.ok && /permission denied/.test(r.err.message));
  const v = db.as(ctx.alice, 'select count(*) from fulla.member_balances;', { expectFailure: true });
  assert.ok(!v.ok && /permission denied/.test(v.err.message));
});

test('row level security is enabled on every table, and the views are security invoker', ({ db }) => {
  const without = db.admin(`
    select string_agg(relname, ', ') from pg_class
     where relnamespace = 'fulla'::regnamespace and relkind = 'r' and not relrowsecurity;`).out;
  assert.equal(without, '');
  const views = db.admin(`
    select string_agg(relname || '=' || coalesce(array_to_string(reloptions, ','), ''), ' ')
      from pg_class where relnamespace = 'fulla'::regnamespace and relkind = 'v';`).out;
  assert.match(views, /period_summary=security_invoker=true/);
  assert.match(views, /member_balances=security_invoker=true/);
});

test('a stranger gets not_member from every function that takes a household', (ctx) => {
  const stranger = newUser(ctx.db, 'mallory@example.com');
  const hh = ctx.hh;
  const calls = [
    ['fulla_config_get', { p_household_id: hh }],
    ['fulla_household_update', { p_household_id: hh, p_patch: { name: 'X' } }],
    ['fulla_invite_create', { p_household_id: hh }],
    ['fulla_invite_list', { p_household_id: hh }],
    ['fulla_invite_revoke', { p_household_id: hh, p_code: 'AAAAAAAAAA' }],
    ['fulla_member_create_virtual', { p_household_id: hh, p_member: { display_name: 'X', initials: 'X' } }],
    ['fulla_member_update', { p_household_id: hh, p_member_id: ctx.aliceMember, p_patch: {} }],
    ['fulla_member_set_role', { p_household_id: hh, p_member_id: ctx.aliceMember, p_role: 'member' }],
    ['fulla_member_remove', { p_household_id: hh, p_member_id: ctx.aliceMember }],
    ['fulla_member_leave', { p_household_id: hh }],
    ['fulla_owner_transfer', { p_household_id: hh, p_member_id: ctx.aliceMember }],
    ['fulla_account_upsert', { p_household_id: hh, p_account: {} }],
    ['fulla_category_upsert', { p_household_id: hh, p_category: {} }],
    ['fulla_field_upsert', { p_household_id: hh, p_field: {} }],
    ['fulla_field_set_categories', { p_household_id: hh, p_field_id: uuid(), p_category_ids: null }],
    ['fulla_budget_upsert', { p_household_id: hh, p_budget: {} }],
    ['fulla_budget_copy', { p_household_id: hh, p_from_period: '2030-01', p_to_period: '2030-02' }],
    ['fulla_recurring_upsert', { p_household_id: hh, p_rule: {} }],
    ['fulla_rule_upsert', { p_household_id: hh, p_rule: {} }],
    ['fulla_import_profile_upsert', { p_household_id: hh, p_profile: {} }],
    ['fulla_trip_upsert', { p_household_id: hh, p_trip: {} }],
    ['fulla_trip_delete', { p_household_id: hh, p_trip_id: uuid() }],
    ['fulla_sync_push', { p_household_id: hh, p_mutations: [] }],
    ['fulla_sync_pull', { p_household_id: hh }],
    ['fulla_period_summary', { p_household_id: hh, p_from: '2030-01', p_to: '2030-12' }],
    ['fulla_member_balances', { p_household_id: hh }],
  ];
  const covered = new Set(calls.map((c) => c[0]));
  const all = ctx.db.admin(`
    select string_agg(p.proname, ',') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'fulla\\_%'
       and pg_get_function_arguments(p.oid) like '%p_household_id%';`).out.split(',');
  for (const fn of all) assert.ok(covered.has(fn), `${fn} is not covered by this test`);
  for (const [fn, args] of calls) expectError(ctx.db, stranger, fn, args, 'not_member', 403);
  assert.deepEqual(rpc(ctx.db, stranger, 'fulla_my_households', {}), []);
});

test('a request without a signed-in user is refused', (ctx) => {
  const r = ctx.db.as(null, callSql('fulla_config_get', { p_household_id: ctx.hh }), { expectFailure: true });
  assert.ok(!r.ok);
  assert.equal(r.err.detail, 'not_authenticated');
});

test('rows are never deleted, not even by the database owner', (ctx) => {
  push(ctx, ctx.alice, [upsert(expense(ctx))]);
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip() });
  for (const table of ['transactions', 'categories', 'accounts', 'members', 'households', 'trips']) {
    const r = ctx.db.admin(`delete from fulla.${table};`, { expectFailure: true });
    assert.ok(!r.ok, `${table} allowed a delete`);
    assert.equal(r.err.detail, 'delete_forbidden');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Households
// ═════════════════════════════════════════════════════════════════════════════

test('a new household has its owner, the default categories and two accounts, and no people or amounts', (ctx) => {
  const cfg = ctx.config();
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/categories.json'), 'utf8'));
  const web = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/web-categories.json'), 'utf8'));
  const top = cfg.categories.filter((c) => c.parent_id === null).sort((a, b) => a.sort - b.sort);
  assert.deepEqual(top.map((c) => c.name), [...defaults.categories, ...web.categories].map((c) => c.name.en));
  const debt = top.find((c) => c.name === 'Debt payments');
  assert.equal(debt.fixed, true);
  const subs = cfg.categories.filter((c) => c.parent_id === debt.id).sort((a, b) => a.sort - b.sort);
  assert.deepEqual(subs.map((c) => c.name), web.categories[0].subcategories.map((s) => s.name.en));
  assert.ok(subs.every((c) => c.fixed && c.applies_to === 'expense'));
  assert.deepEqual(cfg.accounts.map((a) => a.name), defaults.accounts.map((a) => a.name.en));
  assert.equal(cfg.members.length, 1);
  assert.equal(cfg.members[0].role, 'owner');
  assert.equal(cfg.me_member_id, ctx.aliceMember);
  assert.equal(cfg.household.period_start_day, 1);
  assert.equal(cfg.household.income_shift_day, null);
  assert.equal(ctx.db.admin('select count(*) from fulla.transactions;').out, '0');
});

rawTest('a household created in Spanish gets its defaults in Spanish', ({ db }) => {
  const u = newUser(db, 'carol@example.com');
  const r = rpc(db, u, 'fulla_household_create', {
    p_name: 'Casa', p_currency: 'EUR', p_locale: 'es-ES', p_display_name: 'Carol', p_initials: 'C',
  });
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/categories.json'), 'utf8'));
  const web = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/web-categories.json'), 'utf8'));
  const top = r.config.categories.filter((c) => c.parent_id === null).sort((a, b) => a.sort - b.sort);
  assert.deepEqual(top.map((c) => c.name), [...defaults.categories, ...web.categories].map((c) => c.name.es));
});

rawTest('the defaults embedded in SQL are exactly testdata/defaults/categories.json', ({ db }) => {
  const sql = JSON.parse(db.admin('select fulla.defaults()::text;').out);
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/categories.json'), 'utf8'));
  assert.deepEqual(sql, file);
});

rawTest('the web defaults embedded in SQL are exactly testdata/defaults/web-categories.json', ({ db }) => {
  const sql = JSON.parse(db.admin('select fulla.web_defaults()::text;').out);
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/web-categories.json'), 'utf8'));
  assert.deepEqual(sql, file);
});

rawTest('the currency table in SQL is exactly testdata/defaults/currencies.json', ({ db }) => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata/defaults/currencies.json'), 'utf8')).minor_units;
  const codes = Object.keys(file);
  const sql = JSON.parse(db.admin(`
    select jsonb_object_agg(c, fulla.currency_minor_units(c))::text
      from unnest(array[${codes.map(h.literal).join(',')}]) c;`).out);
  assert.deepEqual(sql, file);
  assert.equal(db.admin(`select fulla.currency_minor_units('XXX') is null;`).out, 't');
});

rawTest('household creation validates its input', ({ db }) => {
  const u = newUser(db, 'dave@example.com');
  const base = { p_name: 'Home', p_currency: 'EUR', p_locale: 'en-GB', p_display_name: 'Dave', p_initials: 'D' };
  expectError(db, u, 'fulla_household_create', { ...base, p_currency: 'EURO' }, 'validation_failed', 400);
  expectError(db, u, 'fulla_household_create', { ...base, p_currency: 'XXX' }, 'validation_failed', 400);
  expectError(db, u, 'fulla_household_create', { ...base, p_name: '' }, 'validation_failed', 400);
  expectError(db, u, 'fulla_household_create', { ...base, p_locale: 'English' }, 'validation_failed', 400);
  expectError(db, u, 'fulla_household_create', { ...base, p_initials: 'ABC' }, 'validation_failed', 400);
  const jpy = rpc(db, u, 'fulla_household_create', { ...base, p_currency: 'jpy' });
  assert.equal(jpy.config.household.currency, 'JPY');
});

test('a user can belong to several households and list them', (ctx) => {
  rpc(ctx.db, ctx.alice, 'fulla_household_create', {
    p_name: 'Shared flat', p_currency: 'GBP', p_locale: 'en-GB', p_display_name: 'Alice', p_initials: 'A',
  });
  const mine = rpc(ctx.db, ctx.alice, 'fulla_my_households', {});
  assert.deepEqual(mine.map((x) => x.name), ['Demo household', 'Shared flat']);
  assert.ok(mine.every((x) => x.role === 'owner'));
});

test('household settings: admins change them, only the owner changes currency and limit', (ctx) => {
  const bob = join(ctx, 'Bob', 'admin');
  const carol = join(ctx, 'Carol');
  const v0 = ctx.config().config_version;
  const cfg = rpc(ctx.db, bob.user, 'fulla_household_update', {
    p_household_id: ctx.hh, p_patch: { name: 'Our place', period_start_day: 15 },
  });
  assert.equal(cfg.household.name, 'Our place');
  assert.equal(cfg.household.period_start_day, 15);
  assert.ok(cfg.config_version > v0);
  expectError(ctx.db, bob.user, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { currency: 'USD' } }, 'forbidden_role', 403);
  expectError(ctx.db, carol.user, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { name: 'X' } }, 'forbidden_role', 403);
  const owner = rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { currency: 'USD' } });
  assert.equal(owner.household.currency, 'USD');
  // A mid-month period and a shifted salary are two answers to one question.
  expectError(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { income_shift_day: 25 } }, 'validation_failed');
  rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { period_start_day: 1, income_shift_day: 25 } });
  expectError(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { member_limit: 2 } }, 'validation_failed');
});

// ═════════════════════════════════════════════════════════════════════════════
// Invites
// ═════════════════════════════════════════════════════════════════════════════

test('an invite lets one person in, once', (ctx) => {
  const invite = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh });
  assert.match(invite.code, /^[2-9A-HJKMNP-TV-Z]{10}$/);
  const bob = newUser(ctx.db, 'bob@example.com');
  const carol = newUser(ctx.db, 'carol@example.com');
  const ok = rpc(ctx.db, bob, 'fulla_invite_accept', { p_code: invite.code, p_display_name: 'Bob', p_initials: 'B' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.members.find((m) => m.id === ok.member_id).role, 'member');
  const again = rpc(ctx.db, carol, 'fulla_invite_accept', { p_code: invite.code, p_display_name: 'Carol', p_initials: 'C' });
  assert.deepEqual(again, { ok: false, error: 'invite_used' });
});

test('invite codes are accepted however they are typed', (ctx) => {
  const invite = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh });
  const typed = `${invite.code.slice(0, 5).toLowerCase()}-${invite.code.slice(5)} `;
  const bob = newUser(ctx.db, 'bob@example.com');
  assert.equal(rpc(ctx.db, bob, 'fulla_invite_accept', { p_code: typed, p_display_name: 'Bob', p_initials: 'B' }).ok, true);
});

test('expired, revoked and unknown invites are refused', (ctx) => {
  const bob = newUser(ctx.db, 'bob@example.com');
  const expired = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh, p_ttl_hours: 1 });
  ctx.db.admin(`update fulla.invites set expires_at = now() - interval '1 minute' where code = ${h.literal(expired.code)};`);
  const revoked = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh });
  rpc(ctx.db, ctx.alice, 'fulla_invite_revoke', { p_household_id: ctx.hh, p_code: revoked.code });
  const accept = (code) => rpc(ctx.db, bob, 'fulla_invite_accept', { p_code: code, p_display_name: 'Bob', p_initials: 'B' });
  assert.equal(accept(expired.code).error, 'invite_expired');
  assert.equal(accept(revoked.code).error, 'invite_invalid');
  assert.equal(accept('ZZZZZZZZZZ').error, 'invite_invalid');
  assert.equal(ctx.db.admin(`select count(*) from fulla.invite_attempts;`).out, '3');
  const list = rpc(ctx.db, ctx.alice, 'fulla_invite_list', { p_household_id: ctx.hh });
  assert.equal(list.length, 0);
});

test('guessing invite codes is throttled', (ctx) => {
  const eve = newUser(ctx.db, 'eve@example.com');
  for (let i = 0; i < 10; i += 1) {
    const r = rpc(ctx.db, eve, 'fulla_invite_accept', { p_code: `GUESS${String(i).padStart(5, '2')}`, p_display_name: 'Eve', p_initials: 'E' });
    assert.equal(r.ok, false);
  }
  expectError(ctx.db, eve, 'fulla_invite_accept', { p_code: 'ANYTHING22', p_display_name: 'Eve', p_initials: 'E' }, 'too_many_attempts', 429);
});

test('who may invite whom', (ctx) => {
  const bob = join(ctx, 'Bob', 'admin');
  const carol = join(ctx, 'Carol');
  expectError(ctx.db, carol.user, 'fulla_invite_create', { p_household_id: ctx.hh }, 'forbidden_role', 403);
  rpc(ctx.db, bob.user, 'fulla_invite_create', { p_household_id: ctx.hh, p_role: 'member' });
  expectError(ctx.db, bob.user, 'fulla_invite_create', { p_household_id: ctx.hh, p_role: 'admin' }, 'forbidden_role', 403);
  rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh, p_role: 'admin' });
  expectError(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh, p_role: 'owner' }, 'validation_failed');
});

test('claiming a member without an account inherits their history', (ctx) => {
  const kid = virtual(ctx, 'Dave');
  const tx = expense(ctx, { paid_by_member_id: kid, members: [ctx.aliceMember, kid] });
  push(ctx, ctx.alice, [upsert(tx)]);
  const invite = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh, p_claim_member_id: kid });
  const dave = newUser(ctx.db, 'dave@example.com');
  const r = rpc(ctx.db, dave, 'fulla_invite_accept', { p_code: invite.code, p_display_name: 'Dave', p_initials: 'D' });
  assert.equal(r.member_id, kid);
  const me = r.config.members.find((m) => m.id === kid);
  assert.equal(me.has_account, true);
  assert.equal(r.config.me_member_id, kid);
  const seen = pull(ctx, dave);
  assert.equal(seen.transactions[0].paid_by_member_id, kid);
  // Only a member without an account can be earmarked.
  expectError(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh, p_claim_member_id: ctx.aliceMember }, 'validation_failed');
});

test('a full household takes nobody else, and nobody joins twice', (ctx) => {
  rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { member_limit: 2 } });
  const bob = join(ctx, 'Bob');
  const invite = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh });
  const carol = newUser(ctx.db, 'carol@example.com');
  assert.equal(rpc(ctx.db, carol, 'fulla_invite_accept', { p_code: invite.code, p_display_name: 'Carol', p_initials: 'C' }).error, 'household_full');
  assert.equal(rpc(ctx.db, bob.user, 'fulla_invite_accept', { p_code: invite.code, p_display_name: 'Bob', p_initials: 'B' }).error, 'already_member');
  expectError(ctx.db, ctx.alice, 'fulla_member_create_virtual', { p_household_id: ctx.hh, p_member: { display_name: 'Erin', initials: 'E' } }, 'household_full', 409);
});

test('someone who signs up to the project without an invite sees nothing', (ctx) => {
  push(ctx, ctx.alice, [upsert(expense(ctx))]);
  const mallory = newUser(ctx.db, 'mallory@example.com');
  assert.deepEqual(rpc(ctx.db, mallory, 'fulla_my_households', {}), []);
  expectError(ctx.db, mallory, 'fulla_sync_pull', { p_household_id: ctx.hh }, 'not_member', 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// Members and roles
// ═════════════════════════════════════════════════════════════════════════════

test('a member cannot change the structure; an admin can; neither can do what only the owner does', (ctx) => {
  const bob = join(ctx, 'Bob', 'admin');
  const carol = join(ctx, 'Carol');
  const hh = ctx.hh;
  const adminCalls = [
    ['fulla_household_update', { p_household_id: hh, p_patch: { name: 'X' } }],
    ['fulla_invite_create', { p_household_id: hh }],
    ['fulla_invite_list', { p_household_id: hh }],
    ['fulla_invite_revoke', { p_household_id: hh, p_code: 'AAAAAAAAAA' }],
    ['fulla_member_create_virtual', { p_household_id: hh, p_member: { display_name: 'X', initials: 'X' } }],
    ['fulla_member_remove', { p_household_id: hh, p_member_id: bob.member }],
    ['fulla_account_upsert', { p_household_id: hh, p_account: { id: uuid(), name: 'Savings', type: 'savings' } }],
    ['fulla_category_upsert', { p_household_id: hh, p_category: { id: uuid(), name: 'Pets' } }],
    ['fulla_field_upsert', { p_household_id: hh, p_field: { id: uuid(), key: 'shop', type: 'text', labels: { en: 'Shop' }, applies_to: ['expense'] } }],
    ['fulla_field_set_categories', { p_household_id: hh, p_field_id: uuid(), p_category_ids: null }],
    ['fulla_budget_upsert', { p_household_id: hh, p_budget: { id: uuid(), category_id: ctx.cat('Groceries'), amount_minor: 100 } }],
    ['fulla_budget_copy', { p_household_id: hh, p_from_period: '2030-01', p_to_period: '2030-02' }],
    ['fulla_recurring_upsert', { p_household_id: hh, p_rule: {} }],
    ['fulla_rule_upsert', { p_household_id: hh, p_rule: {} }],
    ['fulla_member_set_role', { p_household_id: hh, p_member_id: bob.member, p_role: 'member' }],
    ['fulla_owner_transfer', { p_household_id: hh, p_member_id: bob.member }],
  ];
  for (const [fn, args] of adminCalls) expectError(ctx.db, carol.user, fn, args, 'forbidden_role', 403);
  const ownerCalls = [
    ['fulla_member_set_role', { p_household_id: hh, p_member_id: carol.member, p_role: 'admin' }],
    ['fulla_owner_transfer', { p_household_id: hh, p_member_id: carol.member }],
    ['fulla_household_update', { p_household_id: hh, p_patch: { member_limit: 10 } }],
    ['fulla_invite_create', { p_household_id: hh, p_role: 'admin' }],
  ];
  for (const [fn, args] of ownerCalls) expectError(ctx.db, bob.user, fn, args, 'forbidden_role', 403);
  // And what every member may do.
  push(ctx, carol.user, [upsert(expense(ctx, { paid_by_member_id: carol.member, members: [carol.member] }))]);
  rpc(ctx.db, carol.user, 'fulla_import_profile_upsert', {
    p_household_id: hh,
    p_profile: { id: uuid(), name: 'My bank', mapping: { date_column: 0, date_format: 'dd/MM/yyyy', amount: { mode: 'single', column: 2 } } },
  });
  rpc(ctx.db, carol.user, 'fulla_member_update', { p_household_id: hh, p_member_id: carol.member, p_patch: { display_name: 'Caroline' } });
  expectError(ctx.db, carol.user, 'fulla_member_update', { p_household_id: hh, p_member_id: bob.member, p_patch: { display_name: 'X' } }, 'forbidden_role');
});

test('a removed member loses access at once and their history stays', (ctx) => {
  const bob = join(ctx, 'Bob');
  const tx = expense(ctx, { paid_by_member_id: bob.member, members: [bob.member, ctx.aliceMember] });
  push(ctx, bob.user, [upsert(tx)]);
  rpc(ctx.db, ctx.alice, 'fulla_member_remove', { p_household_id: ctx.hh, p_member_id: bob.member });
  expectError(ctx.db, bob.user, 'fulla_sync_pull', { p_household_id: ctx.hh }, 'not_member');
  expectError(ctx.db, bob.user, 'fulla_sync_push', { p_household_id: ctx.hh, p_mutations: [] }, 'not_member');
  assert.equal(pull(ctx, ctx.alice).transactions[0].paid_by_member_id, bob.member);
  const cfg = ctx.config();
  assert.equal(cfg.members.find((m) => m.id === bob.member).status, 'removed');
});

test('nobody removes the owner, and admins do not remove admins', (ctx) => {
  const bob = join(ctx, 'Bob', 'admin');
  const carol = join(ctx, 'Carol', 'admin');
  expectError(ctx.db, bob.user, 'fulla_member_remove', { p_household_id: ctx.hh, p_member_id: ctx.aliceMember }, 'forbidden_role');
  expectError(ctx.db, bob.user, 'fulla_member_remove', { p_household_id: ctx.hh, p_member_id: carol.member }, 'forbidden_role');
  expectError(ctx.db, ctx.alice, 'fulla_member_remove', { p_household_id: ctx.hh, p_member_id: ctx.aliceMember }, 'validation_failed');
  rpc(ctx.db, ctx.alice, 'fulla_member_remove', { p_household_id: ctx.hh, p_member_id: carol.member });
});

test('the owner cannot leave without handing over; a member who leaves and comes back keeps their member', (ctx) => {
  const bob = join(ctx, 'Bob');
  expectError(ctx.db, ctx.alice, 'fulla_member_leave', { p_household_id: ctx.hh }, 'last_owner', 409);
  rpc(ctx.db, bob.user, 'fulla_member_leave', { p_household_id: ctx.hh });
  expectError(ctx.db, bob.user, 'fulla_config_get', { p_household_id: ctx.hh }, 'not_member');
  const invite = rpc(ctx.db, ctx.alice, 'fulla_invite_create', { p_household_id: ctx.hh });
  const back = rpc(ctx.db, bob.user, 'fulla_invite_accept', { p_code: invite.code, p_display_name: 'Bob', p_initials: 'B' });
  assert.equal(back.member_id, bob.member);
});

test('ownership moves to exactly one other person with an account', (ctx) => {
  const bob = join(ctx, 'Bob');
  const kid = virtual(ctx, 'Dave');
  expectError(ctx.db, ctx.alice, 'fulla_owner_transfer', { p_household_id: ctx.hh, p_member_id: kid }, 'not_found');
  const cfg = rpc(ctx.db, ctx.alice, 'fulla_owner_transfer', { p_household_id: ctx.hh, p_member_id: bob.member });
  const roles = Object.fromEntries(cfg.members.map((m) => [m.id, m.role]));
  assert.equal(roles[bob.member], 'owner');
  assert.equal(roles[ctx.aliceMember], 'admin');
  assert.equal(cfg.members.filter((m) => m.role === 'owner').length, 1);
  expectError(ctx.db, ctx.alice, 'fulla_member_set_role', { p_household_id: ctx.hh, p_member_id: bob.member, p_role: 'member' }, 'forbidden_role');
  expectError(ctx.db, bob.user, 'fulla_member_set_role', { p_household_id: ctx.hh, p_member_id: bob.member, p_role: 'admin' }, 'last_owner');
  expectError(ctx.db, bob.user, 'fulla_member_set_role', { p_household_id: ctx.hh, p_member_id: kid, p_role: 'admin' }, 'not_found');
});

// ═════════════════════════════════════════════════════════════════════════════
// Structure
// ═════════════════════════════════════════════════════════════════════════════

test('account names are unique per household, accents and case aside, among active accounts', (ctx) => {
  const save = (a) => rpc(ctx.db, ctx.alice, 'fulla_account_upsert', { p_household_id: ctx.hh, p_account: a });
  const id = uuid();
  save({ id, name: 'Joint Café', type: 'checking' });
  expectError(ctx.db, ctx.alice, 'fulla_account_upsert', { p_household_id: ctx.hh, p_account: { id: uuid(), name: ' joint cafe ', type: 'savings' } }, 'validation_failed');
  save({ id, name: 'Joint Café', type: 'checking', archived: true });
  save({ id: uuid(), name: 'Joint cafe', type: 'savings' });
  expectError(ctx.db, ctx.alice, 'fulla_account_upsert', { p_household_id: ctx.hh, p_account: { id: uuid(), name: 'X', type: 'piggy' } }, 'validation_failed');
});

test('editing an account without opening_balance_minor or opening_balance_date keeps both', (ctx) => {
  const save = (a) => rpc(ctx.db, ctx.alice, 'fulla_account_upsert', { p_household_id: ctx.hh, p_account: a });
  const id = uuid();
  let cfg = save({ id, name: 'Checking', type: 'checking', opening_balance_minor: 50000, opening_balance_date: '2030-01-15' });
  let account = cfg.accounts.find((a) => a.id === id);
  assert.equal(account.opening_balance_minor, 50000);
  assert.equal(account.opening_balance_date, '2030-01-15');

  // The edit dialog's "rename only" payload: no balance, no date at all.
  cfg = save({ id, name: 'Checking Account', type: 'checking' });
  account = cfg.accounts.find((a) => a.id === id);
  assert.equal(account.name, 'Checking Account');
  assert.equal(account.opening_balance_minor, 50000);
  assert.equal(account.opening_balance_date, '2030-01-15');
});

test('round-up: both keys together, to another account of the household, never from cash, absent keeps and null clears', (ctx) => {
  const save = (a) => rpc(ctx.db, ctx.alice, 'fulla_account_upsert', { p_household_id: ctx.hh, p_account: a });
  const fails = (a) => expectError(ctx.db, ctx.alice, 'fulla_account_upsert', { p_household_id: ctx.hh, p_account: a }, 'validation_failed');
  const card = uuid();
  const orange = uuid();
  const wallet = uuid();
  save({ id: orange, name: 'Orange', type: 'savings' });
  save({ id: wallet, name: 'Wallet', type: 'cash' });
  let cfg = save({ id: card, name: 'Card', type: 'checking', round_up_to: orange, round_up_multiplier: 2 });
  let account = cfg.accounts.find((a) => a.id === card);
  assert.equal(account.round_up_to, orange);
  assert.equal(account.round_up_multiplier, 2);

  // The "rename only" payload of a phone that has never heard of round-up leaves it as it is.
  cfg = save({ id: card, name: 'Card 2', type: 'checking' });
  account = cfg.accounts.find((a) => a.id === card);
  assert.equal(account.name, 'Card 2');
  assert.equal(account.round_up_to, orange);
  assert.equal(account.round_up_multiplier, 2);

  fails({ id: card, name: 'Card 2', type: 'checking', round_up_to: orange, round_up_multiplier: 3 });
  fails({ id: card, name: 'Card 2', type: 'checking', round_up_to: orange });
  fails({ id: card, name: 'Card 2', type: 'checking', round_up_multiplier: 2 });
  fails({ id: card, name: 'Card 2', type: 'checking', round_up_to: card, round_up_multiplier: 1 });
  fails({ id: card, name: 'Card 2', type: 'checking', round_up_to: uuid(), round_up_multiplier: 1 });
  fails({ id: wallet, name: 'Wallet', type: 'cash', round_up_to: orange, round_up_multiplier: 1 });
  for (const multiplier of [1, 5, 10]) {
    cfg = save({ id: card, name: 'Card 2', type: 'checking', round_up_to: orange, round_up_multiplier: multiplier });
    assert.equal(cfg.accounts.find((a) => a.id === card).round_up_multiplier, multiplier);
  }

  cfg = save({ id: card, name: 'Card 2', type: 'checking', round_up_to: null, round_up_multiplier: null });
  account = cfg.accounts.find((a) => a.id === card);
  assert.equal(account.round_up_to, null);
  assert.equal(account.round_up_multiplier, null);
});

test('categories nest one level deep', (ctx) => {
  const save = (c) => rpc(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: c });
  const pets = uuid();
  const vet = uuid();
  save({ id: pets, name: 'Pets', applies_to: 'expense', icon: 'pets', color_index: 3 });
  save({ id: vet, name: 'Vet', parent_id: pets });
  const fails = (c) => expectError(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: c }, 'validation_failed');
  fails({ id: uuid(), name: 'Too deep', parent_id: vet });
  fails({ id: pets, name: 'Pets', parent_id: ctx.cat('Housing') });
  fails({ id: uuid(), name: 'pets' });
  save({ id: uuid(), name: 'Pets', parent_id: ctx.cat('Leisure') });
  fails({ id: uuid(), name: 'Bad icon', icon: 'Not An Icon' });
});

test('custom fields: key rules, immutable key and type, options and defaults', (ctx) => {
  const save = (f) => rpc(ctx.db, ctx.alice, 'fulla_field_upsert', { p_household_id: ctx.hh, p_field: f });
  const fails = (f) => expectError(ctx.db, ctx.alice, 'fulla_field_upsert', { p_household_id: ctx.hh, p_field: f }, 'validation_failed');
  const id = uuid();
  const field = { id, key: 'method', type: 'select', labels: { en: 'Payment method', es: 'Forma de pago' },
                  applies_to: ['expense'], options: ['Card', 'Cash'], default_value: 'Card' };
  save(field);
  fails({ ...field, key: 'payment' });
  fails({ ...field, type: 'text' });
  fails({ ...field, id: uuid() });
  fails({ ...field, id: uuid(), key: 'amount_minor' });
  fails({ ...field, id: uuid(), key: 'Bad Key' });
  fails({ ...field, id: uuid(), key: 'other', labels: {} });
  fails({ ...field, id: uuid(), key: 'other', applies_to: ['wages'] });
  fails({ ...field, id: uuid(), key: 'other', options: ['A', 'A'] });
  fails({ id: uuid(), key: 'count', type: 'number', labels: { en: 'Count' }, applies_to: ['expense'], default_value: 'many' });
  fails({ id: uuid(), key: 'note2', type: 'text', labels: { en: 'N' }, applies_to: ['expense'], options: ['x'] });
  const cfg = save({ ...field, labels: { en: 'Paid with' }, archived: true });
  const saved = cfg.custom_fields.find((f) => f.id === id);
  assert.equal(saved.labels.en, 'Paid with');
  assert.equal(saved.archived, true);
});

test('budgets: a default for every period, overridden per period, and copied forward', (ctx) => {
  const save = (b) => rpc(ctx.db, ctx.alice, 'fulla_budget_upsert', { p_household_id: ctx.hh, p_budget: b });
  const groceries = ctx.cat('Groceries');
  save({ id: uuid(), category_id: groceries, period: null, amount_minor: 30000 });
  save({ id: uuid(), category_id: groceries, period: '2030-01', amount_minor: 25000 });
  // Same category and period again: the existing limit is updated, not duplicated.
  save({ id: uuid(), category_id: groceries, period: '2030-01', amount_minor: 26000 });
  save({ id: uuid(), category_id: ctx.cat('Leisure'), period: null, amount_minor: 5000 });
  expectError(ctx.db, ctx.alice, 'fulla_budget_upsert', { p_household_id: ctx.hh, p_budget: { id: uuid(), category_id: ctx.cat('Salary'), amount_minor: 1 } }, 'validation_failed');
  expectError(ctx.db, ctx.alice, 'fulla_budget_upsert', { p_household_id: ctx.hh, p_budget: { id: uuid(), category_id: groceries, period: '2030-13', amount_minor: 1 } }, 'validation_failed');
  const cfg = rpc(ctx.db, ctx.alice, 'fulla_budget_copy', { p_household_id: ctx.hh, p_from_period: '2030-01', p_to_period: '2030-02' });
  const feb = cfg.budgets.filter((b) => b.period === '2030-02');
  assert.equal(feb.find((b) => b.category_id === groceries).amount_minor, 26000);
  assert.equal(feb.find((b) => b.category_id === ctx.cat('Leisure')).amount_minor, 5000);
  assert.equal(cfg.budgets.filter((b) => b.period === '2030-01').length, 1);
});

test('recurring rules: the template is checked like a transaction, the schedule like a schedule', (ctx) => {
  const rule = {
    id: uuid(), name: 'Rent', start_date: '2030-01-01', auto_create: true,
    schedule: { freq: 'monthly', by_month_day: -1 },
    template: { kind: 'expense', amount_minor: 50000, category_id: ctx.cat('Housing'), paid_by_member_id: ctx.aliceMember,
                split: { mode: 'equal', members: [ctx.aliceMember] }, recurrence: 'fixed', note: 'RENT' },
  };
  const cfg = rpc(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: rule });
  const saved = cfg.recurring_rules[0];
  assert.deepEqual(saved.schedule, { freq: 'monthly', interval: 1, by_month_day: -1 });
  assert.equal(saved.template.id, undefined);
  assert.equal(saved.template.date, undefined);
  const fails = (r) => expectError(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: r }, 'validation_failed');
  fails({ ...rule, template: { ...rule.template, category_id: ctx.cat('Salary') } });
  fails({ ...rule, schedule: { freq: 'fortnightly' } });
  fails({ ...rule, schedule: { freq: 'weekly', by_weekday: [8] } });
  fails({ ...rule, schedule: { freq: 'yearly', by_month_day: 1 } });
  fails({ ...rule, end_date: '2029-12-31' });
  rpc(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: { ...rule, id: uuid(), schedule: { freq: 'weekly', interval: 2, by_weekday: [5, 1] } } });
});

test('a monthly schedule can name its months, and then it is the calendar', (ctx) => {
  const rule = {
    id: uuid(), name: 'Tax', start_date: '2030-01-01', auto_create: true,
    schedule: { freq: 'monthly', by_month_day: 10, by_months: [12, 10] },
    template: { kind: 'expense', amount_minor: 30000, category_id: ctx.cat('Housing'), paid_by_member_id: ctx.aliceMember,
                split: { mode: 'equal', members: [ctx.aliceMember] }, recurrence: 'fixed', note: 'TAX' },
  };
  const save = (r) => rpc(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: r });
  const fails = (r) => expectError(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: r }, 'validation_failed');
  const saved = save(rule).recurring_rules.find((r) => r.id === rule.id);
  assert.deepEqual(saved.schedule, { freq: 'monthly', interval: 1, by_month_day: 10, by_months: [10, 12] });
  const every3 = save({ ...rule, id: uuid(), schedule: { freq: 'monthly', interval: 3, by_month_day: 15 } });
  assert.ok(every3.recurring_rules.some((r) => r.schedule.interval === 3 && r.schedule.by_months === undefined));
  fails({ ...rule, id: uuid(), schedule: { freq: 'monthly', by_month_day: 10, by_months: [13] } });
  fails({ ...rule, id: uuid(), schedule: { freq: 'monthly', by_month_day: 10, by_months: [3, 3] } });
  fails({ ...rule, id: uuid(), schedule: { freq: 'monthly', by_month_day: 10, by_months: 'oct' } });
  fails({ ...rule, id: uuid(), schedule: { freq: 'monthly', interval: 3, by_month_day: 10, by_months: [1, 4] } });
});

test('a recurring item can be archived, and it comes back archived', (ctx) => {
  const rule = {
    id: uuid(), name: 'Gym', start_date: '2030-01-01', auto_create: true, schedule: { freq: 'monthly', by_month_day: 5 },
    template: { kind: 'expense', amount_minor: 3000, category_id: ctx.cat('Housing'), paid_by_member_id: ctx.aliceMember,
                split: { mode: 'equal', members: [ctx.aliceMember] }, recurrence: 'fixed', note: 'GYM' },
  };
  const save = (r) => rpc(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: r });
  assert.equal(save(rule).recurring_rules.find((r) => r.id === rule.id).archived, false, 'not archived unless said');
  const archived = save({ ...rule, active: false, archived: true }).recurring_rules.find((r) => r.id === rule.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.active, false);
  assert.equal(save({ ...rule, active: true, archived: false }).recurring_rules.find((r) => r.id === rule.id).archived, false, 'and it can be brought back');
});

test('categorisation rules must do something valid', (ctx) => {
  const save = (r) => rpc(ctx.db, ctx.alice, 'fulla_rule_upsert', { p_household_id: ctx.hh, p_rule: r });
  const fails = (r) => expectError(ctx.db, ctx.alice, 'fulla_rule_upsert', { p_household_id: ctx.hh, p_rule: r }, 'validation_failed');
  save({ id: uuid(), pattern: 'GROCERY STORE', action: { category_id: ctx.cat('Groceries') } });
  save({ id: uuid(), pattern: 'CASH MACHINE', action: { kind: 'transfer', to_account_id: ctx.account('Cash') } });
  fails({ id: uuid(), pattern: 'X', action: {} });
  fails({ id: uuid(), pattern: 'X', action: { kind: 'transfer' } });
  fails({ id: uuid(), pattern: '', action: { tags: ['a'] } });
});

test('a deleted rule is archived, and a save that leaves `archived` out keeps it', (ctx) => {
  const save = (r) => rpc(ctx.db, ctx.alice, 'fulla_rule_upsert', { p_household_id: ctx.hh, p_rule: r });
  const rule = { id: uuid(), pattern: 'TIM HORTONS', action: { category_id: ctx.cat('Groceries') } };
  const find = (cfg) => cfg.categorization_rules.find((r) => r.id === rule.id);
  assert.equal(find(save(rule)).archived, false, 'not archived unless said');
  const gone = find(save({ ...rule, active: false, archived: true }));
  assert.equal(gone.archived, true);
  assert.equal(gone.active, false);
  // A phone that has not heard of `archived` edits it: it stays deleted.
  assert.equal(find(save({ ...rule, pattern: 'TIMS', active: false })).archived, true);
  assert.equal(find(save({ ...rule, archived: false, active: true })).archived, false, 'and it can be brought back');
  const r = ctx.db.admin(`delete from fulla.categorization_rules where id = '${rule.id}';`, { expectFailure: true });
  assert.equal(r.err.detail, 'delete_forbidden');
});

test('a category can be fixed spending, and a save that leaves `fixed` out keeps it', (ctx) => {
  const id = ctx.cat('Utilities');
  const base = ctx.config().categories.find((c) => c.id === id);
  assert.equal(base.fixed, false, 'flexible unless said');
  const save = (c) => rpc(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: c }).categories.find((k) => k.id === id);
  const { fixed: _f, ...withoutFixed } = base;
  assert.equal(save({ ...base, fixed: true }).fixed, true);
  assert.equal(save({ ...withoutFixed, name: 'Bills' }).fixed, true, 'an older phone renaming it keeps it fixed');
  assert.equal(save({ ...base, name: 'Bills', fixed: false }).fixed, false);
  expectError(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: { ...base, fixed: 'yes' } }, 'validation_failed');
  const fresh = rpc(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: { id: uuid(), name: 'Rent' } }).categories.find((c) => c.name === 'Rent');
  assert.equal(fresh.fixed, false);
});

test('the schema version is the migration count', (ctx) => {
  assert.equal(rpc(ctx.db, ctx.alice, 'fulla_schema_version', {}), h.migrations().length);
});

test('ids belong to one household: another household cannot reuse them', (ctx) => {
  const other = newUser(ctx.db, 'frank@example.com');
  const hh2 = rpc(ctx.db, other, 'fulla_household_create', { p_name: 'Other', p_currency: 'EUR', p_locale: 'en', p_display_name: 'Frank', p_initials: 'F' }).household_id;
  const accountId = ctx.account('Cash');
  expectError(ctx.db, other, 'fulla_account_upsert', { p_household_id: hh2, p_account: { id: accountId, name: 'Stolen', type: 'cash' } }, 'already_exists', 409);
  const tx = expense(ctx);
  push(ctx, ctx.alice, [upsert(tx)]);
  const r = rpc(ctx.db, other, 'fulla_sync_push', { p_household_id: hh2, p_mutations: [upsert({ ...tx, category_id: null })] }).results[0];
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'already_exists');
});

test('every structural change bumps config_version, and a pull carries the config only when it moved', (ctx) => {
  const v1 = pull(ctx, ctx.alice, 0, null);
  assert.ok(v1.config);
  const same = pull(ctx, ctx.alice, 0, v1.config_version);
  assert.equal(same.config, undefined);
  rpc(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: { id: uuid(), name: 'Pets' } });
  const moved = pull(ctx, ctx.alice, 0, v1.config_version);
  assert.ok(moved.config_version > v1.config_version);
  assert.ok(moved.config.categories.some((c) => c.name === 'Pets'));
  // Transactions are data, not structure.
  push(ctx, ctx.alice, [upsert(expense(ctx))]);
  assert.equal(pull(ctx, ctx.alice, 0, moved.config_version).config, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// Local mode → shared
// ═════════════════════════════════════════════════════════════════════════════

function localPayload() {
  const household = uuid();
  const me = uuid();
  const kid = uuid();
  const cash = uuid();
  const food = uuid();
  const snacks = uuid();
  return {
    ids: { household, me, kid, cash, food, snacks },
    payload: {
      household: { id: household, name: 'Phone household', currency: 'EUR', locale: 'en-GB', period_start_day: 1 },
      me_member_id: me,
      members: [
        { id: me, display_name: 'Alice', initials: 'A', color_index: 0 },
        { id: kid, display_name: 'Dave', initials: 'D', color_index: 3 },
      ],
      accounts: [{ id: cash, name: 'Cash', type: 'cash' }],
      // Child listed first on purpose: the function must insert parents first.
      categories: [
        { id: snacks, name: 'Snacks', parent_id: food, applies_to: 'expense' },
        { id: food, name: 'Food', applies_to: 'expense' },
      ],
      custom_fields: [{ id: uuid(), key: 'shop', type: 'text', labels: { en: 'Shop' }, applies_to: ['expense'] }],
      budgets: [{ id: uuid(), category_id: food, period: null, amount_minor: 10000 }],
    },
  };
}

rawTest('a household that lived on one phone becomes shared with every id intact', ({ db }) => {
  const alice = newUser(db, 'alice@example.com');
  const { ids, payload } = localPayload();
  const r = rpc(db, alice, 'fulla_household_create_from_local', { p_payload: payload });
  assert.equal(r.household_id, ids.household);
  assert.equal(r.member_id, ids.me);
  const members = Object.fromEntries(r.config.members.map((m) => [m.id, m]));
  assert.equal(members[ids.me].role, 'owner');
  assert.equal(members[ids.me].has_account, true);
  assert.equal(members[ids.kid].has_account, false);
  assert.equal(r.config.categories.find((c) => c.id === ids.snacks).parent_id, ids.food);
  // The phone's rows then arrive through the ordinary push, pointing at ids that exist.
  const tx = { id: uuid(), kind: 'expense', date: '2030-01-10', amount_minor: 450, category_id: ids.snacks,
               account_id: ids.cash, paid_by_member_id: ids.kid, split: { mode: 'equal', members: [ids.me, ids.kid] },
               extras: { shop: 'CORNER SHOP' } };
  const res = rpc(db, alice, 'fulla_sync_push', { p_household_id: ids.household, p_mutations: [upsert(tx)] }).results[0];
  assert.equal(res.applied, true);
  // Retrying the upload is harmless.
  const again = rpc(db, alice, 'fulla_household_create_from_local', { p_payload: payload });
  assert.equal(again.member_id, ids.me);
  // But nobody else can claim that id.
  const mallory = newUser(db, 'mallory@example.com');
  expectError(db, mallory, 'fulla_household_create_from_local', { p_payload: payload }, 'already_exists', 409);
});

// ═════════════════════════════════════════════════════════════════════════════
// Push
// ═════════════════════════════════════════════════════════════════════════════

test('a pushed expense comes back from a pull exactly as sent', (ctx) => {
  const tx = expense(ctx, { tags: ['weekly', 'Weekly ', 'shop'], created_at: iso(-5) });
  const [r] = push(ctx, ctx.alice, [upsert(tx, iso())]);
  assert.deepEqual({ ok: r.ok, applied: r.applied, id: r.transaction_id }, { ok: true, applied: true, id: tx.id });
  assert.equal(r.cursor, undefined, 'a push must not hand out a cursor');
  const [row] = pull(ctx, ctx.alice).transactions;
  for (const k of ['id', 'kind', 'date', 'amount_minor', 'category_id', 'account_id', 'paid_by_member_id', 'note']) {
    assert.equal(row[k], tx[k], k);
  }
  assert.deepEqual(row.tags, ['weekly', 'shop']);
  assert.equal(row.client_updated_at, iso());
  assert.equal(row.created_at, iso(-5));
  assert.equal(row.created_by_member_id, ctx.aliceMember);
  assert.ok(Number(row.server_seq) > 0);
  assert.equal(row.household_id, undefined);
});

test('what each kind of transaction requires', (ctx) => {
  const bob = join(ctx, 'Bob');
  const both = [ctx.aliceMember, bob.member];
  const ok = (tx) => {
    const [r] = push(ctx, ctx.alice, [upsert(tx)]);
    assert.equal(r.ok, true, `${tx.kind} refused: ${JSON.stringify(r.error)}`);
  };
  const bad = (tx, why) => {
    const [r] = push(ctx, ctx.alice, [upsert(tx)]);
    assert.equal(r.ok, false, `accepted: ${why}`);
    assert.equal(r.error.code, 'validation_failed', why);
  };
  const cash = ctx.account('Cash');
  const main = ctx.account('Main account');
  ok(expense(ctx, { members: both }));
  bad(expense(ctx, { split: null }), 'an expense in a household of two without a split');
  bad(expense(ctx, { members: both, category_id: null }), 'an expense without a category');
  bad(expense(ctx, { members: both, category_id: ctx.cat('Salary') }), 'an expense in an income category');
  bad(expense(ctx, { members: both, paid_by_member_id: null }), 'an expense without a payer');
  bad(expense(ctx, { members: both, amount_minor: 0 }), 'a zero amount');
  bad(expense(ctx, { members: both, amount_minor: 12.5 }), 'a fractional minor amount');
  bad(expense(ctx, { members: both, date: '2030-02-30' }), 'an impossible date');
  bad(expense(ctx, { members: both, to_account_id: cash }), 'an expense with a destination account');
  ok({ id: uuid(), kind: 'income', date: '2030-01-01', amount_minor: 200000, category_id: ctx.cat('Salary'), recurrence: 'fixed' });
  bad({ id: uuid(), kind: 'income', date: '2030-01-01', amount_minor: 1, category_id: ctx.cat('Groceries') }, 'income in a spending category');
  bad({ id: uuid(), kind: 'income', date: '2030-01-01', amount_minor: 1, category_id: ctx.cat('Salary'), split: { mode: 'equal', members: both } }, 'a split income');
  ok({ id: uuid(), kind: 'transfer', date: '2030-01-02', amount_minor: 5000, account_id: main, to_account_id: cash });
  bad({ id: uuid(), kind: 'transfer', date: '2030-01-02', amount_minor: 5000, account_id: main, to_account_id: main }, 'a transfer to the same account');
  bad({ id: uuid(), kind: 'transfer', date: '2030-01-02', amount_minor: 5000, account_id: main }, 'a transfer with one account');
  bad({ id: uuid(), kind: 'transfer', date: '2030-01-02', amount_minor: 5000, account_id: main, to_account_id: cash, category_id: ctx.cat('Other') }, 'a transfer with a category');
  ok({ id: uuid(), kind: 'settlement', date: '2030-01-03', amount_minor: 617, paid_by_member_id: bob.member, to_member_id: ctx.aliceMember });
  bad({ id: uuid(), kind: 'settlement', date: '2030-01-03', amount_minor: 617, paid_by_member_id: bob.member, to_member_id: bob.member }, 'a settlement to oneself');
  ok({ id: uuid(), kind: 'refund', date: '2030-01-04', amount_minor: 99, category_id: ctx.cat('Shopping'), paid_by_member_id: ctx.aliceMember, split: { mode: 'equal', members: both } });
  bad({ id: uuid(), kind: 'wages', date: '2030-01-04', amount_minor: 1 }, 'an unknown kind');
});

test('splits are checked', (ctx) => {
  const bob = join(ctx, 'Bob');
  const both = [ctx.aliceMember, bob.member];
  const r = (split, amount = 1000) => push(ctx, ctx.alice, [upsert(expense(ctx, { split, amount_minor: amount }))])[0];
  assert.equal(r({ mode: 'exact', amounts: { [ctx.aliceMember]: 600, [bob.member]: 400 } }).ok, true);
  assert.equal(r({ mode: 'exact', amounts: { [ctx.aliceMember]: 600, [bob.member]: 399 } }).ok, false);
  assert.equal(r({ mode: 'shares', shares: { [ctx.aliceMember]: 2, [bob.member]: 1 } }).ok, true);
  assert.equal(r({ mode: 'shares', shares: { [ctx.aliceMember]: 0 } }).ok, false);
  assert.equal(r({ mode: 'equal', members: [ctx.aliceMember, ctx.aliceMember] }).ok, false);
  assert.equal(r({ mode: 'equal', members: [] }).ok, false);
  assert.equal(r({ mode: 'equal', members: [...both, uuid()] }).ok, false);
  assert.equal(r({ mode: 'thirds' }).ok, false);
});

test('a household of one may leave expenses unsplit', (ctx) => {
  const [r] = push(ctx, ctx.alice, [upsert(expense(ctx, { split: null }))]);
  assert.equal(r.ok, true);
});

test('references to another household are refused', (ctx) => {
  const frank = newUser(ctx.db, 'frank@example.com');
  const other = rpc(ctx.db, frank, 'fulla_household_create', { p_name: 'Other', p_currency: 'EUR', p_locale: 'en', p_display_name: 'Frank', p_initials: 'F' });
  const theirCategory = other.config.categories[0].id;
  const [r] = push(ctx, ctx.alice, [upsert(expense(ctx, { category_id: theirCategory }))]);
  assert.equal(r.ok, false);
  const [m] = push(ctx, ctx.alice, [upsert(expense(ctx, { paid_by_member_id: other.member_id }))]);
  assert.equal(m.ok, false);
});

test('custom fields: an absent key keeps its value, null clears it, unknown keys are dropped with a warning', (ctx) => {
  const saveField = (f) => rpc(ctx.db, ctx.alice, 'fulla_field_upsert', { p_household_id: ctx.hh, p_field: f });
  saveField({ id: uuid(), key: 'shop', type: 'text', labels: { en: 'Shop' }, applies_to: ['expense'] });
  saveField({ id: uuid(), key: 'method', type: 'select', labels: { en: 'Method' }, applies_to: ['expense'], options: ['Card', 'Cash'] });
  const tx = expense(ctx, { extras: { shop: 'CORNER SHOP', method: 'Card' } });
  push(ctx, ctx.alice, [upsert(tx, iso(0))]);
  // A phone that has never heard of `shop` edits the note.
  push(ctx, ctx.alice, [upsert({ ...tx, note: 'edited', extras: { method: 'Cash' } }, iso(1))]);
  assert.deepEqual(stored(ctx, tx.id).extras, { shop: 'CORNER SHOP', method: 'Cash' });
  const [r] = push(ctx, ctx.alice, [upsert({ ...tx, extras: { shop: null, mystery: 1, method: 'Voucher' } }, iso(2))]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.sort(), ['unknown_field:mystery', 'unknown_option:method']);
  // An unknown option is kept: losing what someone typed is worse than a warning.
  assert.deepEqual(stored(ctx, tx.id).extras, { method: 'Voucher' });
});

test('custom fields: types are enforced and required fields take their default', (ctx) => {
  const saveField = (f) => rpc(ctx.db, ctx.alice, 'fulla_field_upsert', { p_household_id: ctx.hh, p_field: f });
  saveField({ id: uuid(), key: 'people', type: 'number', labels: { en: 'People' }, applies_to: ['expense'] });
  saveField({ id: uuid(), key: 'tip', type: 'money', labels: { en: 'Tip' }, applies_to: ['expense'] });
  saveField({ id: uuid(), key: 'business', type: 'boolean', labels: { en: 'Business' }, applies_to: ['expense'], required: true, default_value: 'false' });
  saveField({ id: uuid(), key: 'when', type: 'date', labels: { en: 'When' }, applies_to: ['expense'] });
  saveField({ id: uuid(), key: 'for_whom', type: 'member', labels: { en: 'For' }, applies_to: ['expense'] });
  saveField({ id: uuid(), key: 'receipt', type: 'text', labels: { en: 'Receipt' }, applies_to: ['income'], required: true });
  const one = (extras) => push(ctx, ctx.alice, [upsert(expense(ctx, { extras }))])[0];
  const good = one({ people: 3.50, tip: '250', when: '2030-01-01', for_whom: ctx.aliceMember });
  assert.equal(good.ok, true, JSON.stringify(good.error));
  const row = stored(ctx, good.transaction_id);
  assert.deepEqual(row.extras, { people: '3.5', tip: 250, when: '2030-01-01', for_whom: ctx.aliceMember, business: false });
  assert.equal(one({ people: 'three' }).ok, false);
  assert.equal(one({ tip: 2.5 }).ok, false);
  assert.equal(one({ business: 'yes' }).ok, false);
  assert.equal(one({ when: '2030-13-01' }).ok, false);
  assert.equal(one({ for_whom: uuid() }).ok, false);
  // A required field of another kind does not apply to an expense, but it does to income.
  const [income] = push(ctx, ctx.alice, [upsert({ id: uuid(), kind: 'income', date: '2030-01-01', amount_minor: 1, category_id: ctx.cat('Salary') })]);
  assert.equal(income.ok, false);
});

test('an older edit does not overwrite a newer one, and the phone is told what it lost', (ctx) => {
  const tx = expense(ctx);
  push(ctx, ctx.alice, [upsert({ ...tx, note: 'newer' }, iso(10))]);
  const [r] = push(ctx, ctx.alice, [upsert({ ...tx, note: 'older' }, iso(5))]);
  assert.equal(r.ok, true);
  assert.equal(r.applied, false);
  assert.equal(r.conflict.winner, 'server');
  assert.deepEqual(r.conflict.overwritten, [{ field: 'note', before: 'older', after: 'newer' }]);
  assert.equal(stored(ctx, tx.id).note, 'newer');
  // The phone gets the winning row back, because it may never pull it again.
  assert.equal(r.server_transaction.id, tx.id);
  assert.equal(r.server_transaction.note, 'newer');
  assert.equal(r.server_transaction.client_updated_at, iso(10));
});

test('a newer edit wins, and says so when somebody else edited in between', (ctx) => {
  const tx = expense(ctx);
  push(ctx, ctx.alice, [upsert(tx, iso(0))]);
  push(ctx, ctx.alice, [upsert({ ...tx, note: 'from the other phone' }, iso(1))]);
  const [r] = push(ctx, ctx.alice, [upsert({ ...tx, amount_minor: 999 }, iso(2), iso(0))]);
  assert.equal(r.applied, true);
  assert.equal(r.conflict.winner, 'client');
  assert.deepEqual(r.conflict.overwritten.map((d) => d.field).sort(), ['amount_minor', 'note']);
  const [quiet] = push(ctx, ctx.alice, [upsert({ ...tx, amount_minor: 998 }, iso(3), iso(2))]);
  assert.equal(quiet.conflict, undefined);
});

test('a delete is applied whatever the clocks say', (ctx) => {
  const tx = expense(ctx);
  push(ctx, ctx.alice, [upsert(tx, iso(60))]);
  // The deleting phone's clock is an hour behind the phone that wrote the row.
  const [r] = push(ctx, ctx.alice, [del(tx, iso(0))]);
  assert.equal(r.applied, true);
  assert.equal(stored(ctx, tx.id).status, 'deleted');
  const [again] = push(ctx, ctx.alice, [del({ ...tx, note: 'my copy' }, iso(1))]);
  assert.deepEqual({ ok: again.ok, applied: again.applied, note: again.note }, { ok: true, applied: false, note: 'already_deleted' });
  // The phone gets the stored tombstone to adopt, not its own copy.
  assert.equal(again.server_transaction.status, 'deleted');
  assert.equal(again.server_transaction.note, tx.note);
  const [ghost] = push(ctx, ctx.alice, [del(expense(ctx))]);
  assert.equal(ghost.note, 'not_found');
});

test('a deletion is undone by a newer edit', (ctx) => {
  const tx = expense(ctx);
  push(ctx, ctx.alice, [upsert(tx, iso(0)), del(tx, iso(1))]);
  const [r] = push(ctx, ctx.alice, [upsert({ ...tx, status: 'active' }, iso(2))]);
  assert.equal(r.applied, true);
  assert.equal(stored(ctx, tx.id).status, 'active');
});

test('a push carries at most 100 mutations, and one bad mutation fails alone', (ctx) => {
  const many = Array.from({ length: 101 }, () => upsert(expense(ctx)));
  expectError(ctx.db, ctx.alice, 'fulla_sync_push', { p_household_id: ctx.hh, p_mutations: many }, 'validation_failed', 400);
  const good1 = expense(ctx);
  const good2 = expense(ctx);
  const results = push(ctx, ctx.alice, [upsert(good1), upsert(expense(ctx, { amount_minor: -5 })), { mutation_id: 'x', type: 'merge' }, upsert(good2)]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, false, true]);
  assert.ok(stored(ctx, good1.id) && stored(ctx, good2.id));
  assert.equal(results[2].mutation_id, 'x');
});

test('a recurring occurrence and an imported row exist once', (ctx) => {
  const rule = { id: uuid(), name: 'Streaming', start_date: '2030-01-01', schedule: { freq: 'monthly', by_month_day: 5 },
                 template: { kind: 'expense', amount_minor: 999, category_id: ctx.cat('Subscriptions'), paid_by_member_id: ctx.aliceMember } };
  rpc(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: rule });
  const occurrence = { recurring_rule_id: rule.id, occurrence_date: '2030-02-05', amount_minor: 999, category_id: ctx.cat('Subscriptions') };
  assert.equal(push(ctx, ctx.alice, [upsert(expense(ctx, occurrence))])[0].ok, true);
  const dup = push(ctx, ctx.alice, [upsert(expense(ctx, occurrence))])[0];
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'duplicate');
  const fp = { import_fingerprint: 'a'.repeat(64) };
  assert.equal(push(ctx, ctx.alice, [upsert(expense(ctx, fp))])[0].ok, true);
  assert.equal(push(ctx, ctx.alice, [upsert(expense(ctx, fp))])[0].error.code, 'duplicate');
  assert.equal(push(ctx, ctx.alice, [upsert(expense(ctx, { recurring_rule_id: rule.id }))])[0].ok, false);
});

test('every write moves server_seq forward', (ctx) => {
  const tx = expense(ctx);
  push(ctx, ctx.alice, [upsert(tx, iso(0))]);
  const first = Number(stored(ctx, tx.id).server_seq);
  push(ctx, ctx.alice, [upsert({ ...tx, note: 'b' }, iso(1))]);
  const second = Number(stored(ctx, tx.id).server_seq);
  push(ctx, ctx.alice, [del(tx, iso(2))]);
  const third = Number(stored(ctx, tx.id).server_seq);
  assert.ok(first < second && second < third);
});

// ═════════════════════════════════════════════════════════════════════════════
// Pull
// ═════════════════════════════════════════════════════════════════════════════

test('a pull pages in server order and hands back the highest server_seq it returned', (ctx) => {
  const txs = Array.from({ length: 7 }, (_, i) => expense(ctx, { note: `row ${i}` }));
  push(ctx, ctx.alice, txs.map((t) => upsert(t)));
  const seen = [];
  let cursor = 0;
  let pages = 0;
  for (;;) {
    const p = pull(ctx, ctx.alice, cursor, null, 3);
    pages += 1;
    seen.push(...p.transactions.map((t) => t.id));
    if (p.transactions.length) assert.equal(p.cursor, Math.max(...p.transactions.map((t) => Number(t.server_seq))));
    assert.ok(p.cursor >= cursor);
    cursor = p.cursor;
    if (!p.has_more) break;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, txs.map((t) => t.id));
  const empty = pull(ctx, ctx.alice, cursor);
  assert.deepEqual(empty.transactions, []);
  assert.equal(empty.cursor, cursor);
  assert.equal(empty.has_more, false);
  expectError(ctx.db, ctx.alice, 'fulla_sync_pull', { p_household_id: ctx.hh, p_limit: 0 }, 'validation_failed');
});

test('a row written offline hours ago is not stepped over', (ctx) => {
  const bob = join(ctx, 'Bob');
  push(ctx, bob.user, [upsert(expense(ctx, { paid_by_member_id: bob.member, members: [bob.member] }), iso(600))]);
  const bobCursor = pull(ctx, bob.user).cursor;
  // Alice was offline all morning: her edit carries a clock reading from hours ago.
  const late = expense(ctx);
  push(ctx, ctx.alice, [upsert(late, iso(-300))]);
  const next = pull(ctx, bob.user, bobCursor);
  assert.deepEqual(next.transactions.map((t) => t.id), [late.id]);
});

test('rows another member wrote are not lost when this phone pushes before pulling', (ctx) => {
  const bob = join(ctx, 'Bob');
  push(ctx, ctx.alice, [upsert(expense(ctx))]);
  const cursor = pull(ctx, ctx.alice).cursor;
  const bobs = expense(ctx, { paid_by_member_id: bob.member, members: [bob.member] });
  push(ctx, bob.user, [upsert(bobs)]);
  // Alice pushes again. The push answers with results only, so the cursor she
  // keeps is still the one her last pull gave her.
  const results = push(ctx, ctx.alice, [upsert(expense(ctx))]);
  assert.ok(results.every((r) => !('cursor' in r)));
  const next = pull(ctx, ctx.alice, cursor);
  assert.ok(next.transactions.some((t) => t.id === bobs.id));
});

// ═════════════════════════════════════════════════════════════════════════════
// Reports
// ═════════════════════════════════════════════════════════════════════════════

test('period totals count income and spending, not transfers, settlements or deleted rows', (ctx) => {
  const bob = join(ctx, 'Bob');
  const both = [ctx.aliceMember, bob.member];
  const deleted = expense(ctx, { members: both, amount_minor: 7777 });
  push(ctx, ctx.alice, [
    upsert({ id: uuid(), kind: 'income', date: '2030-01-10', amount_minor: 200000, category_id: ctx.cat('Salary'), recurrence: 'fixed' }),
    upsert(expense(ctx, { members: both, amount_minor: 50000 })),
    upsert({ id: uuid(), kind: 'refund', date: '2030-01-20', amount_minor: 1000, category_id: ctx.cat('Groceries'), paid_by_member_id: ctx.aliceMember, split: { mode: 'equal', members: both } }),
    upsert({ id: uuid(), kind: 'transfer', date: '2030-01-11', amount_minor: 10000, account_id: ctx.account('Main account'), to_account_id: ctx.account('Cash') }),
    upsert({ id: uuid(), kind: 'settlement', date: '2030-01-12', amount_minor: 3000, paid_by_member_id: bob.member, to_member_id: ctx.aliceMember }),
    upsert(deleted, iso(0)),
    del(deleted, iso(1)),
  ]);
  const summary = rpc(ctx.db, ctx.alice, 'fulla_period_summary', { p_household_id: ctx.hh, p_from: '2030-01', p_to: '2030-12' });
  assert.deepEqual(summary, [{ period: '2030-01', income_minor: 200000, expense_minor: 49000, savings_minor: 151000 }]);
});

test('period totals follow the household period rules', (ctx) => {
  push(ctx, ctx.alice, [
    upsert({ id: uuid(), kind: 'income', date: '2030-01-28', amount_minor: 100000, category_id: ctx.cat('Salary'), recurrence: 'fixed' }),
    upsert(expense(ctx, { date: '2030-01-28', amount_minor: 2000 })),
  ]);
  const summary = () => rpc(ctx.db, ctx.alice, 'fulla_period_summary', { p_household_id: ctx.hh, p_from: '2030-01', p_to: '2030-12' });
  assert.deepEqual(summary().map((s) => s.period), ['2030-01']);
  rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { income_shift_day: 25 } });
  assert.deepEqual(summary().map((s) => [s.period, s.income_minor, s.expense_minor]), [['2030-01', 0, 2000], ['2030-02', 100000, 0]]);
  rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { income_shift_day: null, period_start_day: 20 } });
  assert.deepEqual(summary().map((s) => [s.period, s.income_minor, s.expense_minor]), [['2030-02', 100000, 2000]]);
});

test('periods follow the incomes marked as starting the month', (ctx) => {
  const MARK = 'fulla:starts-period';
  const income = (date, over = {}) => Object.assign({ id: uuid(), kind: 'income', date, amount_minor: 100000,
    category_id: ctx.cat('Salary'), recurrence: 'fixed', tags: [] }, over);
  const salary = (date, over = {}) => income(date, Object.assign({ tags: [MARK] }, over));
  rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { period_start_day: 28 } });
  push(ctx, ctx.alice, [upsert(income('2030-08-28')), upsert(expense(ctx, { date: '2030-09-29', amount_minor: 2000 }))]);
  const summary = () => rpc(ctx.db, ctx.alice, 'fulla_period_summary', { p_household_id: ctx.hh, p_from: '2030-01', p_to: '2030-12' })
    .map((s) => [s.period, s.income_minor, s.expense_minor]);
  assert.deepEqual(summary(), [['2030-09', 100000, 0], ['2030-10', 0, 2000]], 'the fixed day until an income is marked');

  push(ctx, ctx.alice, [upsert(salary('2030-08-28'))]);
  assert.deepEqual(summary(), [['2030-09', 200000, 2000]], 'no salary since: September stays open');

  // Another income in the same category, not marked, moves nothing.
  push(ctx, ctx.alice, [upsert(income('2030-09-26', { amount_minor: 5000 }))]);
  assert.deepEqual(summary(), [['2030-09', 205000, 2000]]);

  // Written down later, dated the same day as the purchase: the purchase moves.
  push(ctx, ctx.alice, [upsert(salary('2030-09-29'))]);
  assert.deepEqual(summary(), [['2030-09', 205000, 0], ['2030-10', 100000, 2000]]);

  // A generated occurrence counts only once saved.
  const rule = { id: uuid(), name: 'Pay', start_date: '2030-01-01', schedule: { freq: 'monthly', by_month_day: 28 },
                 template: { kind: 'income', amount_minor: 100000, category_id: ctx.cat('Salary'), recurrence: 'fixed', tags: [MARK] } };
  rpc(ctx.db, ctx.alice, 'fulla_recurring_upsert', { p_household_id: ctx.hh, p_rule: rule });
  const stamp = '2030-10-28T06:00:00.000Z';
  const generated = salary('2030-10-28', { recurring_rule_id: rule.id, occurrence_date: '2030-10-28', created_at: stamp });
  push(ctx, ctx.alice, [upsert(generated, stamp), upsert(expense(ctx, { date: '2030-10-29', amount_minor: 500 }))]);
  assert.deepEqual(summary(), [['2030-09', 205000, 0], ['2030-10', 200000, 2500]]);
  push(ctx, ctx.alice, [upsert(generated, '2030-10-28T09:00:00.000Z', stamp)]);
  assert.deepEqual(summary(), [['2030-09', 205000, 0], ['2030-10', 100000, 2000], ['2030-11', 100000, 500]]);
});

test('a field can be limited to categories, and editing it keeps the limit', (ctx) => {
  const pets = uuid();
  const vet = uuid();
  rpc(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: { id: pets, name: 'Pets' } });
  rpc(ctx.db, ctx.alice, 'fulla_category_upsert', { p_household_id: ctx.hh, p_category: { id: vet, name: 'Vet', parent_id: pets } });
  const field = { id: uuid(), key: 'for_whom', type: 'select', labels: { en: 'For whom' }, applies_to: ['expense'], options: ['Rex', 'Tom', 'All'] };
  const before = rpc(ctx.db, ctx.alice, 'fulla_field_upsert', { p_household_id: ctx.hh, p_field: field });
  assert.equal(before.custom_fields.find((f) => f.id === field.id).category_ids, null, 'every category by default');
  const limited = rpc(ctx.db, ctx.alice, 'fulla_field_set_categories', { p_household_id: ctx.hh, p_field_id: field.id, p_category_ids: [vet] });
  assert.ok(limited.config_version > before.config_version, 'other phones hear of it');
  assert.deepEqual(limited.custom_fields.find((f) => f.id === field.id).category_ids, [vet]);
  const edited = rpc(ctx.db, ctx.alice, 'fulla_field_upsert', { p_household_id: ctx.hh, p_field: Object.assign({}, field, { options: ['Rex', 'Tom', 'Kit', 'All'] }) });
  assert.deepEqual(edited.custom_fields.find((f) => f.id === field.id).category_ids, [vet], 'an edit keeps the limit');
  const lifted = rpc(ctx.db, ctx.alice, 'fulla_field_set_categories', { p_household_id: ctx.hh, p_field_id: field.id, p_category_ids: [] });
  assert.equal(lifted.custom_fields.find((f) => f.id === field.id).category_ids, null);
  expectError(ctx.db, ctx.alice, 'fulla_field_set_categories', { p_household_id: ctx.hh, p_field_id: field.id, p_category_ids: [uuid()] }, 'validation_failed', 400);
  expectError(ctx.db, ctx.alice, 'fulla_field_set_categories', { p_household_id: ctx.hh, p_field_id: uuid(), p_category_ids: [vet] }, 'validation_failed', 400);
  // A value in the field is stored like any other.
  const tx = expense(ctx, { category_id: vet, extras: { for_whom: 'Rex' } });
  assert.equal(push(ctx, ctx.alice, [upsert(tx)])[0].ok, true);
  assert.deepEqual(pull(ctx, ctx.alice).transactions.find((r) => r.id === tx.id).extras, { for_whom: 'Rex' });
});

rawTest('a new household gets its defaults in its language, English for any other', ({ db }) => {
  const names = {};
  for (const locale of ['fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'nl-NL']) {
    const u = newUser(db, `${locale}@example.com`);
    const r = rpc(db, u, 'fulla_household_create', {
      p_name: 'Demo household', p_currency: 'EUR', p_locale: locale, p_display_name: 'Alice', p_initials: 'A', p_color_index: 0,
    });
    names[locale] = r.config.categories.find((c) => c.icon === 'shopping_cart').name;
  }
  assert.deepEqual(names, { 'fr-FR': 'Courses', 'de-DE': 'Lebensmittel', 'it-IT': 'Spesa', 'pt-BR': 'Supermercado', 'nl-NL': 'Groceries' });
});

// ═════════════════════════════════════════════════════════════════════════════
// Deleting an account
// ═════════════════════════════════════════════════════════════════════════════

function count(ctx, sql) { return Number(ctx.db.admin(sql).out); }

test('deleting the only account in a household erases the household, every row of it', (ctx) => {
  const kid = virtual(ctx, 'Carol');
  push(ctx, ctx.alice, [upsert(expense(ctx, { members: [ctx.aliceMember, kid] }))]);
  rpc(ctx.db, ctx.alice, 'fulla_budget_upsert', { p_household_id: ctx.hh, p_budget: { id: uuid(), category_id: ctx.cat('Groceries'), amount_minor: 30000 } });
  const r = rpc(ctx.db, ctx.alice, 'fulla_account_delete', {});
  assert.equal(r.households_erased, 1);
  for (const t of ['households', 'members', 'transactions', 'categories', 'accounts', 'budgets']) {
    const where = t === 'households' ? `id = '${ctx.hh}'` : `household_id = '${ctx.hh}'`;
    assert.equal(count(ctx, `select count(*) from fulla.${t} where ${where};`), 0, `${t} not erased`);
  }
  assert.equal(count(ctx, `select count(*) from auth.users where id = '${ctx.alice}';`), 0);
});

test('deleting an account in a shared household leaves the others their history', (ctx) => {
  const bob = join(ctx, 'Bob');
  const tx = expense(ctx, { paid_by_member_id: bob.member, members: [ctx.aliceMember, bob.member] });
  push(ctx, bob.user, [upsert(tx)]);
  const r = rpc(ctx.db, bob.user, 'fulla_account_delete', {});
  assert.equal(r.households_left, 1);
  assert.equal(stored(ctx, tx.id).amount_minor, 1234);
  const member = rpc(ctx.db, ctx.alice, 'fulla_config_get', { p_household_id: ctx.hh }).members.find((m) => m.id === bob.member);
  assert.equal(member.status, 'removed');
  assert.equal(member.has_account, false);
  assert.equal(count(ctx, `select count(*) from auth.users where id = '${bob.user}';`), 0);
  assert.equal(pull(ctx, ctx.alice).transactions.length, 1);
});

test('the owner of a household others use must hand it over before deleting the account', (ctx) => {
  const bob = join(ctx, 'Bob');
  expectError(ctx.db, ctx.alice, 'fulla_account_delete', {}, 'owner_must_hand_over', 409);
  assert.equal(count(ctx, `select count(*) from auth.users where id = '${ctx.alice}';`), 1);
  rpc(ctx.db, ctx.alice, 'fulla_owner_transfer', { p_household_id: ctx.hh, p_member_id: bob.member });
  rpc(ctx.db, ctx.alice, 'fulla_account_delete', {});
  assert.equal(count(ctx, `select count(*) from fulla.households where id = '${ctx.hh}';`), 1);
});

test('erasing one household never unlocks deleting rows of another', (ctx) => {
  const other = newUser(ctx.db, 'dave@example.com');
  rpc(ctx.db, other, 'fulla_household_create', {
    p_name: 'Other household', p_currency: 'EUR', p_locale: 'en-GB', p_display_name: 'Dave', p_initials: 'D', p_color_index: 0,
  });
  push(ctx, ctx.alice, [upsert(expense(ctx))]);
  rpc(ctx.db, other, 'fulla_account_delete', {});
  const r = ctx.db.admin(`delete from fulla.transactions where household_id = '${ctx.hh}';`, { expectFailure: true });
  assert.ok(!r.ok);
  assert.equal(r.err.detail, 'delete_forbidden');
});

// ═════════════════════════════════════════════════════════════════════════════
// Shared rules: the same vectors the Kotlin tests read
// ═════════════════════════════════════════════════════════════════════════════

rawTest('period_of agrees with testdata/vectors/period.json', ({ db }) => {
  for (const v of vectors('period.json')) {
    const i = v.input;
    const got = db.admin(`select fulla.period_of(${h.literal(i.date)}::date, ${h.literal(i.kind)}, ${h.literal(i.recurrence)},
      ${i.period_start_day}, ${i.income_shift_day === null ? 'null' : i.income_shift_day});`).out;
    assert.equal(got, v.expected, v.why);
  }
});

rawTest('anchored_period_of agrees with testdata/vectors/period_anchors.json', ({ db }) => {
  for (const v of vectors('period_anchors.json')) {
    const i = v.input;
    const anchors = `array[${i.anchors.map((d) => `${h.literal(d)}::date`).join(',')}]::date[]`;
    const got = db.admin(`select fulla.anchored_period_of(${h.literal(i.date)}::date, ${h.literal(i.kind)}, ${h.literal(i.recurrence)},
      ${i.period_start_day}, ${i.income_shift_day === null ? 'null' : i.income_shift_day}, ${anchors});`).out;
    assert.equal(got, v.expected, v.why);
  }
});

rawTest('split_shares agrees with testdata/vectors/allocate.json', ({ db }) => {
  for (const v of vectors('allocate.json')) {
    const got = JSON.parse(db.admin(`select fulla.split_shares(${v.input.amount_minor}, ${h.literal(JSON.stringify(v.input.split))}::jsonb)::text;`).out);
    assert.deepEqual(got, v.expected, v.why);
    const total = Object.values(got).reduce((a, b) => a + b, 0);
    assert.equal(total, v.input.amount_minor, `${v.why}: parts must add up`);
  }
});

rawTest('normalize_name agrees with testdata/vectors/normalize_name.json', ({ db }) => {
  for (const v of vectors('normalize_name.json')) {
    assert.equal(db.admin(`select fulla.normalize_name(${h.literal(v.input)});`).out, v.expected, v.input);
  }
});

// The totals per period the phone computes (core's Analytics.summary) and this view give, for the same rows and the same rules.
for (const v of vectors('period_summary.json')) {
  test(`period_summary agrees with period_summary.json: ${v.why}`, (ctx) => {
    const MAIN = ctx.account('Main account');
    const bob = virtual(ctx, 'Bob');
    rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh,
      p_patch: { period_start_day: v.input.period_start_day, income_shift_day: v.input.income_shift_day } });
    const mutations = [];
    for (const t of v.input.transactions) {
      const tx = { id: uuid(), kind: t.kind, date: t.date, amount_minor: t.amount_minor, recurrence: t.recurrence || 'variable', tags: t.tags || [] };
      if (['expense', 'refund'].includes(t.kind)) Object.assign(tx, { category_id: ctx.cat('Groceries'), paid_by_member_id: ctx.aliceMember, split: { mode: 'equal', members: [ctx.aliceMember] } });
      if (t.kind === 'income') Object.assign(tx, { category_id: ctx.cat('Salary'), paid_by_member_id: ctx.aliceMember });
      if (t.kind === 'settlement') Object.assign(tx, { paid_by_member_id: bob, to_member_id: ctx.aliceMember });
      if (t.kind === 'transfer') Object.assign(tx, { account_id: MAIN, to_account_id: ctx.account('Cash') });
      mutations.push(upsert(tx, iso(0)));
      if (t.status === 'deleted') mutations.push(del(tx, iso(1)));
    }
    const results = push(ctx, ctx.alice, mutations);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    const got = rpc(ctx.db, ctx.alice, 'fulla_period_summary', { p_household_id: ctx.hh, p_from: '2000-01', p_to: '2099-12' });
    assert.deepEqual(got, v.expected);
  });
}

for (const v of vectors('balance.json')) {
  test(`member_balances agrees with balance.json: ${v.why}`, (ctx) => {
    for (const id of v.input.members) virtual(ctx, `M${id.slice(-2)}`, id);
    const txs = v.input.transactions.map((t) => {
      const tx = { id: uuid(), kind: t.kind, date: '2030-01-15', amount_minor: t.amount_minor };
      if (['expense', 'refund'].includes(t.kind)) Object.assign(tx, { category_id: ctx.cat('Groceries'), paid_by_member_id: t.paid_by, split: t.split });
      if (t.kind === 'income') Object.assign(tx, { category_id: ctx.cat('Salary'), paid_by_member_id: t.paid_by });
      if (t.kind === 'settlement') Object.assign(tx, { paid_by_member_id: t.paid_by, to_member_id: t.to_member });
      if (t.kind === 'transfer') Object.assign(tx, { account_id: ctx.account('Main account'), to_account_id: ctx.account('Cash') });
      return upsert(tx);
    });
    const results = push(ctx, ctx.alice, txs);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    const balances = rpc(ctx.db, ctx.alice, 'fulla_member_balances', { p_household_id: ctx.hh });
    const byId = Object.fromEntries(balances.map((b) => [b.member_id, b]));
    for (const [id, want] of Object.entries(v.expected)) {
      assert.deepEqual({ paid: byId[id].paid_minor, share: byId[id].share_minor, balance: byId[id].balance_minor }, want, id);
    }
    assert.equal(balances.reduce((s, b) => s + b.balance_minor, 0), 0, 'balances add up to zero');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared pot
// ═════════════════════════════════════════════════════════════════════════════

function setMoneyMode(ctx, mode, user = ctx.alice) {
  return rpc(ctx.db, user, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { money_mode: mode } });
}

test('money_mode: not chosen at first, carried by the bundle, changed by admins only', (ctx) => {
  const bob = join(ctx, 'Bob');
  const before = ctx.config();
  assert.equal(before.household.money_mode, null);
  const cfg = setMoneyMode(ctx, 'shared');
  assert.equal(cfg.household.money_mode, 'shared');
  assert.ok(cfg.config_version > before.config_version, 'every phone hears about it');
  expectError(ctx.db, bob.user, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { money_mode: 'split' } }, 'forbidden_role', 403);
  expectError(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { money_mode: 'halves' } }, 'validation_failed');
  // A phone that has never heard of money_mode sends patches without it; they keep it.
  const renamed = rpc(ctx.db, ctx.alice, 'fulla_household_update', { p_household_id: ctx.hh, p_patch: { name: 'Our place' } });
  assert.equal(renamed.household.money_mode, 'shared');
  assert.equal(setMoneyMode(ctx, 'split').household.money_mode, 'split');
  assert.equal(pull(ctx, bob.user, 0, null).config.household.money_mode, 'split');
});

rawTest('a household that lived on one phone keeps its history when it becomes shared, whatever pot it chose', ({ db }) => {
  const alice = newUser(db, 'alice@example.com');
  const { ids, payload } = localPayload();
  // The upload leaves money_mode out; one that sends it anyway is not listened to.
  payload.household.money_mode = 'shared';
  const r = rpc(db, alice, 'fulla_household_create_from_local', { p_payload: payload });
  assert.equal(r.config.household.money_mode, null);
  // What the phone wrote while splitting, then its settling up when it chose the pot.
  const both = { mode: 'equal', members: [ids.me, ids.kid] };
  const food = { id: uuid(), kind: 'expense', date: '2030-01-10', amount_minor: 10000, category_id: ids.food,
                 paid_by_member_id: ids.me, split: both };
  const settle = { id: uuid(), kind: 'settlement', date: '2030-01-12', amount_minor: 5000,
                   paid_by_member_id: ids.kid, to_member_id: ids.me, note: 'Shared pot started' };
  const res = rpc(db, alice, 'fulla_sync_push', { p_household_id: ids.household, p_mutations: [upsert(food), upsert(settle)] }).results;
  assert.deepEqual(res.map((x) => [x.ok, x.applied, x.server_transaction]), [[true, true, undefined], [true, true, undefined]]);
  // Only once its history is in does the phone choose the pot on the server.
  const cfg = rpc(db, alice, 'fulla_household_update', { p_household_id: ids.household, p_patch: { money_mode: 'shared' } });
  assert.equal(cfg.household.money_mode, 'shared');
  const storedFood = JSON.parse(db.admin(`select split::text from fulla.transactions where id = ${h.literal(food.id)};`).out);
  assert.deepEqual(storedFood, both, 'the history keeps its split');
  const balances = rpc(db, alice, 'fulla_member_balances', { p_household_id: ids.household });
  assert.deepEqual(balances.map((b) => b.balance_minor), [0, 0], 'settled before the pot, nothing owed after');
});

test('in a shared pot a new expense is stored as its payer\'s alone, and the phone is handed that version', (ctx) => {
  const bob = join(ctx, 'Bob');
  setMoneyMode(ctx, 'shared');
  const tx = expense(ctx, { members: [ctx.aliceMember, bob.member] });
  const [r] = push(ctx, bob.user, [upsert(tx)]);
  assert.equal(r.applied, true);
  const payerOnly = { mode: 'equal', members: [ctx.aliceMember] };
  assert.deepEqual(r.server_transaction.split, payerOnly);
  assert.equal(r.server_transaction.client_updated_at, iso());
  const row = stored(ctx, tx.id);
  assert.deepEqual(row.split, payerOnly);
  assert.equal(row.paid_by_member_id, ctx.aliceMember, 'who paid stays, as information');
  // A row already in that shape needs no second version.
  const [own] = push(ctx, bob.user, [upsert(expense(ctx, { paid_by_member_id: bob.member, members: [bob.member] }))]);
  assert.equal(own.applied, true);
  assert.equal(own.server_transaction, undefined);
  const balances = rpc(ctx.db, ctx.alice, 'fulla_member_balances', { p_household_id: ctx.hh });
  assert.deepEqual(balances.map((b) => b.balance_minor), balances.map(() => 0), 'nobody owes anybody');
});

test('an edit of a row written before the shared pot keeps its split', (ctx) => {
  const bob = join(ctx, 'Bob');
  const both = { mode: 'equal', members: [ctx.aliceMember, bob.member] };
  const tx = expense(ctx, { members: [ctx.aliceMember, bob.member] });
  push(ctx, ctx.alice, [upsert(tx, iso(0))]);
  setMoneyMode(ctx, 'shared');
  // Bob edits the row his phone holds: the edit names the version it started from.
  const [r] = push(ctx, bob.user, [upsert(Object.assign({}, tx, { note: 'GROCERY STORE 02' }), iso(5), iso(0))]);
  assert.equal(r.applied, true);
  assert.equal(r.server_transaction, undefined);
  assert.deepEqual(stored(ctx, tx.id).split, both);
  const balances = Object.fromEntries(rpc(ctx.db, ctx.alice, 'fulla_member_balances', { p_household_id: ctx.hh })
    .map((b) => [b.member_id, b.balance_minor]));
  assert.equal(balances[ctx.aliceMember], 617, 'what was owed before stays owed');
  assert.equal(balances[bob.member], -617);
});

test('in a shared pot a row two phones both wrote as new is its payer\'s alone, whichever lands last', (ctx) => {
  const bob = join(ctx, 'Bob');
  setMoneyMode(ctx, 'shared');
  // The same id from two phones, as a recurring occurrence or an imported line has.
  const tx = expense(ctx, { members: [ctx.aliceMember, bob.member] });
  assert.equal(push(ctx, ctx.alice, [upsert(tx, iso(0))])[0].applied, true);
  // Bob's phone had not heard of the pot and never saw Alice's row: no base.
  const [r] = push(ctx, bob.user, [upsert(Object.assign({}, tx), iso(5))]);
  assert.equal(r.applied, true);
  const payerOnly = { mode: 'equal', members: [ctx.aliceMember] };
  assert.deepEqual(stored(ctx, tx.id).split, payerOnly);
  assert.deepEqual(r.server_transaction.split, payerOnly);
  // An edit made after seeing the stored row is an edit, and keeps what it says.
  const both = { mode: 'equal', members: [ctx.aliceMember, bob.member] };
  const [e] = push(ctx, bob.user, [upsert(Object.assign({}, tx, { split: both }), iso(10), iso(5))]);
  assert.equal(e.applied, true);
  assert.deepEqual(stored(ctx, tx.id).split, both);
});

test('in a shared pot a new settlement is refused, an old one can still be edited', (ctx) => {
  const bob = join(ctx, 'Bob');
  const old = { id: uuid(), kind: 'settlement', date: '2030-01-15', amount_minor: 500,
                paid_by_member_id: bob.member, to_member_id: ctx.aliceMember };
  push(ctx, ctx.alice, [upsert(old, iso(0))]);
  setMoneyMode(ctx, 'shared');
  const fresh = Object.assign({}, old, { id: uuid() });
  const [r] = push(ctx, bob.user, [upsert(fresh, iso(1))]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'validation_failed');
  assert.match(r.error.message, /nothing to settle/);
  assert.equal(stored(ctx, fresh.id), null);
  const [edit] = push(ctx, ctx.alice, [upsert(Object.assign({}, old, { note: 'CASH' }), iso(2))]);
  assert.equal(edit.applied, true);
  // Back to splitting, settling works again.
  setMoneyMode(ctx, 'split');
  const [again] = push(ctx, bob.user, [upsert(fresh, iso(3))]);
  assert.equal(again.applied, true);
});

for (const v of vectors('shared_pot.json')) {
  test(`fulla_sync_push agrees with shared_pot.json: ${v.why}`, (ctx) => {
    const i = v.input;
    const members = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    for (const id of members) virtual(ctx, `M${id.slice(-2)}`, id);
    const tx = { id: uuid(), kind: i.kind, date: '2030-01-15', amount_minor: 1000 };
    if (['expense', 'refund'].includes(i.kind)) Object.assign(tx, { category_id: ctx.cat('Groceries'), paid_by_member_id: i.paid_by, split: i.split });
    if (i.kind === 'income') Object.assign(tx, { category_id: ctx.cat('Salary'), paid_by_member_id: i.paid_by });
    if (i.kind === 'settlement') Object.assign(tx, { paid_by_member_id: i.paid_by, to_member_id: i.to_member });
    if (i.kind === 'transfer') Object.assign(tx, { account_id: ctx.account('Main account'), to_account_id: ctx.account('Cash') });
    let r;
    if (i.is_new) {
      if (i.money_mode !== null) setMoneyMode(ctx, i.money_mode);
      [r] = push(ctx, ctx.alice, [upsert(tx, iso(0))]);
    } else {
      // Written while the household split, edited under the mode being tested.
      setMoneyMode(ctx, 'split');
      assert.equal(push(ctx, ctx.alice, [upsert(tx, iso(0))])[0].applied, true);
      setMoneyMode(ctx, i.money_mode);
      [r] = push(ctx, ctx.alice, [upsert(Object.assign({}, tx, { note: 'edited' }), iso(5), iso(0))]);
    }
    if (v.expected === 'refused') {
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(stored(ctx, tx.id), null);
    } else {
      assert.equal(r.applied, true, JSON.stringify(r));
      assert.deepEqual(stored(ctx, tx.id).split, v.expected.split);
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Trips
// ═════════════════════════════════════════════════════════════════════════════

/** Porto: 2030-08-12 to 2030-08-19, invented, like every household in this file. */
function trip(over = {}) {
  return Object.assign({ id: uuid(), name: 'Porto', start_date: '2030-08-12', end_date: '2030-08-19', budget_minor: 30000 }, over);
}

test('a member creates a trip; the stranger and anon security tests already cover it', (ctx) => {
  const bob = join(ctx, 'Bob');
  const before = ctx.config();
  const t = trip();
  const cfg = rpc(ctx.db, bob.user, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  assert.ok(cfg.config_version > before.config_version);
  assert.deepEqual(cfg.trips.map((x) => x.name), ['Porto']);
  assert.equal(cfg.trips[0].in_category_budgets, false);
  assert.equal(cfg.trips[0].archived, false);
});

test('a brand new trip defaults member_ids to the creator alone', (ctx) => {
  const bob = join(ctx, 'Bob');
  const cfg = rpc(ctx.db, bob.user, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip() });
  assert.deepEqual(cfg.trips[0].member_ids, [bob.member]);
});

test('member_ids rejects an id that is not a member of this household (M1)', (ctx) => {
  const carol = newUser(ctx.db, 'carol@example.com');
  const other = rpc(ctx.db, carol, 'fulla_household_create', {
    p_name: 'Other household', p_currency: 'EUR', p_locale: 'en-GB', p_display_name: 'Carol', p_initials: 'C', p_color_index: 2,
  });
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert',
    { p_household_id: ctx.hh, p_trip: trip({ member_ids: [other.member_id] }) }, 'validation_failed');
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert',
    { p_household_id: ctx.hh, p_trip: trip({ member_ids: ['not-a-uuid'] }) }, 'validation_failed');
});

test('an absent member_ids on upsert keeps the stored value; an explicit array replaces it', (ctx) => {
  const bob = join(ctx, 'Bob');
  const t = trip({ member_ids: [ctx.aliceMember, bob.member] });
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });

  // An old app version's upsert never learned member_ids: the key is absent
  // entirely, not an explicit empty array, and must not wipe who is on the trip.
  const stale = Object.assign({}, t, { name: 'Porto (renamed)' });
  delete stale.member_ids;
  const kept = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: stale });
  assert.deepEqual(kept.trips[0].member_ids.slice().sort(), [ctx.aliceMember, bob.member].sort());
  assert.equal(kept.trips[0].name, 'Porto (renamed)');

  // An explicit array, even one member, replaces it.
  const narrowed = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert',
    { p_household_id: ctx.hh, p_trip: Object.assign({}, t, { member_ids: [bob.member] }) });
  assert.deepEqual(narrowed.trips[0].member_ids, [bob.member]);

  // An explicit empty array clears it (nobody, not "keep the old value").
  const cleared = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert',
    { p_household_id: ctx.hh, p_trip: Object.assign({}, t, { member_ids: [] }) });
  assert.deepEqual(cleared.trips[0].member_ids, []);
});

test('a trip id already used by another household is refused', (ctx) => {
  const carol = newUser(ctx.db, 'carol@example.com');
  const other = rpc(ctx.db, carol, 'fulla_household_create', {
    p_name: 'Other household', p_currency: 'EUR', p_locale: 'en-GB', p_display_name: 'Carol', p_initials: 'C', p_color_index: 2,
  }).household_id;
  const t = trip();
  rpc(ctx.db, carol, 'fulla_trip_upsert', { p_household_id: other, p_trip: t });
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t }, 'already_exists', 409);
});

test('a trip needs a name, real dates within a year, and a positive budget or none', (ctx) => {
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ name: '' }) }, 'validation_failed');
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ end_date: '2030-08-11' }) }, 'validation_failed');
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ end_date: '2032-08-11' }) }, 'validation_failed');
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ budget_minor: 0 }) }, 'validation_failed');
  const noBudget = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ budget_minor: null }) });
  assert.equal(noBudget.trips[0].budget_minor, null);
});

test('overlapping trips are allowed', (ctx) => {
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip() });
  const cfg = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ name: 'Long weekend', start_date: '2030-08-14', end_date: '2030-08-16' }) });
  assert.equal(cfg.trips.length, 2);
});

test('an absent trip_id keeps the trip, an explicit null clears it, an old-shape kind change drops it silently', (ctx) => {
  const t = trip();
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  const tx = expense(ctx, { trip_id: t.id });
  push(ctx, ctx.alice, [upsert(tx, iso(0))]);
  assert.equal(stored(ctx, tx.id).trip_id, t.id);

  // An old-shape push (no trip_id key at all) keeps the stored trip.
  const stale = Object.assign({}, tx, { note: 'edited by an old phone' });
  delete stale.trip_id;
  const [r] = push(ctx, ctx.alice, [upsert(stale, iso(1), iso(0))]);
  assert.equal(r.applied, true);
  assert.equal(stored(ctx, tx.id).trip_id, t.id, 'an absent trip_id must not clear a trip');

  // An explicit null does clear it.
  const [cleared] = push(ctx, ctx.alice, [upsert(Object.assign({}, stale, { trip_id: null }), iso(2), iso(1))]);
  assert.equal(cleared.applied, true);
  assert.equal(stored(ctx, tx.id).trip_id, null);

  // A settlement can never carry a trip.
  const settle = { id: uuid(), kind: 'settlement', date: '2030-01-15', amount_minor: 500,
                   paid_by_member_id: ctx.aliceMember, to_member_id: join(ctx, 'Carol').member, trip_id: t.id };
  const [refused] = push(ctx, ctx.alice, [upsert(settle, iso(3))]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'validation_failed');

  // An old phone that changes a tripped row's kind away from expense/refund
  // (no trip_id key at all) is not rejected; the trip is silently dropped.
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  const tripped = expense(ctx, { trip_id: t.id });
  push(ctx, ctx.alice, [upsert(tripped, iso(4))]);
  const kindChanged = Object.assign({}, tripped, { kind: 'transfer', category_id: undefined, split: undefined, paid_by_member_id: undefined,
    account_id: ctx.account('Main account'), to_account_id: ctx.account('Cash') });
  delete kindChanged.trip_id;
  delete kindChanged.category_id;
  const [ok] = push(ctx, ctx.alice, [upsert(kindChanged, iso(5), iso(4))]);
  assert.equal(ok.applied, true, JSON.stringify(ok));
  assert.equal(stored(ctx, tripped.id).trip_id, null);
});

test('conflict notes report the real trip change, not a false one either way (M1)', (ctx) => {
  const t = trip();
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });

  // Server wins, the phone kept the row's own trip: no false "trip removed".
  const kept = expense(ctx, { trip_id: t.id });
  push(ctx, ctx.alice, [upsert(kept, iso(10))]);
  const [serverWinsSameTrip] = push(ctx, ctx.alice, [upsert({ ...kept, note: 'older', trip_id: t.id }, iso(5))]);
  assert.equal(serverWinsSameTrip.conflict.winner, 'server');
  assert.equal(serverWinsSameTrip.conflict.overwritten.some((d) => d.field === 'trip_id'), false,
    'the trip did not change, so it must not be reported as changed');

  // Server wins, the phone sent a different trip than what's stored: a real change, reported.
  const other = trip({ name: 'Lisbon' });
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: other });
  const [serverWinsOtherTrip] = push(ctx, ctx.alice, [upsert({ ...kept, note: 'older still', trip_id: other.id }, iso(6))]);
  const tripChange = serverWinsOtherTrip.conflict.overwritten.find((d) => d.field === 'trip_id');
  assert.ok(tripChange, 'a real trip change must be reported');
  assert.equal(tripChange.before, other.id);
  assert.equal(tripChange.after, t.id);

  // Client wins, and it read the row before either of the pushes above
  // (base_client_updated_at is stale), so the note fires: the trip it
  // actually keeps is what gets reported.
  const [clientWins] = push(ctx, ctx.alice, [upsert({ ...kept, amount_minor: 999, trip_id: other.id }, iso(20), iso(1))]);
  assert.equal(clientWins.conflict.winner, 'client');
  const clientTripChange = clientWins.conflict.overwritten.find((d) => d.field === 'trip_id');
  assert.ok(clientTripChange, 'the client did change the trip, so it must be reported');
  assert.equal(clientTripChange.before, t.id);
  assert.equal(clientTripChange.after, other.id);
});

test('a uuid trip on a settlement is refused, a nonexistent trip is refused', (ctx) => {
  const settle = { id: uuid(), kind: 'settlement', date: '2030-01-15', amount_minor: 500,
                   paid_by_member_id: ctx.aliceMember, to_member_id: join(ctx, 'Bob').member, trip_id: uuid() };
  const [refused] = push(ctx, ctx.alice, [upsert(settle)]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'validation_failed');
  const badTrip = expense(ctx, { trip_id: uuid() });
  const [r] = push(ctx, ctx.alice, [upsert(badTrip)]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'validation_failed');
});

test('erasing a household removes its trips too', (ctx) => {
  const t = trip();
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  ctx.db.admin(`select fulla.erase_household(${h.literal(ctx.hh)});`);
  assert.equal(ctx.db.admin(`select count(*) from fulla.trips where household_id = ${h.literal(ctx.hh)};`).out, '0');
});

rawTest('fulla_household_create_from_local saves trips before the rows are pushed', ({ db }) => {
  const alice = newUser(db, 'alice@example.com');
  const { ids, payload } = localPayload();
  const tripId = uuid();
  payload.trips = [{ id: tripId, name: 'Porto', start_date: '2030-08-12', end_date: '2030-08-19', budget_minor: 30000 }];
  const r = rpc(db, alice, 'fulla_household_create_from_local', { p_payload: payload });
  assert.deepEqual(r.config.trips.map((t) => t.id), [tripId]);
  const tx = { id: uuid(), kind: 'expense', date: '2030-08-13', amount_minor: 4500, category_id: ids.food,
               paid_by_member_id: ids.me, split: { mode: 'equal', members: [ids.me, ids.kid] }, trip_id: tripId };
  const [res] = rpc(db, alice, 'fulla_sync_push', { p_household_id: ids.household, p_mutations: [upsert(tx)] }).results;
  assert.equal(res.applied, true, JSON.stringify(res));
});

test('the bundle carries trips ordered by start date, and config_version moves when one is saved', (ctx) => {
  const before = ctx.config();
  const early = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ name: 'Early', start_date: '2030-01-01', end_date: '2030-01-02' }) });
  const late = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: trip({ name: 'Late', start_date: '2030-09-01', end_date: '2030-09-02' }) });
  assert.deepEqual(late.trips.map((t) => t.name), ['Late', 'Early']);
  assert.ok(late.config_version > before.config_version);
});

test('a brand new trip defaults to holiday, and trip_kind is validated and kept-on-absent', (ctx) => {
  // trip() mints its own uuid each call and both land in the same household
  // with identical dates, so look each one up by id rather than assume an
  // array position (the bundle's tie-break on equal start_date is by id).
  const first = trip();
  const created = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: first });
  assert.equal(created.trips.find((x) => x.id === first.id).trip_kind, 'holiday');

  const t = trip({ trip_kind: 'work' });
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  expectError(ctx.db, ctx.alice, 'fulla_trip_upsert',
    { p_household_id: ctx.hh, p_trip: trip({ trip_kind: 'safari' }) }, 'validation_failed');

  // An old app version's upsert never learned trip_kind: absent keeps it.
  const stale = Object.assign({}, t, { name: 'Porto (renamed)' });
  delete stale.trip_kind;
  const kept = rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: stale });
  assert.equal(kept.trips.find((x) => x.id === t.id).trip_kind, 'work');
});

test('fulla_trip_delete tombstones the trip, untrips its transactions, and moves server_seq', (ctx) => {
  const t = trip();
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  const tx = expense(ctx, { trip_id: t.id });
  push(ctx, ctx.alice, [upsert(tx)]);
  assert.equal(stored(ctx, tx.id).trip_id, t.id);
  const seqBefore = ctx.db.admin(`select server_seq from fulla.transactions where id = ${h.literal(tx.id)};`).out;

  const cfg = rpc(ctx.db, ctx.alice, 'fulla_trip_delete', { p_household_id: ctx.hh, p_trip_id: t.id });

  // Gone from the bundle: nothing is physically deleted, but it never shows again.
  assert.deepEqual(cfg.trips, []);
  assert.equal(ctx.db.admin(`select status from fulla.trips where id = ${h.literal(t.id)};`).out, 'deleted');
  // Its expense stays, as a plain everyday expense.
  assert.equal(stored(ctx, tx.id).trip_id, null);
  const seqAfter = ctx.db.admin(`select server_seq from fulla.transactions where id = ${h.literal(tx.id)};`).out;
  assert.ok(Number(seqAfter) > Number(seqBefore), 'untripping must take a fresh server_seq so every phone pulls it');

  // A non-member is refused; deleting twice (already deleted) is refused too.
  const stranger = newUser(ctx.db, 'mallory@example.com');
  expectError(ctx.db, stranger, 'fulla_trip_delete', { p_household_id: ctx.hh, p_trip_id: t.id }, 'not_member', 403);
  expectError(ctx.db, ctx.alice, 'fulla_trip_delete', { p_household_id: ctx.hh, p_trip_id: t.id }, 'not_found', 404);
  expectError(ctx.db, ctx.alice, 'fulla_trip_delete', { p_household_id: ctx.hh, p_trip_id: uuid() }, 'not_found', 404);
});

test('a pending edit naming a since-deleted trip is not rejected and does not put it back (review HIGH 1)', (ctx) => {
  const t = trip();
  rpc(ctx.db, ctx.alice, 'fulla_trip_upsert', { p_household_id: ctx.hh, p_trip: t });
  const tx = expense(ctx, { trip_id: t.id });
  push(ctx, ctx.alice, [upsert(tx)]);
  rpc(ctx.db, ctx.alice, 'fulla_trip_delete', { p_household_id: ctx.hh, p_trip_id: t.id });
  assert.equal(stored(ctx, tx.id).trip_id, null);

  // Phone A was offline when the delete happened and only now pushes its own
  // edit, still naming the deleted trip explicitly (a 0.1.6/0.1.7 phone that
  // never heard of `status` would do exactly this too). It must apply, not
  // get stuck rejected forever resending the same stale trip_id, and it must
  // not put the row back on a trip nobody can see any more.
  const edited = Object.assign({}, tx, { note: 'renamed while offline', trip_id: t.id });
  const [res] = push(ctx, ctx.alice, [upsert(edited, iso(9))]);
  assert.equal(res.applied, true, JSON.stringify(res));
  assert.equal(stored(ctx, tx.id).trip_id, null, 'a deleted trip must never be put back on a row');
  assert.equal(stored(ctx, tx.id).note, 'renamed while offline');

  // A trip id that never existed at all is still refused (unchanged behaviour).
  const badTrip = expense(ctx, { trip_id: uuid() });
  const [refused] = push(ctx, ctx.alice, [upsert(badTrip)]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'validation_failed');
});

// ═════════════════════════════════════════════════════════════════════════════
// Concurrency
// ═════════════════════════════════════════════════════════════════════════════

test('a pull between two concurrent writers never skips the slower one', async (ctx) => {
  const bob = join(ctx, 'Bob');
  const start = pull(ctx, ctx.alice).cursor;
  const slow = expense(ctx);
  const fast = expense(ctx, { paid_by_member_id: bob.member, members: [bob.member] });
  // Alice's push takes its number first and then holds its transaction open.
  const slowWriter = ctx.db.asAsync(ctx.alice,
    `${callSql('fulla_sync_push', { p_household_id: ctx.hh, p_mutations: [upsert(slow)] })}\nselect pg_sleep(1.5);`);
  await new Promise((r) => setTimeout(r, 400));
  // Bob's push starts while Alice's is still open.
  const fastWriter = ctx.db.asAsync(bob.user, callSql('fulla_sync_push', { p_household_id: ctx.hh, p_mutations: [upsert(fast)] }));
  await new Promise((r) => setTimeout(r, 400));
  // Somebody pulls in between. Without the per-household lock, Bob's row would
  // already be committed with the higher number and this cursor would jump past
  // Alice's row for good.
  const between = pull(ctx, ctx.alice, start);
  await Promise.all([slowWriter, fastWriter]);
  const after = pull(ctx, ctx.alice, between.cursor);
  const got = [...between.transactions, ...after.transactions].map((t) => t.id).sort();
  assert.deepEqual(got, [slow.id, fast.id].sort(), 'both rows reach the reader');
  assert.ok(Number(stored(ctx, slow.id).server_seq) < Number(stored(ctx, fast.id).server_seq));
});

// ═════════════════════════════════════════════════════════════════════════════
// Installers
// ═════════════════════════════════════════════════════════════════════════════

rawTest('dist/setup.sql installs everything on an empty project and is safe to run twice', () => {
  const { bundle } = require('../scripts/bundle');
  const sql = bundle();
  const db = h.emptyDb();
  try {
    db.admin(sql);
    db.admin(sql);
    const applied = db.admin('select count(*) from fulla.schema_migrations;').out;
    assert.equal(Number(applied), h.migrations().length);
    const u = newUser(db, 'alice@example.com');
    const r = rpc(db, u, 'fulla_household_create', { p_name: 'Home', p_currency: 'EUR', p_locale: 'en', p_display_name: 'Alice', p_initials: 'A' });
    assert.ok(r.household_id);
  } finally {
    h.dropDb(db);
  }
});

rawTest('migrate.js applies pending migrations once, and agrees with setup.sql about what is applied', () => {
  const { spawnSync } = require('node:child_process');
  const db = h.emptyDb();
  try {
    const env = { ...process.env, DATABASE_URL: `postgresql://postgres@/${db.name}?host=${h.SOCK}&port=${h.PORT}`,
                  PATH: `${path.dirname(h.bin('psql'))}:${process.env.PATH}` };
    const run = () => spawnSync('node', [path.join(__dirname, '..', 'scripts', 'migrate.js')], { env, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal((first.stdout.match(/^applied /gm) || []).length, h.migrations().length);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Nothing to apply/);
    db.admin(require('../scripts/bundle').bundle());
    assert.equal(Number(db.admin('select count(*) from fulla.schema_migrations;').out), h.migrations().length);
  } finally {
    h.dropDb(db);
  }
});

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const filter = process.argv[2];
  const selected = filter ? tests.filter((t) => t.name.includes(filter)) : tests;
  h.start();
  h.buildTemplate();
  let failed = 0;
  const t0 = Date.now();
  for (const t of selected) {
    const db = h.freshDb();
    try {
      const ctx = t.raw ? { db } : setup(db);
      await t.fn(ctx);
      console.log(`  ok    ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL  ${t.name}\n        ${String(e.stack || e).split('\n').slice(0, 6).join('\n        ')}`);
    } finally {
      h.dropDb(db);
    }
  }
  h.stop();
  console.log(`\n${selected.length - failed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
}

main();
