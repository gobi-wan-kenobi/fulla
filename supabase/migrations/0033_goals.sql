-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Savings goals (the web fork's Goals): "save $100,000 by 2030", or "put
-- $500 a month towards a new car". A goal has a target amount, a target date
-- or a monthly amount (or both), what it starts from, and optionally an
-- account (savings or investment) whose balance is its progress. Without an
-- account, its progress is what the household records against it in
-- fulla.goal_contributions. The client works out the monthly target, the
-- pace and where spending could give way; nothing here writes a transaction.
--
-- Members read both tables (through the functions); admins create and change
-- goals, as with budgets; any member records a contribution, as with a
-- transaction. Nothing is deleted: a goal is archived, a contribution voided.

create table fulla.goals (
  id             uuid primary key,
  household_id   uuid not null references fulla.households (id),
  name           text not null check (char_length(name) between 1 and 60),
  target_minor   bigint not null check (target_minor > 0),
  target_date    date,
  monthly_minor  bigint check (monthly_minor is null or monthly_minor > 0),
  account_id     uuid references fulla.accounts (id),
  start_minor    bigint not null default 0,
  start_date     date not null,
  archived       boolean not null default false,
  updated_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (target_date is not null or monthly_minor is not null),
  check (target_date is null or target_date > start_date),
  foreign key (household_id, updated_by) references fulla.members (household_id, id)
);
create index goals_household on fulla.goals (household_id);

create table fulla.goal_contributions (
  id             uuid primary key,
  household_id   uuid not null references fulla.households (id),
  goal_id        uuid not null references fulla.goals (id),
  date           date not null,
  amount_minor   bigint not null check (amount_minor <> 0),
  note           text not null default '' check (char_length(note) <= 120),
  voided         boolean not null default false,
  updated_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (household_id, updated_by) references fulla.members (household_id, id)
);
create index goal_contributions_goal on fulla.goal_contributions (household_id, goal_id, date);

alter table fulla.goals enable row level security;
alter table fulla.goal_contributions enable row level security;
revoke all on fulla.goals from public, anon, authenticated;
revoke all on fulla.goal_contributions from public, anon, authenticated;
create policy goals_members_read on fulla.goals
  for select to authenticated using (fulla.is_active_member(household_id));
create policy goal_contributions_members_read on fulla.goal_contributions
  for select to authenticated using (fulla.is_active_member(household_id));
create trigger goals_forbid_delete before delete on fulla.goals
  for each row execute function fulla.forbid_delete();
create trigger goal_contributions_forbid_delete before delete on fulla.goal_contributions
  for each row execute function fulla.forbid_delete();

-- Every goal of the household (archived ones too, flagged) and every contribution not voided, oldest first.
create function public.fulla_goals(p_household_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform fulla.require_member(p_household_id, 'member');
  return jsonb_build_object(
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'target_minor', g.target_minor, 'target_date', g.target_date,
                                          'monthly_minor', g.monthly_minor, 'account_id', g.account_id, 'start_minor', g.start_minor,
                                          'start_date', g.start_date, 'archived', g.archived) order by g.created_at, g.id)
        from fulla.goals g where g.household_id = p_household_id), '[]'::jsonb),
    'contributions', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'goal_id', c.goal_id, 'date', c.date, 'amount_minor', c.amount_minor, 'note', c.note)
                       order by c.date, c.created_at, c.id)
        from fulla.goal_contributions c where c.household_id = p_household_id and not c.voided), '[]'::jsonb));
end;
$$;

