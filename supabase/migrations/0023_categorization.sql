-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Categorisation, as the web app does it: household rules can be deleted, and
-- a category can say its spending is fixed (rent, phone, insurance) rather
-- than flexible (eating out, shopping).
--
-- Deleting a rule is archiving it, as for recurring items (0021): every table
-- refuses DELETE, and `archived` hides the rule and stops it matching. A
-- category's `fixed` is the default a transaction gets when it is put in that
-- category; each transaction keeps its own `recurrence` ('fixed' or
-- 'variable'), which is what totals count, so one bill can still differ from
-- its category.
--
-- Both columns reach the household's config unchanged (it is built from
-- to_jsonb of the row). Same rule as the opening balance (0015): a save that
-- leaves the key out keeps what is stored, so a phone that has not heard of
-- either cannot undo it. No new table, so nothing new for row-level security.

alter table fulla.categorization_rules add column archived boolean not null default false;
alter table fulla.categories add column fixed boolean not null default false;

create or replace function fulla.save_rule(p_household_id uuid, p jsonb) returns uuid
language plpgsql volatile
as $$
declare
  v_id uuid := fulla.item_id(p_household_id, 'fulla.categorization_rules', p);
  v_pattern text := btrim(coalesce(p ->> 'pattern', ''));
  v_action jsonb := p -> 'action';
  v_out jsonb := '{}'::jsonb;
  v_category uuid;
  v_to_account uuid;
  v_archived boolean;
begin
  if char_length(v_pattern) not between 1 and 100 then
    perform fulla.invalid('A rule''s pattern must be 1 to 100 characters.');
  end if;
  if jsonb_typeof(v_action) <> 'object' then
    perform fulla.invalid('`action` must be an object.');
  end if;
  v_category := fulla.json_uuid(v_action, 'category_id');
  if v_category is not null then
    if not exists (select 1 from fulla.categories c where c.household_id = p_household_id and c.id = v_category) then
      perform fulla.invalid('That category does not exist in this household.');
    end if;
    v_out := v_out || jsonb_build_object('category_id', v_category);
  end if;
  if v_action ? 'kind' then
    if v_action ->> 'kind' not in ('expense', 'income', 'transfer') then
      perform fulla.invalid('A rule can set the kind to expense, income or transfer.');
    end if;
    v_out := v_out || jsonb_build_object('kind', v_action ->> 'kind');
  end if;
  v_to_account := fulla.json_uuid(v_action, 'to_account_id');
  if v_action ->> 'kind' = 'transfer' and v_to_account is null then
    perform fulla.invalid('A rule that makes a transfer needs `to_account_id`.');
  end if;
  if v_to_account is not null then
    if not exists (select 1 from fulla.accounts a where a.household_id = p_household_id and a.id = v_to_account) then
      perform fulla.invalid('That account does not exist in this household.');
    end if;
    v_out := v_out || jsonb_build_object('to_account_id', v_to_account);
  end if;
  if v_action ? 'tags' then
    if jsonb_typeof(v_action -> 'tags') <> 'array' then
      perform fulla.invalid('`tags` must be a list.');
    end if;
    v_out := v_out || jsonb_build_object('tags', v_action -> 'tags');
  end if;
  if v_out = '{}'::jsonb then
    perform fulla.invalid('A rule must do something: set a category, a kind or tags.');
  end if;
  v_archived := fulla.json_bool(p, 'archived', null);

  insert into fulla.categorization_rules (id, household_id, pattern, action, sort, active, archived)
  values (v_id, p_household_id, v_pattern, v_out, fulla.json_int(p, 'sort', 0, -1000000, 1000000),
          fulla.json_bool(p, 'active', true), coalesce(v_archived, false))
  on conflict (id) do update
     set pattern = excluded.pattern, action = excluded.action, sort = excluded.sort, active = excluded.active,
         archived = coalesce(v_archived, fulla.categorization_rules.archived);
  return v_id;
end;
$$;

create or replace function fulla.save_category(p_household_id uuid, p jsonb) returns uuid
language plpgsql volatile
as $$
declare
  v_id uuid := fulla.item_id(p_household_id, 'fulla.categories', p);
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_parent uuid := fulla.json_uuid(p, 'parent_id');
  v_applies text := coalesce(p ->> 'applies_to', 'expense');
  v_icon text := coalesce(p ->> 'icon', 'label');
  v_archived boolean := fulla.json_bool(p, 'archived', false);
  v_fixed boolean := fulla.json_bool(p, 'fixed', null);
begin
  if char_length(v_name) not between 1 and 40 then
    perform fulla.invalid('A category name must be 1 to 40 characters.');
  end if;
  if v_applies not in ('expense', 'income', 'both') then
    perform fulla.invalid('`applies_to` must be expense, income or both.');
  end if;
  if v_icon !~ '^[a-z0-9_]{1,40}$' then
    perform fulla.invalid('`icon` must be a Material Symbols name.');
  end if;
  if v_parent is not null then
    if v_parent = v_id then
      perform fulla.invalid('A category cannot be its own parent.');
    end if;
    if not exists (select 1 from fulla.categories c
                    where c.household_id = p_household_id and c.id = v_parent and c.parent_id is null) then
      perform fulla.invalid('The parent must be a top-level category of this household.');
    end if;
    if exists (select 1 from fulla.categories c where c.household_id = p_household_id and c.parent_id = v_id) then
      perform fulla.invalid('A category with subcategories cannot become a subcategory.');
    end if;
  end if;
  if not v_archived and exists (
    select 1 from fulla.categories c
     where c.household_id = p_household_id and c.id <> v_id and not c.archived
       and c.parent_id is not distinct from v_parent
       and fulla.normalize_name(c.name) = fulla.normalize_name(v_name)
  ) then
    perform fulla.invalid(format('There is already a category called «%s» here.', v_name));
  end if;

  insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, archived, fixed)
  values (v_id, p_household_id, v_parent, v_name, v_applies, v_icon,
          fulla.json_int(p, 'color_index', 0, 0, 11), fulla.json_int(p, 'sort', 0, -1000000, 1000000), v_archived,
          coalesce(v_fixed, false))
  on conflict (id) do update
     set parent_id = excluded.parent_id, name = excluded.name, applies_to = excluded.applies_to,
         icon = excluded.icon, color_index = excluded.color_index, sort = excluded.sort, archived = excluded.archived,
         fixed = coalesce(v_fixed, fulla.categories.fixed);
  return v_id;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 23;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
