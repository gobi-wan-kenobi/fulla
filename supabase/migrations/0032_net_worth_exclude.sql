-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- An account can be left out of net worth: a child's savings or cash the
-- household tracks but does not count as its own. The web's Net worth screen
-- leaves such an account out completely (not listed, not in any count). It
-- reaches the config unchanged (to_jsonb of the row), and a save that leaves
-- the key out keeps what is stored, so a phone that has not heard of it
-- cannot clear it. Nothing else reads it: the account's rows still count in
-- the month's figures as before.

alter table fulla.accounts add column exclude_from_net_worth boolean not null default false;

-- save_account (0025, 0028, 0029), with the flag.
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
  v_exclude boolean;
begin
  if char_length(v_name) not between 1 and 40 then
    perform fulla.invalid('An account name must be 1 to 40 characters.');
  end if;
  if v_type not in ('cash', 'checking', 'savings', 'credit_card', 'investment', 'other') then
    perform fulla.invalid('`type` must be cash, checking, savings, credit_card, investment or other.');
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
    if v_last4 is not null and v_last4 !~ '^[0-9A-Z]{4}$' then
      perform fulla.invalid('`last4` must be the last four digits (or letters and digits) of the account number, nothing more.');
    end if;
  else
    select a.last4 into v_last4 from fulla.accounts a where a.id = v_id;
  end if;

  -- Left out of net worth (a child's account): kept when absent.
  if p ? 'exclude_from_net_worth' then
    v_exclude := fulla.json_bool(p, 'exclude_from_net_worth', false);
  else
    select a.exclude_from_net_worth into v_exclude from fulla.accounts a where a.id = v_id;
    v_exclude := coalesce(v_exclude, false);
  end if;

  insert into fulla.accounts (id, household_id, name, type, opening_balance_minor, opening_balance_date, sort, archived,
                              round_up_to, round_up_multiplier, institution, last4, exclude_from_net_worth)
  values (v_id, p_household_id, v_name, v_type, v_balance, v_date,
          fulla.json_int(p, 'sort', 0, -1000000, 1000000), v_archived, v_round_to, v_round_multiplier, v_institution, v_last4, v_exclude)
  on conflict (id) do update
     set name = excluded.name, type = excluded.type, opening_balance_minor = excluded.opening_balance_minor,
         opening_balance_date = excluded.opening_balance_date, sort = excluded.sort, archived = excluded.archived,
         round_up_to = excluded.round_up_to, round_up_multiplier = excluded.round_up_multiplier,
         institution = excluded.institution, last4 = excluded.last4,
         exclude_from_net_worth = excluded.exclude_from_net_worth;
  return v_id;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 32;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
