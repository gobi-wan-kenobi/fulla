-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Subcategories under a shared starting category: Subscriptions gets Software
-- and Streaming & entertainment. The shared defaults (fulla.defaults(), whose
-- shape the phone shares) have no subcategories, so they live in
-- fulla.web_defaults() as "shared_subcategories": the parent's key and its
-- subcategories. fulla.web_defaults() is testdata/defaults/web-categories.json
-- again; a new household gets them under its Subscriptions, and a household
-- that has Subscriptions (by its name in the household's language, or in
-- English) gets the ones it does not have yet, after its other subcategories.
-- Nothing is moved: what was filed under Subscriptions stays there.

create or replace function fulla.web_defaults() returns jsonb
language sql immutable
as $$
  select '{"categories":[{"key":"debt_payments","applies_to":"expense","icon":"account_balance","color_index":9,"fixed":true,"name":{"en":"Debt payments","es":"Pago de deudas","fr":"Remboursements","de":"Schuldentilgung","it":"Rate dei debiti","pt":"Pagamento de dívidas"},"subcategories":[{"key":"card_interest","name":{"en":"Credit card interest","es":"Intereses de tarjeta","fr":"Intérêts de carte de crédit","de":"Kreditkartenzinsen","it":"Interessi carta di credito","pt":"Juros do cartão de crédito"},"fixed":false},{"key":"personal_loan","name":{"en":"Personal loan","es":"Préstamo personal","fr":"Prêt personnel","de":"Privatkredit","it":"Prestito personale","pt":"Empréstimo pessoal"}},{"key":"line_of_credit","name":{"en":"Line of credit","es":"Línea de crédito","fr":"Marge de crédit","de":"Kreditlinie","it":"Linea di credito","pt":"Linha de crédito"}},{"key":"bnpl","name":{"en":"Buy now pay later","es":"Compra ahora, paga después","fr":"Achat maintenant, paiement plus tard","de":"Jetzt kaufen, später zahlen","it":"Compra ora, paga dopo","pt":"Compre agora, pague depois"}},{"key":"student_loan","name":{"en":"Student loan","es":"Préstamo estudiantil","fr":"Prêt étudiant","de":"Studienkredit","it":"Prestito studentesco","pt":"Empréstimo estudantil"}},{"key":"car_loan","name":{"en":"Car loan","es":"Préstamo del coche","fr":"Prêt auto","de":"Autokredit","it":"Prestito auto","pt":"Empréstimo automóvel"}},{"key":"other_debt","name":{"en":"Other debt","es":"Otras deudas","fr":"Autres dettes","de":"Sonstige Schulden","it":"Altri debiti","pt":"Outras dívidas"}}]},{"key":"insurance","applies_to":"expense","icon":"shield","color_index":10,"fixed":true,"name":{"en":"Insurance","es":"Seguros","fr":"Assurances","de":"Versicherungen","it":"Assicurazioni","pt":"Seguros"},"subcategories":[{"key":"life_insurance","name":{"en":"Life insurance","es":"Seguro de vida","fr":"Assurance vie","de":"Lebensversicherung","it":"Assicurazione vita","pt":"Seguro de vida"}},{"key":"home_insurance","name":{"en":"Home insurance","es":"Seguro del hogar","fr":"Assurance habitation","de":"Hausratversicherung","it":"Assicurazione casa","pt":"Seguro residencial"}},{"key":"auto_insurance","name":{"en":"Auto insurance","es":"Seguro del coche","fr":"Assurance auto","de":"Kfz-Versicherung","it":"Assicurazione auto","pt":"Seguro automóvel"}},{"key":"health_insurance","name":{"en":"Health insurance","es":"Seguro médico","fr":"Assurance santé","de":"Krankenversicherung","it":"Assicurazione sanitaria","pt":"Seguro de saúde"}}]},{"key":"interest","applies_to":"income","icon":"savings","color_index":7,"name":{"en":"Interest","es":"Intereses","fr":"Intérêts","de":"Zinsen","it":"Interessi","pt":"Juros"}},{"key":"fees","applies_to":"expense","icon":"receipt","color_index":11,"name":{"en":"Fees","es":"Comisiones","fr":"Frais","de":"Gebühren","it":"Commissioni","pt":"Tarifas"}},{"key":"investment_income","applies_to":"income","icon":"savings","color_index":8,"name":{"en":"Investment income","es":"Rendimientos de inversión","fr":"Revenus de placement","de":"Kapitalerträge","it":"Redditi da investimenti","pt":"Rendimentos de investimentos"},"subcategories":[{"key":"grants","name":{"en":"Government grants","es":"Subvenciones públicas","fr":"Subventions gouvernementales","de":"Staatliche Zuschüsse","it":"Contributi pubblici","pt":"Subsídios governamentais"},"excluded_from_income":true}]}],"shared_subcategories":[{"parent":"subscriptions","subcategories":[{"key":"software","name":{"en":"Software","es":"Software","fr":"Logiciels","de":"Software","it":"Software","pt":"Software"}},{"key":"streaming","name":{"en":"Streaming & entertainment","es":"Streaming y entretenimiento","fr":"Streaming et divertissement","de":"Streaming & Unterhaltung","it":"Streaming e intrattenimento","pt":"Streaming e entretenimento"}}]}]}'::jsonb;