-- Creates or changes a goal (an admin's call). Returns fulla_goals.
create function public.fulla_goal_upsert(p_household_id uuid, p_goal jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_id uuid;
  v_name text;
  v_target bigint;
  v_date date;
  v_monthly bigint;
  v_account uuid;
  v_start bigint;
  v_start_date date;
begin
  v_me := (fulla.require_member(p_household_id, 'admin')).id;
  if jsonb_typeof(p_goal) is distinct from 'object' then
    perform fulla.invalid('A goal must be an object.');
  end if;
  v_id := fulla.item_id(p_household_id, 'fulla.goals', p_goal);
  v_name := btrim(coalesce(p_goal ->> 'name', ''));
  if char_length(v_name) not between 1 and 60 then
    perform fulla.invalid('A goal''s name must be 1 to 60 characters.');
  end if;
  v_target := fulla.json_bigint(p_goal, 'target_minor');
  if v_target is null or v_target <= 0 then
    perform fulla.invalid('`target_minor` must be more than zero.');
  end if;
  if p_goal ? 'target_date' and jsonb_typeof(p_goal -> 'target_date') <> 'null' then
    v_date := fulla.try_date(p_goal ->> 'target_date');
    if v_date is null then
      perform fulla.invalid('`target_date` must be a date (YYYY-MM-DD).');
    end if;
  end if;
  v_monthly := fulla.json_bigint(p_goal, 'monthly_minor');
  if v_monthly is not null and v_monthly <= 0 then
    perform fulla.invalid('`monthly_minor` must be more than zero.');
  end if;
  if v_date is null and v_monthly is null then
    perform fulla.invalid('A goal needs a target date or a monthly amount.');
  end if;
  v_account := fulla.json_uuid(p_goal, 'account_id');
  if v_account is not null and not exists (select 1 from fulla.accounts a where a.id = v_account and a.household_id = p_household_id) then
    perform fulla.invalid('`account_id` must be an account of this household.');
  end if;
  v_start := coalesce(fulla.json_bigint(p_goal, 'start_minor'), 0);
  v_start_date := coalesce(fulla.try_date(p_goal ->> 'start_date'), (select g.start_date from fulla.goals g where g.id = v_id), current_date);
  if v_date is not null and v_date <= v_start_date then
    perform fulla.invalid('The target date must be after the start date.');
  end if;
  insert into fulla.goals (id, household_id, name, target_minor, target_date, monthly_minor, account_id, start_minor, start_date, archived, updated_by)
  values (v_id, p_household_id, v_name, v_target, v_date, v_monthly, v_account, v_start, v_start_date, fulla.json_bool(p_goal, 'archived', false), v_me)
  on conflict (id) do update
     set name = excluded.name, target_minor = excluded.target_minor, target_date = excluded.target_date,
         monthly_minor = excluded.monthly_minor, account_id = excluded.account_id, start_minor = excluded.start_minor,
         start_date = excluded.start_date, archived = excluded.archived, updated_by = excluded.updated_by, updated_at = now();
  return public.fulla_goals(p_household_id);
end;
$$;

-- Records (or changes, or voids) a contribution towards a goal: any member. Returns fulla_goals.
create function public.fulla_goal_contribution_save(p_household_id uuid, p_contribution jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_id uuid;
  v_goal uuid;
  v_date date;
  v_amount bigint;
  v_note text;
begin
  v_me := (fulla.require_member(p_household_id, 'member')).id;
  if jsonb_typeof(p_contribution) is distinct from 'object' then
    perform fulla.invalid('A contribution must be an object.');
  end if;
  v_id := fulla.item_id(p_household_id, 'fulla.goal_contributions', p_contribution);
  v_goal := fulla.json_uuid(p_contribution, 'goal_id');
  if v_goal is null or not exists (select 1 from fulla.goals g where g.id = v_goal and g.household_id = p_household_id) then
    perform fulla.invalid('`goal_id` must be a goal of this household.');
  end if;
  v_date := fulla.try_date(p_contribution ->> 'date');
  if v_date is null then
    perform fulla.invalid('`date` must be a date (YYYY-MM-DD).');
  end if;
  v_amount := fulla.json_bigint(p_contribution, 'amount_minor');
  if v_amount is null or v_amount = 0 then
    perform fulla.invalid('`amount_minor` must be a whole number of minor units, not zero.');
  end if;
  v_note := btrim(coalesce(p_contribution ->> 'note', ''));
  if char_length(v_note) > 120 then
    perform fulla.invalid('A note must be at most 120 characters.');
  end if;
  insert into fulla.goal_contributions (id, household_id, goal_id, date, amount_minor, note, voided, updated_by)
  values (v_id, p_household_id, v_goal, v_date, v_amount, v_note, fulla.json_bool(p_contribution, 'voided', false), v_me)
  on conflict (id) do update
     set goal_id = excluded.goal_id, date = excluded.date, amount_minor = excluded.amount_minor, note = excluded.note,
         voided = excluded.voided, updated_by = excluded.updated_by, updated_at = now();
  return public.fulla_goals(p_household_id);
end;
$$;

create or replace function fulla.erase_household(p_household_id uuid) returns void
language plpgsql volatile
as $$
begin
  perform set_config('fulla.erasing_household', p_household_id::text, true);
  delete from fulla.category_examples where household_id = p_household_id;
  delete from fulla.recurring_dismissals where household_id = p_household_id;
  delete from fulla.goal_contributions where household_id = p_household_id;
  delete from fulla.goals where household_id = p_household_id;
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
  select 33;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_goals(uuid) from public, anon;
revoke all on function public.fulla_goal_upsert(uuid, jsonb) from public, anon;
revoke all on function public.fulla_goal_contribution_save(uuid, jsonb) from public, anon;
grant execute on function public.fulla_goals(uuid) to authenticated;
grant execute on function public.fulla_goal_upsert(uuid, jsonb) to authenticated;
grant execute on function public.fulla_goal_contribution_save(uuid, jsonb) to authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
