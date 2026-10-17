# Changelog

All notable changes to Fulla are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Web: transfers between your own accounts, credit card bill payments and loan
  payments are imported as transfers, not spending.
- Web: import Wealthsimple chequing PDF statements, read in the browser, with
  every running balance checked.
- Database schema for households, members, invites, accounts, categories,
  custom fields, budgets, recurring rules, categorisation rules, import
  profiles and transactions.
- Row level security and a function-only API with owner, admin and member roles.
- Invites with single-use codes, expiry and throttling; members without an
  account who can later be claimed.
- Offline sync: batched push with per-mutation conflict reporting, and a
  paginated pull on a server cursor that is safe under concurrent writers.
- Splits (equal, shares, exact), member balances and period summaries.
- `setup.sql` bundle and a migration runner.
- A leak scanner for secrets and personal data, run as git hooks and in CI.
