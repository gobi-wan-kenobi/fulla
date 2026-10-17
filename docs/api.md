# API

The app talks to the database through PostgREST, calling one function per
operation:

```
POST https://<project>.supabase.co/rest/v1/rpc/<function>
apikey: <anon key>
Authorization: Bearer <the user's access token>
Content-Type: application/json

{"p_household_id": "…", …}
```

Arguments are named after the function's parameters. Results are JSON.

## Errors

Failures come back with a real HTTP status and PostgREST's error body. The
machine-readable code is in `details`; `message` is for people.

| `details` | HTTP | Meaning |
|---|---|---|
| `not_authenticated` | 401 | No signed-in user |
| `validation_failed` | 400 | Invalid input; `message` says what |
| `not_member` | 403 | Not an active member of that household |
| `forbidden_role` | 403 | Your role does not allow this |
| `not_found` | 404 | No such item in that household |
| `already_exists` | 409 | That id is already in use |
| `household_full` | 409 | The member limit has been reached |
| `last_owner` | 409 | The owner must hand over first |
| `delete_forbidden` | 409 | Nothing is ever deleted |
| `too_many_attempts` | 429 | Too many wrong invite codes; wait an hour |
| `owner_must_hand_over` | 409 | Hand the household over before deleting the account |

`fulla_invite_accept` is the one exception: a bad code is answered with
`200 {"ok": false, "error": "invite_invalid" | "invite_expired" |
"invite_used" | "already_member" | "household_full"}`, because a failed guess
must be recorded to throttle the next one, and an error would undo the record.

## Roles

| | member | admin | owner |
|---|:-:|:-:|:-:|
| Read everything in the household; add, edit and delete transactions; settle up; import | ✓ | ✓ | ✓ |
| Change own name, initials and colour | ✓ | ✓ | ✓ |
| Accounts, categories, fields, budgets, recurring items, rules; household settings except currency and limit | | ✓ | ✓ |
| Members without an account; invite members; remove members | | ✓ | ✓ |
| Invite admins; change roles; remove admins; currency; member limit; transfer ownership | | | ✓ |

## Functions

Every function that takes `p_household_id` first checks that the caller is an
active member with at least the role shown.

### System

| Function | Role | Returns |
|---|---|---|
| `fulla_ping()` | any | `{api_version, server_time, signed_in}` |
| `fulla_my_households()` | signed in | `[{household_id, name, currency, member_id, role}]` |
| `fulla_account_delete()` | signed in | Deletes the account. Households only this person used are erased; in the others the membership is detached and marked removed. The owner of a household others use gets `owner_must_hand_over` (409) |

### Households, members, invites

| Function | Role | Notes |
|---|---|---|
| `fulla_household_create(p_name, p_currency, p_locale, p_display_name, p_initials, p_color_index)` | signed in | Creates the household with default categories and accounts in the locale's language; the caller is owner. Returns `{household_id, member_id, config}` |
| `fulla_household_create_from_local(p_payload)` | signed in | Uploads a household that lived on one phone, keeping every id. Idempotent for its owner |
| `fulla_household_update(p_household_id, p_patch)` | admin | `name`, `locale`, `period_start_day`, `income_shift_day`, `week_start`, `money_mode` (`split`, `shared` or null); owner only: `currency`, `member_limit` |
| `fulla_field_set_categories(p_household_id, p_field_id, p_category_ids)` | admin | Limits a custom field to categories (a JSON list of ids; null or empty lifts it). A category covers its subcategories. Returns the config bundle |
| `fulla_invite_create(p_household_id, p_role, p_claim_member_id, p_ttl_hours)` | admin (owner for `admin`) | `{code, expires_at, role, claim_member_id}` |
| `fulla_invite_list(p_household_id)` | admin | Open invites |
| `fulla_invite_revoke(p_household_id, p_code)` | admin | |
| `fulla_invite_accept(p_code, p_display_name, p_initials, p_color_index)` | signed in | `{ok, household_id, member_id, config}` or `{ok: false, error}` |
| `fulla_member_create_virtual(p_household_id, p_member)` | admin | A member without an account |
| `fulla_member_update(p_household_id, p_member_id, p_patch)` | self, or admin | `display_name`, `initials`, `color_index` |
| `fulla_member_set_role(p_household_id, p_member_id, p_role)` | owner | `admin` or `member` |
| `fulla_member_remove(p_household_id, p_member_id)` | admin | Access ends at once; history stays |
| `fulla_member_leave(p_household_id)` | member | Not the owner |
| `fulla_owner_transfer(p_household_id, p_member_id)` | owner | The old owner becomes admin |

### Structure

All return the full config (below). Nothing is deleted: set `archived: true`
(or `active: false` to pause rules and recurring items; a deleted rule is
`archived: true`). A category's `fixed: true` marks fixed spending, the
default `recurrence` a transaction put in it gets. Leaving `archived` (rules)
or `fixed` (categories) out of a save keeps what is stored.

| Function | Role |
|---|---|
| `fulla_config_get(p_household_id)` | member |
| `fulla_account_upsert(p_household_id, p_account)` | admin |
| `fulla_category_upsert(p_household_id, p_category)` | admin |
| `fulla_field_upsert(p_household_id, p_field)` | admin |
| `fulla_budget_upsert(p_household_id, p_budget)` | admin |
| `fulla_budget_copy(p_household_id, p_from_period, p_to_period)` | admin |
| `fulla_recurring_upsert(p_household_id, p_rule)` | admin |
| `fulla_rule_upsert(p_household_id, p_rule)` | admin |
| `fulla_import_profile_upsert(p_household_id, p_profile)` | member |
| `fulla_trip_upsert(p_household_id, p_trip)` | member |

The config bundle:

```json
{"config_version": 17,
 "household": {"id", "name", "currency", "locale", "period_start_day", "income_shift_day", "week_start", "member_limit", "money_mode"},
 "me_member_id": "…",
 "members": [{"id", "display_name", "initials", "color_index", "role", "status", "has_account"}],
 "accounts": [...], "categories": [...], "custom_fields": [...], "budgets": [...],
 "recurring_rules": [...], "categorization_rules": [...], "import_profiles": [...]}
```

### Sync and reports

| Function | Role | Notes |
|---|---|---|
| `fulla_sync_push(p_household_id, p_mutations)` | member | See [sync.md](sync.md) |
| `fulla_sync_pull(p_household_id, p_since, p_config_version, p_limit)` | member | See [sync.md](sync.md) |
| `fulla_period_summary(p_household_id, p_from, p_to)` | member | `[{period, income_minor, expense_minor, savings_minor}]` |
| `fulla_member_balances(p_household_id)` | member | `[{member_id, paid_minor, share_minor, balance_minor}]` |
