# Data model

All tables live in the `fulla` schema, which is not exposed through the API.
The authoritative definitions are the migrations in `supabase/migrations/`;
this page explains them.

## Conventions

- **Ids** are UUIDs. Anything a phone can create offline gets its id on the
  phone, so a household can move from one phone to a server without
  renumbering anything.
- **Money** is `bigint` minor units of the household's currency. Transaction
  amounts are always positive; `kind` gives the direction.
- **Dates** of transactions are calendar dates (`YYYY-MM-DD`) without a time
  zone: a purchase happens on a day, not at an instant.
- **Timestamps** on the wire are ISO-8601 UTC with milliseconds and `Z`.
- **Nothing is deleted.** Structure is archived; transactions are tombstoned
  with `status = 'deleted'`.
- **Cross-household references are impossible**: references are composite
  foreign keys on `(household_id, id)`.
- **Names** are compared with accents removed, lower-cased and trimmed
  (`fulla.normalize_name`).

## Tables

| Table | What it holds |
|---|---|
| `households` | Name, currency, locale, period rules, first day of the week, member limit, `config_version` |
| `members` | People in a household. `user_id` is null for members without an account. `role`: owner, admin, member. `status`: active, archived, removed |
| `invites` | Single-use codes with expiry, optionally earmarked to claim a member without an account |
| `accounts` | Cash, checking, savings, credit card or other, with an opening balance and, optionally, a round-up (`round_up_to`, `round_up_multiplier`) |
| `categories` | One level of nesting; each applies to expenses, income or both. `fixed` marks fixed spending (rent, bills), the default for its transactions' `recurrence` |
| `custom_fields` | Household-defined fields; values live in `transactions.extras` under the field's `key`. `category_ids` limits one to some categories (and their subcategories), where it is asked as one more level |
| `budgets` | A limit per category and period (`YYYY-MM`), or for every period when `period` is null |
| `recurring_rules` | A transaction template and a schedule: daily, weekly, monthly (every N months from the start month, or only the months in `by_months`) or yearly |
| `categorization_rules` | "Note contains X → category / transfer / tags", used on import. `archived` is a deleted rule, never matched |
| `import_profiles` | How to read a particular CSV layout |
| `transactions` | Everything that happened |
| `trips` | A trip or event with its own optional budget: name, date range, `in_category_budgets` |

## Trips

`transactions.trip_id` points at a trip, only ever on an `expense` or a
`refund`. It follows the same "absent keeps its value" rule as
`extras` (`fulla.merge_extras`): a push that leaves the key out of a
transaction keeps whatever trip is already stored, an explicit `null`
clears it, and a uuid is checked against the household's trips. This
matters because a phone stores rows re-encoded, not the server's raw JSON, so
a phone that never learned about `trip_id` must not silently wipe a trip
another phone set just by editing the row.

Overlapping trips are allowed: a row simply names the one it belongs to.
Spending on a trip always counts in the month's totals; whether it also
counts in category budgets is the trip's own `in_category_budgets` switch
(off by default, since the trip already has its own budget).

## Transaction kinds

| kind | Needs | Counts as | Moves balances between members |
|---|---|---|---|
| `expense` | category (expense), payer, split if 2+ members | spending | yes |
| `income` | category (income) | income | no |
| `refund` | category (expense), who got the money, split if 2+ members | negative spending | yes, reversed |
| `transfer` | from account, to account | nothing | no |
| `settlement` | paying member, receiving member | nothing | yes |

## Splits

```json
{"mode": "equal",  "members": ["…", "…"]}
{"mode": "shares", "shares":  {"…": 2, "…": 1}}
{"mode": "exact",  "amounts": {"…": 1500, "…": 500}}
```

Participants are stored in the row, so adding a member later changes no past
expense. `equal` and `shares` are divided with the largest remainder method,
ties to the lowest member id, so every implementation gets the same result to
the unit.

## Periods

A period is named `YYYY-MM`. By default it is the calendar month. A household
can instead start periods on a day from 2 to 28 (a period is named after the
month it ends in), or keep calendar months and count fixed income dated on or
after a given day in the next month. Not both.

An income can also be marked as starting the month (the reserved tag
`fulla:starts-period`, hidden in the app). Then each marked income starts a period that
runs until the day before the next one, named after the month it funds (its
own month before the 15th, the next from then on); the latest period stays
open until the next salary is written down, and what counts is each row's
date, not when it was written. Days before the first salary follow the rules
above. A salary a recurring item wrote on its own counts once somebody has
saved it.

## Balances

For each member, `balance = paid − share`:

| | paid | share |
|---|---|---|
| expense of A by P, split s | P +A | each i +sᵢ |
| refund of A to P, split s | P −A | each i −sᵢ |
| settlement of A from X to Y | X +A, Y −A | |

Balances in a household always add up to zero.

A recurring item is never physically deleted (rows it wrote point at it): deleting
it sets `archived`, which hides it and stops it writing, like accounts and
categories (0021).
