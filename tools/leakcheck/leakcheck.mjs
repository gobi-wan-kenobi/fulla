#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Leak scanner. A finance app's repository is the last
// place a real name, a real amount or a credential should end up. This runs as
// a pre-commit hook, as a commit-msg hook, and in CI.
//
// Two kinds of rule:
//
//   1. Secrets: built in, always on (JWTs, service keys, connection strings
//      with a password, private keys, real Supabase project refs).
//   2. A private denylist: terms that must never appear in this repository.
//      It is deliberately NOT part of the repository, since publishing it would
//      publish what it protects. It is read from, in order:
//        - $LEAKCHECK_DENYLIST       (the content itself; used by CI secrets)
//        - $FULLA_DENYLIST           (a path)
//        - ~/.config/fulla/denylist.txt
//
// Denylist format, one entry per line, `#` for comments:
//   text:<s>    substring, case- and accent-insensitive
//   word:<s>    whole word(s), case- and accent-insensitive
//   amount:<n>  an amount in minor units (e.g. 1234 = 12.34), matched in any
//               common decimal notation (12.34, 12,34, 1.234,56, 1,234.56)
//   re:<regex>  a case-insensitive regular expression
//
// Findings name the file, the line and the rule number, never the matched
// text: CI logs are read by more people than the code.
//
// Usage:
//   node tools/leakcheck/leakcheck.mjs            tracked + untracked (not ignored) files
//   node tools/leakcheck/leakcheck.mjs --staged   the staged version of staged files
//   node tools/leakcheck/leakcheck.mjs --history  every commit: patches, messages, identities
//   node tools/leakcheck/leakcheck.mjs --message <file>
//   node tools/leakcheck/leakcheck.mjs --stdin
//   add --require-denylist to fail when no denylist is available

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const ALLOWED_IDENTITIES = [
  /^53468881\+SirAllap@users\.noreply\.github\.com$/i,
  /^noreply@anthropic\.com$/i,
  /^noreply@github\.com$/i,
  // The fork owner (gobi-wan-kenobi): a no-reply address, nothing personal.
  /^noreply@users\.noreply\.github\.com$/i,
];

const BINARY = /\.(ttf|otf|woff2?|png|jpe?g|webp|gif|ico|jar|keystore|jks|zip|gz|pdf)$/i;

const PLACEHOLDER_REFS = new Set(['abcdefghijklmnopqrst', 'yourprojectrefxxxxxx']);

const SECRET_RULES = [
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'supabase-secret-key', re: /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/ },
  { name: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { name: 'db-url-with-password', re: /postgres(ql)?:\/\/[^:\s/]+:[^@\s]+@(?!localhost|127\.0\.0\.1|host)/i },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'real-supabase-ref',
    test: (line) => {
      for (const m of line.matchAll(/\b([a-z0-9]{20})\.supabase\.co\b/g)) {
        if (!PLACEHOLDER_REFS.has(m[1])) return true;
      }
      return false;
    },
  },
];

// ── denylist ────────────────────────────────────────────────────────────────