$$;

-- The shared subcategories for one household: under the top-level category
-- that is the parent's default (by name in the household's language or in
-- English), each one it does not have by that name yet.
create or replace function fulla.seed_shared_subcategories(p_household_id uuid, p_lang text) returns void
language plpgsql
as $$
declare
  g jsonb;
  s jsonb;
  v_parent fulla.categories;
  v_names text[];
  v_sort integer;
begin
  for g in select value from jsonb_array_elements(coalesce(fulla.web_defaults() -> 'shared_subcategories', '[]'::jsonb)) loop
    select array[lower(d.value -> 'name' ->> p_lang), lower(d.value -> 'name' ->> 'en')] into v_names
      from jsonb_array_elements(fulla.defaults() -> 'categories') d where d.value ->> 'key' = g ->> 'parent';
    if v_names is null then continue; end if;
    select * into v_parent from fulla.categories k
      where k.household_id = p_household_id and k.parent_id is null and not k.archived and lower(k.name) = any(v_names)
      order by k.sort limit 1;
    if v_parent.id is null then continue; end if;
    for s in select value from jsonb_array_elements(coalesce(g -> 'subcategories', '[]'::jsonb)) loop
      if exists (select 1 from fulla.categories k where k.household_id = p_household_id and k.parent_id = v_parent.id
                   and lower(k.name) = lower(s -> 'name' ->> p_lang)) then
        continue;
      end if;
      select coalesce(max(sort), -1) + 1 into v_sort from fulla.categories k where k.household_id = p_household_id and k.parent_id = v_parent.id;
      insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed)
      values (gen_random_uuid(), p_household_id, v_parent.id, s -> 'name' ->> p_lang, v_parent.applies_to, v_parent.icon,
              v_parent.color_index, v_sort, coalesce((s ->> 'fixed')::boolean, v_parent.fixed));
    end loop;
  end loop;
end;
$$;

-- A new household gets them too: seed_defaults calls it before its accounts.
do $$
declare
  v_def text := pg_get_functiondef('fulla.seed_defaults(uuid, text)'::regprocedure);
  v_at text := 'for c in select value from jsonb_array_elements(fulla.defaults() -> ''accounts'') loop';
begin
  if position(v_at in v_def) = 0 then
    raise exception 'seed_defaults: accounts loop not found';
  end if;
  v_def := replace(v_def, v_at, 'perform fulla.seed_shared_subcategories(p_household_id, v_lang);
  ' || v_at);
  execute v_def;
end;
$$;

do $$
declare
  h record;
begin
  for h in select id, locale from fulla.households loop
    perform fulla.seed_shared_subcategories(h.id, fulla.lang_of(h.locale));
  end loop;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 35;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
