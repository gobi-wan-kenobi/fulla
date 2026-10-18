-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Accounts from statements, and what each statement said the balance was.
--
-- An account can say which bank it is at and the last four digits of its
-- number, read from a statement on import, so the next statement of the same
-- account finds it by itself (and transfers between two of the household's
-- statements can be matched). Never more than four digits: the check refuses
-- a full number. Both columns reach the household's config unchanged (it is
-- built from to_jsonb of the row) and, as for the opening balance (0015), a
-- save that leaves a key out keeps what is stored, so a phone that has not
-- heard of them cannot clear them.
--
-- fulla.balance_snapshots keeps each statement's closing balance and its date,
-- per account, for net worth later. No UI reads it yet. Row-level security is
-- on with no policies, and nothing is granted on the table: it is reached only
-- through the two functions below, which check membership.

alter table fulla.accounts add column institution text check (institution is null or char_length(institution) between 1 and 40);
alter table fulla.accounts add column last4 text check (last4 is null or last4 ~ '^[0-9]{4}$');

create or replace function fulla.save_account(p_household_id uuid, p jsonb) returns uuid
language plpgsql volatile
as $$
declare
  v_id uuid := fulla.item_id(p_household_id, 'fulla.accounts', p);
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_type text := coalesce(p ->> 'type', 'other');
  v_archived boolean := fulla.json_bool(p, 'archived', false);
  v_date date;
  v_balance bigint;
  v_round_to uuid;
  v_round_multiplier smallint;
  v_institution text;
  v_last4 text;
begin
  if char_length(v_name) not between 1 and 40 then
    perform fulla.invalid('An account name must be 1 to 40 characters.');
  end if;
  if v_type not in ('cash', 'checking', 'savings', 'credit_card', 'other') then
    perform fulla.invalid('`type` must be cash, checking, savings, credit_card or other.');
  end if;
  if not v_archived and exists (
    select 1 from fulla.accounts a
     where a.household_id = p_household_id and a.id <> v_id and not a.archived
       and fulla.normalize_name(a.name) = fulla.normalize_name(v_name)
  ) then
    perform fulla.invalid(format('There is already an account called «%s».', v_name));
  end if;

  if p ? 'opening_balance_date' then
    if jsonb_typeof(p -> 'opening_balance_date') <> 'null' then
      v_date := fulla.try_date(p ->> 'opening_balance_date');
      if v_date is null then
        perform fulla.invalid('`opening_balance_date` must be a date (YYYY-MM-DD).');
      end if;
    end if;
  else
    select a.opening_balance_date into v_date from fulla.accounts a where a.id = v_id;
  end if;

  if p ? 'opening_balance_minor' then
    v_balance := coalesce(fulla.json_bigint(p, 'opening_balance_minor'), 0);
  else
    select a.opening_balance_minor into v_balance from fulla.accounts a where a.id = v_id;
    v_balance := coalesce(v_balance, 0);
  end if;

  if p ? 'round_up_to' or p ? 'round_up_multiplier' then
    v_round_to := fulla.json_uuid(p, 'round_up_to');
    v_round_multiplier := fulla.json_int(p, 'round_up_multiplier', 0, 0, 1000)::smallint;
    if v_round_multiplier = 0 then
      v_round_multiplier := null;
    end if;
    if (v_round_to is null) <> (v_round_multiplier is null) then
      perform fulla.invalid('`round_up_to` and `round_up_multiplier` go together.');
    end if;
    if v_round_to is not null then
      if v_round_multiplier not in (1, 2, 5, 10) then
        perform fulla.invalid('`round_up_multiplier` must be 1, 2, 5 or 10.');
      end if;
      if v_type = 'cash' then
        perform fulla.invalid('Cash has no round-up: it is not a card.');
      end if;
      if v_round_to = v_id then
        perform fulla.invalid('An account cannot round up to itself.');
      end if;
      if not exists (select 1 from fulla.accounts a where a.id = v_round_to and a.household_id = p_household_id) then
        perform fulla.invalid('`round_up_to` must be an account of this household.');
      end if;
    end if;
  else
    select a.round_up_to, a.round_up_multiplier into v_round_to, v_round_multiplier from fulla.accounts a where a.id = v_id;
  end if;

  -- The statement's bank and the account number's last four digits (never more): kept when absent.
  if p ? 'institution' then
    v_institution := nullif(btrim(coalesce(p ->> 'institution', '')), '');
    if v_institution is not null and char_length(v_institution) > 40 then
      perform fulla.invalid('`institution` must be at most 40 characters.');
    end if;
  else
    select a.institution into v_institution from fulla.accounts a where a.id = v_id;
  end if;
  if p ? 'last4' then
    v_last4 := nullif(btrim(coalesce(p ->> 'last4', '')), '');
    if v_last4 is not null and v_last4 !~ '^[0-9]{4}$' then
      perform fulla.invalid('`last4` must be the last four digits of the account number, nothing more.');
    end if;
  else
    select a.last4 into v_last4 from fulla.accounts a where a.id = v_id;
  end if;

  insert into fulla.accounts (id, household_id, name, type, opening_balance_minor, opening_balance_date, sort, archived,
                              round_up_to, round_up_multiplier, institution, last4)
  values (v_id, p_household_id, v_name, v_type, v_balance, v_date,
          fulla.json_int(p, 'sort', 0, -1000000, 1000000), v_archived, v_round_to, v_round_multiplier, v_institution, v_last4)
  on conflict (id) do update
     set name = excluded.name, type = excluded.type, opening_balance_minor = excluded.opening_balance_minor,
         opening_balance_date = excluded.opening_balance_date, sort = excluded.sort, archived = excluded.archived,
         round_up_to = excluded.round_up_to, round_up_multiplier = excluded.round_up_multiplier,
         institution = excluded.institution, last4 = excluded.last4;
  return v_id;
