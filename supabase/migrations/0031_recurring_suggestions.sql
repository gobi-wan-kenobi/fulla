-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Recurring items the app suggests from what repeats (the web fork's Insights:
-- a merchant charged every week, fortnight, month or year; a pay deposit).
-- A suggestion the household confirms becomes a fulla.recurring_rules row
-- through fulla_recurring_upsert, as any recurring item, written with
-- auto_create off so nothing is ever written on its behalf. A suggestion the
-- household dismisses is remembered here, so it is not offered again; it can
-- be offered again by setting `dismissed` back to false. Nothing is deleted
-- (every table refuses DELETE outside erasing a household).
--
-- `key` is how the client names a suggestion: its kind and the merchant as
-- the statement text cleans up to ("expense:netflix"). The database does not
-- interpret it.

create table fulla.recurring_dismissals (
  household_id  uuid not null references fulla.households (id),
  key           text not null check (char_length(key) between 1 and 120),
  dismissed     boolean not null default true,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  primary key (household_id, key),
  foreign key (household_id, updated_by) references fulla.members (household_id, id)
);

alter table fulla.recurring_dismissals enable row level security;
revoke all on fulla.recurring_dismissals from public, anon, authenticated;

create policy recurring_dismissals_members_read on fulla.recurring_dismissals
  for select to authenticated using (fulla.is_active_member(household_id));

create trigger recurring_dismissals_forbid_delete
  before delete on fulla.recurring_dismissals
  for each row execute function fulla.forbid_delete();

-- The keys this household has dismissed, in order.
create function public.fulla_recurring_dismissals(p_household_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform fulla.require_member(p_household_id, 'member');
  return coalesce((
    select jsonb_agg(d.key order by d.key collate "C")
      from fulla.recurring_dismissals d where d.household_id = p_household_id and d.dismissed), '[]'::jsonb);
end;
$$;

-- Dismisses a suggestion (or, with p_dismissed false, offers it again). An
-- admin's call, as confirming one is (fulla_recurring_upsert). Returns the
-- dismissed keys.
create function public.fulla_recurring_dismiss(p_household_id uuid, p_key text, p_dismissed boolean default true) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_key text := btrim(coalesce(p_key, ''));
begin
  v_me := (fulla.require_member(p_household_id, 'admin')).id;
  if char_length(v_key) not between 1 and 120 then
    perform fulla.invalid('A suggestion''s key must be 1 to 120 characters.');
  end if;
  insert into fulla.recurring_dismissals (household_id, key, dismissed, updated_by)
  values (p_household_id, v_key, coalesce(p_dismissed, true), v_me)
  on conflict (household_id, key) do update
     set dismissed = excluded.dismissed, updated_by = excluded.updated_by, updated_at = now();
  return public.fulla_recurring_dismissals(p_household_id);
end;
$$;

create or replace function fulla.erase_household(p_household_id uuid) returns void
language plpgsql volatile
as $$
begin
  perform set_config('fulla.erasing_household', p_household_id::text, true);
  delete from fulla.category_examples where household_id = p_household_id;
  delete from fulla.recurring_dismissals where household_id = p_household_id;
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
  select 31;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_recurring_dismissals(uuid) from public, anon;
revoke all on function public.fulla_recurring_dismiss(uuid, text, boolean) from public, anon;
grant execute on function public.fulla_recurring_dismissals(uuid) to authenticated;
grant execute on function public.fulla_recurring_dismiss(uuid, text, boolean) to authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