function fold(s) {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadDenylist() {
  let raw = process.env.LEAKCHECK_DENYLIST;
  let source = 'env LEAKCHECK_DENYLIST';
  if (!raw) {
    const path = process.env.FULLA_DENYLIST || join(homedir(), '.config', 'fulla', 'denylist.txt');
    if (existsSync(path)) {
      raw = readFileSync(path, 'utf8');
      source = path;
    }
  }
  if (!raw) return { rules: [], source: null };

  const rules = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) return;
    const at = entry.indexOf(':');
    const kind = at > 0 ? entry.slice(0, at) : 'text';
    const value = at > 0 ? entry.slice(at + 1) : entry;
    const id = `denylist#${i + 1}`;
    if (kind === 'text') {
      const needle = fold(value);
      rules.push({ name: id, test: (_line, folded) => folded.includes(needle) });
    } else if (kind === 'word') {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(fold(value))}(?![\\p{L}\\p{N}_])`, 'u');
      rules.push({ name: id, test: (_line, folded) => re.test(folded) });
    } else if (kind === 'amount') {
      const minor = Number.parseInt(value, 10);
      if (Number.isFinite(minor)) rules.push({ name: id, amount: true, test: (line) => amounts(line).has(minor) });
    } else if (kind === 're') {
      const re = new RegExp(value, 'iu');
      rules.push({ name: id, test: (line) => re.test(line) });
    }
  });
  return { rules, source };
}

// Every number in a line that reads as an amount with exactly two decimals, in
// minor units. Grouping separators are accepted in either convention.
function amounts(line) {
  const found = new Set();
  // Numbers inside braces are regex quantifiers such as {1,15}, and numbers
  // followed by another separator and digit are versions such as 5.11.3.
  const re = /(?<![\d.,{])(\d{1,3}(?:([.,' \u00a0])\d{3})*|\d+)([.,])(\d{2})(?![\d}]|[.,]\d)/g;
  for (const m of line.matchAll(re)) {
    const group = m[2];
    const decimal = m[3];
    if (group && group === decimal) continue; // "1.234.56" is not an amount
    const whole = m[1].replace(/[.,' \u00a0]/g, '');
    found.add(Number.parseInt(whole, 10) * 100 + Number.parseInt(m[4], 10));
  }
  return found;
}

// ── inputs ──────────────────────────────────────────────────────────────────

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function workingTreeFiles() {
  return git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
    .filter((f) => existsSync(f) && !BINARY.test(f))
    .map((f) => ({ label: f, text: readFileSync(f, 'utf8') }));
}

function stagedFiles() {
  return git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR')
    .split('\0')
    .filter(Boolean)
    .filter((f) => !BINARY.test(f))
    .map((f) => ({ label: `${f} (staged)`, text: git('show', `:${f}`) }));
}

function history() {
  const inputs = [];
  let log = '';
  try {
    log = git('log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00%x01');
  } catch {
    return { inputs, identities: [] }; // no commits yet
  }
  const identities = [];
  for (const record of log.split('\x01')) {
    const [hash, an, ae, cn, ce, body] = record.replace(/^\n/, '').split('\0');
    if (!hash) continue;
    const short = hash.slice(0, 10);
    inputs.push({ label: `commit ${short} message`, text: `${an}\n${cn}\n${body || ''}` });
    for (const email of [ae, ce]) {
      if (!ALLOWED_IDENTITIES.some((re) => re.test(email))) identities.push(`commit ${short}: identity not allowed`);
    }
  }
  const patches = git('log', '--all', '-p', '--format=@@commit %H', '--no-color', '--no-ext-diff');
  inputs.push({ label: 'history patches', text: patches });
  return { inputs, identities };
}

// ── scan ────────────────────────────────────────────────────────────────────

// Dependency manifests hold version numbers, never amounts.
const NO_AMOUNTS = /(^|\/)(gradle\/|[^/]*\.gradle\.kts$|[^/]*\.toml$|package(-lock)?\.json$|gradle-wrapper\.properties$)/;

function scan(inputs, rules) {
  const findings = [];
  for (const { label, text } of inputs) {
    if (text.includes('\0')) continue; // binary
    const lines = text.split(/\r?\n/);
    let where = label;
    lines.forEach((line, i) => {
      if (label === 'history patches') {
        if (line.startsWith('@@commit ')) where = `commit ${line.slice(9, 19)}`;
        if (line.startsWith('+++ b/')) where = `${where.split(' in ')[0]} in ${line.slice(6)}`;
        if (!line.startsWith('+') || line.startsWith('+++')) return;
      }
      const folded = fold(line);
      const file = where.includes(' in ') ? where.split(' in ')[1] : label;
      for (const rule of rules) {
        if (rule.amount && NO_AMOUNTS.test(file)) continue;
        const hit = rule.re ? rule.re.test(line) : rule.test(line, folded);
        if (hit) findings.push(`${where}:${label === 'history patches' ? '' : i + 1}  [${rule.name}]`);
      }
    });
  }
  return findings;
}

function main() {
  const { rules: deny, source } = loadDenylist();
  if (!source) {
    const msg = 'leakcheck: no private denylist found; only secret rules are active.';
    if (has('--require-denylist')) {
      console.error(`${msg} (--require-denylist)`);
      process.exit(2);
    }
    console.error(msg);
  }
  const rules = [...SECRET_RULES, ...deny];

  let inputs;
  let identityProblems = [];
  if (has('--staged')) inputs = stagedFiles();
  else if (has('--history')) ({ inputs, identities: identityProblems = [] } = history());
  else if (has('--stdin')) inputs = [{ label: 'stdin', text: readFileSync(0, 'utf8') }];
  else if (has('--message')) {
    const file = args[args.indexOf('--message') + 1];
    inputs = [{ label: 'commit message', text: readFileSync(file, 'utf8') }];
  } else inputs = workingTreeFiles();

  const findings = [...identityProblems, ...scan(inputs, rules)];
  if (findings.length) {
    console.error(`leakcheck: ${findings.length} finding(s):`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`leakcheck: clean (${inputs.length} input(s), ${rules.length} rule(s)${source ? '' : ', no denylist'}).`);
}

main();