end;
$$;

create table fulla.balance_snapshots (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references fulla.households (id),
  account_id    uuid not null references fulla.accounts (id),
  as_of         date not null,
  balance_minor bigint not null,
  source        text not null default 'statement' check (source in ('statement')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (account_id, as_of, source)
);
create index balance_snapshots_household on fulla.balance_snapshots (household_id, account_id, as_of);

alter table fulla.balance_snapshots enable row level security;
revoke all on fulla.balance_snapshots from public, anon, authenticated;

create trigger balance_snapshots_forbid_delete
  before delete on fulla.balance_snapshots
  for each row execute function fulla.forbid_delete();

-- Records a statement's closing balance; the same account, day and source again replaces it.
create function public.fulla_balance_snapshot_save(p_household_id uuid, p_snapshot jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_as_of date;
  v_balance bigint;
  v_id uuid;
begin
  perform fulla.require_member(p_household_id, 'member');
  if jsonb_typeof(p_snapshot) <> 'object' then
    perform fulla.invalid('A balance snapshot must be an object.');
  end if;
  v_account := fulla.json_uuid(p_snapshot, 'account_id');
  if v_account is null or not exists (select 1 from fulla.accounts a where a.id = v_account and a.household_id = p_household_id) then
    perform fulla.invalid('`account_id` must be an account of this household.');
  end if;
  v_as_of := fulla.try_date(p_snapshot ->> 'as_of');
  if v_as_of is null then
    perform fulla.invalid('`as_of` must be a date (YYYY-MM-DD).');
  end if;
  v_balance := fulla.json_bigint(p_snapshot, 'balance_minor');
  if v_balance is null then
    perform fulla.invalid('`balance_minor` must be a whole number of minor units.');
  end if;
  insert into fulla.balance_snapshots (household_id, account_id, as_of, balance_minor)
  values (p_household_id, v_account, v_as_of, v_balance)
  on conflict (account_id, as_of, source) do update set balance_minor = excluded.balance_minor, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- Every snapshot of the household, oldest first.
create function public.fulla_balance_snapshots(p_household_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform fulla.require_member(p_household_id, 'member');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'account_id', s.account_id, 'as_of', s.as_of,
                                        'balance_minor', s.balance_minor, 'source', s.source) order by s.as_of, s.account_id)
      from fulla.balance_snapshots s where s.household_id = p_household_id), '[]'::jsonb);
end;
$$;

create or replace function fulla.erase_household(p_household_id uuid) returns void
language plpgsql volatile
as $$
begin
  perform set_config('fulla.erasing_household', p_household_id::text, true);
  delete from fulla.transactions where household_id = p_household_id;
  delete from fulla.trips where household_id = p_household_id;
  delete from fulla.invites where household_id = p_household_id;
  delete from fulla.budgets where household_id = p_household_id;
  delete from fulla.recurring_rules where household_id = p_household_id;
  delete from fulla.categorization_rules where household_id = p_household_id;
  delete from fulla.import_profiles where household_id = p_household_id;
  delete from fulla.custom_fields where household_id = p_household_id;
  update fulla.categories set parent_id = null where household_id = p_household_id and parent_id is not null;
  delete from fulla.categories where household_id = p_household_id;
  delete from fulla.balance_snapshots where household_id = p_household_id;
  delete from fulla.accounts where household_id = p_household_id;
  delete from fulla.members where household_id = p_household_id;
  delete from fulla.households where id = p_household_id;
  perform set_config('fulla.erasing_household', '', true);
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 25;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_balance_snapshot_save(uuid, jsonb) from public, anon;
revoke all on function public.fulla_balance_snapshots(uuid) from public, anon;
grant execute on function public.fulla_balance_snapshot_save(uuid, jsonb) to authenticated;
grant execute on function public.fulla_balance_snapshots(uuid) to authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
