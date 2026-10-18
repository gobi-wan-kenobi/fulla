-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Money that comes in but is not the household's income. A government grant
-- paid into an RESP (CESG and the like) is the account's, kept there and
-- counted in its balance, but it is not what the household earns, so the
-- Overview leaves it out of the month's income. A category says so with
-- excluded_from_income; the web fork starts every household with one such
-- category, Government grants under Investment income.
--
-- Clients that do not know the column ignore it; a category saved without it
-- keeps what it had (save_category never writes it).

alter table fulla.categories add column excluded_from_income boolean not null default false;

-- fulla.web_defaults() is testdata/defaults/web-categories.json again: Government grants under Investment income.
create or replace function fulla.web_defaults() returns jsonb
language sql immutable
as $$
  select '{"categories":[{"key":"debt_payments","applies_to":"expense","icon":"account_balance","color_index":9,"fixed":true,"name":{"en":"Debt payments","es":"Pago de deudas","fr":"Remboursements","de":"Schuldentilgung","it":"Rate dei debiti","pt":"Pagamento de dívidas"},"subcategories":[{"key":"card_interest","name":{"en":"Credit card interest","es":"Intereses de tarjeta","fr":"Intérêts de carte de crédit","de":"Kreditkartenzinsen","it":"Interessi carta di credito","pt":"Juros do cartão de crédito"},"fixed":false},{"key":"personal_loan","name":{"en":"Personal loan","es":"Préstamo personal","fr":"Prêt personnel","de":"Privatkredit","it":"Prestito personale","pt":"Empréstimo pessoal"}},{"key":"line_of_credit","name":{"en":"Line of credit","es":"Línea de crédito","fr":"Marge de crédit","de":"Kreditlinie","it":"Linea di credito","pt":"Linha de crédito"}},{"key":"bnpl","name":{"en":"Buy now pay later","es":"Compra ahora, paga después","fr":"Achat maintenant, paiement plus tard","de":"Jetzt kaufen, später zahlen","it":"Compra ora, paga dopo","pt":"Compre agora, pague depois"}},{"key":"student_loan","name":{"en":"Student loan","es":"Préstamo estudiantil","fr":"Prêt étudiant","de":"Studienkredit","it":"Prestito studentesco","pt":"Empréstimo estudantil"}},{"key":"car_loan","name":{"en":"Car loan","es":"Préstamo del coche","fr":"Prêt auto","de":"Autokredit","it":"Prestito auto","pt":"Empréstimo automóvel"}},{"key":"other_debt","name":{"en":"Other debt","es":"Otras deudas","fr":"Autres dettes","de":"Sonstige Schulden","it":"Altri debiti","pt":"Outras dívidas"}}]},{"key":"insurance","applies_to":"expense","icon":"shield","color_index":10,"fixed":true,"name":{"en":"Insurance","es":"Seguros","fr":"Assurances","de":"Versicherungen","it":"Assicurazioni","pt":"Seguros"},"subcategories":[{"key":"life_insurance","name":{"en":"Life insurance","es":"Seguro de vida","fr":"Assurance vie","de":"Lebensversicherung","it":"Assicurazione vita","pt":"Seguro de vida"}},{"key":"home_insurance","name":{"en":"Home insurance","es":"Seguro del hogar","fr":"Assurance habitation","de":"Hausratversicherung","it":"Assicurazione casa","pt":"Seguro residencial"}},{"key":"auto_insurance","name":{"en":"Auto insurance","es":"Seguro del coche","fr":"Assurance auto","de":"Kfz-Versicherung","it":"Assicurazione auto","pt":"Seguro automóvel"}},{"key":"health_insurance","name":{"en":"Health insurance","es":"Seguro médico","fr":"Assurance santé","de":"Krankenversicherung","it":"Assicurazione sanitaria","pt":"Seguro de saúde"}}]},{"key":"interest","applies_to":"income","icon":"savings","color_index":7,"name":{"en":"Interest","es":"Intereses","fr":"Intérêts","de":"Zinsen","it":"Interessi","pt":"Juros"}},{"key":"fees","applies_to":"expense","icon":"receipt","color_index":11,"name":{"en":"Fees","es":"Comisiones","fr":"Frais","de":"Gebühren","it":"Commissioni","pt":"Tarifas"}},{"key":"investment_income","applies_to":"income","icon":"savings","color_index":8,"name":{"en":"Investment income","es":"Rendimientos de inversión","fr":"Revenus de placement","de":"Kapitalerträge","it":"Redditi da investimenti","pt":"Rendimentos de investimentos"},"subcategories":[{"key":"grants","name":{"en":"Government grants","es":"Subvenciones públicas","fr":"Subventions gouvernementales","de":"Staatliche Zuschüsse","it":"Contributi pubblici","pt":"Subsídios governamentais"},"excluded_from_income":true}]}]}'::jsonb;
$$;

-- A new household's subcategories carry the flag the defaults give them.
do $$
declare
  v_def text := pg_get_functiondef('fulla.seed_defaults(uuid, text)'::regprocedure);
  v_cols text := 'insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed)';
  v_vals text := 'coalesce((s ->> ''fixed'')::boolean, (c ->> ''fixed'')::boolean, false));';
begin
  if position(v_cols in v_def) = 0 or position(v_vals in v_def) = 0 then
    raise exception 'seed_defaults: subcategory insert not found';
  end if;
  v_def := replace(v_def, v_cols, 'insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed, excluded_from_income)');
  v_def := replace(v_def, v_vals, 'coalesce((s ->> ''fixed'')::boolean, (c ->> ''fixed'')::boolean, false), coalesce((s ->> ''excluded_from_income'')::boolean, false));');
  execute v_def;
end;
$$;

-- Every household with an Investment income category gets Government grants under it, unless it has one by that name.
do $$
declare
  h record;
  v_lang text;
  v_parent text;
  v_sub text;
  v_id uuid;
begin
  for h in select id, locale from fulla.households loop
    v_lang := fulla.lang_of(h.locale);
    select value -> 'name' ->> v_lang into v_parent from jsonb_array_elements(fulla.web_defaults() -> 'categories') where value ->> 'key' = 'investment_income';
    select value -> 'name' ->> v_lang into v_sub
      from jsonb_array_elements((select value -> 'subcategories' from jsonb_array_elements(fulla.web_defaults() -> 'categories') where value ->> 'key' = 'investment_income'))
     where value ->> 'key' = 'grants';
    select k.id into v_id from fulla.categories k
     where k.household_id = h.id and k.parent_id is null and not k.archived and lower(k.name) = lower(v_parent) limit 1;
    if v_id is null then
      continue;
    end if;
    if exists (select 1 from fulla.categories k where k.parent_id = v_id and lower(k.name) = lower(v_sub)) then
      update fulla.categories set excluded_from_income = true where parent_id = v_id and lower(name) = lower(v_sub);
    else
      insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed, excluded_from_income)
      select gen_random_uuid(), h.id, v_id, v_sub, p.applies_to, p.icon, p.color_index,
             coalesce((select max(sort) + 1 from fulla.categories k where k.parent_id = v_id), 0), false, true
        from fulla.categories p where p.id = v_id;
    end if;
  end loop;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 30;
$$;
revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
