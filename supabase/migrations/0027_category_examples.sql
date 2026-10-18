-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Labelled examples: every time someone moves a transaction to another
-- category (one edit, a bulk edit, sorting one from Review, or changing a
-- line in the import preview), what it was and what it became. A future
-- categorizer can learn from them; they stay in the household's database and
-- are never exported anywhere by the app.
--
-- What is kept of the line is only what a categorizer may read: the
-- description scrubbed by the web server (src/lib/server/sanitize.ts: no
-- people, numbers or bank names), money in or out, an amount band and the
-- day of the month. Never the amount, the date or the account. The function
-- refuses a description that still holds a run of digits or an address.
--
-- Written only through fulla_category_examples_save; read only by the
-- household's members through fulla_category_examples.

create table fulla.category_examples (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references fulla.households (id),
  description      text not null check (char_length(description) between 1 and 200),
  direction        text not null check (direction in ('in', 'out')),
  amount_band      text not null check (char_length(amount_band) between 1 and 40),
  day_of_month     smallint check (day_of_month between 1 and 31),
  from_category_id uuid,
  from_label       text check (char_length(from_label) <= 130),
  from_source      text not null check (from_source in ('rule', 'merchant', 'debt', 'file', 'jev', 'model', 'user', 'none')),
  from_confidence  real check (from_confidence between 0 and 1),
  to_category_id   uuid not null,
  to_label         text not null check (char_length(to_label) <= 130),
  via              text not null check (via in ('edit', 'bulk', 'review', 'import')),
  created_by       uuid,
  created_at       timestamptz not null default now()
);
create index category_examples_household on fulla.category_examples (household_id, created_at);

alter table fulla.category_examples enable row level security;
revoke all on fulla.category_examples from public, anon, authenticated;

create trigger category_examples_forbid_delete
  before delete on fulla.category_examples
  for each row execute function fulla.forbid_delete();

-- "Parent › Sub", or the name alone, of one of the household's categories; null when it is not one.
create function fulla.category_label(p_household_id uuid, p_id uuid) returns text
language sql stable
as $$
  select left(case when p.id is null then c.name else p.name || ' › ' || c.name end, 130)
    from fulla.categories c
    left join fulla.categories p on p.household_id = c.household_id and p.id = c.parent_id
   where c.household_id = p_household_id and c.id = p_id;
$$;

create function public.fulla_category_examples_save(p_household_id uuid, p_examples jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  e jsonb;
  v_desc text;
  v_from uuid;
  v_to uuid;
  v_from_label text;
  v_to_label text;
  v_conf real;
  v_day smallint;
  n integer := 0;
begin
  perform fulla.require_member(p_household_id, 'member');
  if jsonb_typeof(p_examples) <> 'array' then
    perform fulla.invalid('`examples` must be an array.');
  end if;
  if jsonb_array_length(p_examples) > 200 then
    perform fulla.invalid('At most 200 examples at a time.');
  end if;
  for e in select value from jsonb_array_elements(p_examples) loop
    if jsonb_typeof(e) <> 'object' then
      perform fulla.invalid('An example must be an object.');
    end if;
    v_desc := btrim(coalesce(e ->> 'description', ''));
    if v_desc = '' or char_length(v_desc) > 200 then
      perform fulla.invalid('`description` must be 1 to 200 characters.');
    end if;
    -- Scrubbed means scrubbed: no account or card numbers, references, phone numbers or addresses.
    if v_desc ~ '[0-9]{4,}' or v_desc ~ '@' then
      perform fulla.invalid('`description` must be scrubbed (no numbers of four digits or more, no addresses).');
    end if;
    if coalesce(e ->> 'direction', '') not in ('in', 'out') then
      perform fulla.invalid('`direction` must be in or out.');
    end if;
    if char_length(coalesce(e ->> 'amount_band', '')) not between 1 and 40 then
      perform fulla.invalid('`amount_band` must be 1 to 40 characters.');
    end if;
    v_day := fulla.json_int(e, 'day_of_month', null, 1, 31);
    v_from := fulla.json_uuid(e, 'from_category_id');
    v_to := fulla.json_uuid(e, 'to_category_id');
    v_from_label := case when v_from is null then null else fulla.category_label(p_household_id, v_from) end;
    v_to_label := case when v_to is null then null else fulla.category_label(p_household_id, v_to) end;
    if v_from is not null and v_from_label is null then
      perform fulla.invalid('`from_category_id` must be a category of this household.');
    end if;
    if v_to_label is null then
      perform fulla.invalid('`to_category_id` must be a category of this household.');
    end if;
    if coalesce(e ->> 'from_source', '') not in ('rule', 'merchant', 'debt', 'file', 'jev', 'model', 'user', 'none') then
      perform fulla.invalid('`from_source` must be rule, merchant, debt, file, jev, model, user or none.');
    end if;
    if coalesce(e ->> 'via', '') not in ('edit', 'bulk', 'review', 'import') then
      perform fulla.invalid('`via` must be edit, bulk, review or import.');
    end if;
    v_conf := null;
    if e ? 'from_confidence' and jsonb_typeof(e -> 'from_confidence') = 'number' then
      v_conf := (e ->> 'from_confidence')::real;
      if v_conf < 0 or v_conf > 1 then
        perform fulla.invalid('`from_confidence` must be between 0 and 1.');
      end if;
    end if;
    insert into fulla.category_examples (household_id, description, direction, amount_band, day_of_month, from_category_id,
                                         from_label, from_source, from_confidence, to_category_id, to_label, via, created_by)
    values (p_household_id, v_desc, e ->> 'direction', e ->> 'amount_band', v_day, v_from, v_from_label, e ->> 'from_source',
            v_conf, v_to, v_to_label, e ->> 'via', auth.uid());
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end;
$$;

-- The household's examples, newest first (at most the last 1,000).
create function public.fulla_category_examples(p_household_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform fulla.require_member(p_household_id, 'member');
  return coalesce((
    select jsonb_agg(to_jsonb(x) - 'household_id' - 'created_by' order by x.created_at desc)
      from (select * from fulla.category_examples e where e.household_id = p_household_id
             order by e.created_at desc limit 1000) x), '[]'::jsonb);
end;
$$;

create or replace function fulla.erase_household(p_household_id uuid) returns void
language plpgsql volatile
as $$
begin
  perform set_config('fulla.erasing_household', p_household_id::text, true);
  delete from fulla.category_examples where household_id = p_household_id;
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
  select 27;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_category_examples_save(uuid, jsonb) from public, anon;
revoke all on function public.fulla_category_examples(uuid) from public, anon;
grant execute on function public.fulla_category_examples_save(uuid, jsonb) to authenticated;
grant execute on function public.fulla_category_examples(uuid) to authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
