-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Card and investment statements. Three more starting categories of the web
-- fork: Fees (a card's annual fee, an account fee), Investment income
-- (dividends and distributions) and, under Debt payments, Credit card
-- interest. fulla.web_defaults() is testdata/defaults/web-categories.json
-- again; every household that has none of them by name gets them now.
--
-- An investment account's number has letters ("HQ0X0EXAMPLE1CAD"): its last
-- four letters and digits identify it the way a card's last four digits do,
-- so accounts.last4 now takes four upper-case letters or digits.

alter table fulla.accounts drop constraint accounts_last4_check;
alter table fulla.accounts add constraint accounts_last4_check check (last4 is null or last4 ~ '^[0-9A-Z]{4}$');

-- save_account (0025) checks the same rule: the same function, with the wider pattern.
do $$
declare
  v_def text := pg_get_functiondef('fulla.save_account(uuid, jsonb)'::regprocedure);
begin
  if position('^[0-9]{4}$' in v_def) = 0 then
    raise exception 'save_account: last4 check not found';
  end if;
  v_def := replace(v_def, '^[0-9]{4}$', '^[0-9A-Z]{4}$');
  v_def := replace(v_def, 'must be the last four digits of the account number, nothing more.',
                   'must be the last four digits (or letters and digits) of the account number, nothing more.');
  execute v_def;
end;
$$;

-- A subcategory may say it is not fixed when its parent is (Credit card interest under Debt payments).
do $$
declare
  v_def text := pg_get_functiondef('fulla.seed_defaults(uuid, text)'::regprocedure);
  v_old text := 'j, coalesce((c ->> ''fixed'')::boolean, false)';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'seed_defaults: subcategory fixed not found';
  end if;
  execute replace(v_def, v_old, 'j, coalesce((s ->> ''fixed'')::boolean, (c ->> ''fixed'')::boolean, false)');
end;
$$;

create or replace function fulla.web_defaults() returns jsonb
language sql immutable
as $$
  select '{"categories":[{"key":"debt_payments","applies_to":"expense","icon":"account_balance","color_index":9,"fixed":true,"name":{"en":"Debt payments","es":"Pago de deudas","fr":"Remboursements","de":"Schuldentilgung","it":"Rate dei debiti","pt":"Pagamento de dívidas"},"subcategories":[{"key":"card_interest","name":{"en":"Credit card interest","es":"Intereses de tarjeta","fr":"Intérêts de carte de crédit","de":"Kreditkartenzinsen","it":"Interessi carta di credito","pt":"Juros do cartão de crédito"},"fixed":false},{"key":"personal_loan","name":{"en":"Personal loan","es":"Préstamo personal","fr":"Prêt personnel","de":"Privatkredit","it":"Prestito personale","pt":"Empréstimo pessoal"}},{"key":"line_of_credit","name":{"en":"Line of credit","es":"Línea de crédito","fr":"Marge de crédit","de":"Kreditlinie","it":"Linea di credito","pt":"Linha de crédito"}},{"key":"bnpl","name":{"en":"Buy now pay later","es":"Compra ahora, paga después","fr":"Achat maintenant, paiement plus tard","de":"Jetzt kaufen, später zahlen","it":"Compra ora, paga dopo","pt":"Compre agora, pague depois"}},{"key":"student_loan","name":{"en":"Student loan","es":"Préstamo estudiantil","fr":"Prêt étudiant","de":"Studienkredit","it":"Prestito studentesco","pt":"Empréstimo estudantil"}},{"key":"car_loan","name":{"en":"Car loan","es":"Préstamo del coche","fr":"Prêt auto","de":"Autokredit","it":"Prestito auto","pt":"Empréstimo automóvel"}},{"key":"other_debt","name":{"en":"Other debt","es":"Otras deudas","fr":"Autres dettes","de":"Sonstige Schulden","it":"Altri debiti","pt":"Outras dívidas"}}]},{"key":"insurance","applies_to":"expense","icon":"shield","color_index":10,"fixed":true,"name":{"en":"Insurance","es":"Seguros","fr":"Assurances","de":"Versicherungen","it":"Assicurazioni","pt":"Seguros"},"subcategories":[{"key":"life_insurance","name":{"en":"Life insurance","es":"Seguro de vida","fr":"Assurance vie","de":"Lebensversicherung","it":"Assicurazione vita","pt":"Seguro de vida"}},{"key":"home_insurance","name":{"en":"Home insurance","es":"Seguro del hogar","fr":"Assurance habitation","de":"Hausratversicherung","it":"Assicurazione casa","pt":"Seguro residencial"}},{"key":"auto_insurance","name":{"en":"Auto insurance","es":"Seguro del coche","fr":"Assurance auto","de":"Kfz-Versicherung","it":"Assicurazione auto","pt":"Seguro automóvel"}},{"key":"health_insurance","name":{"en":"Health insurance","es":"Seguro médico","fr":"Assurance santé","de":"Krankenversicherung","it":"Assicurazione sanitaria","pt":"Seguro de saúde"}}]},{"key":"interest","applies_to":"income","icon":"savings","color_index":7,"name":{"en":"Interest","es":"Intereses","fr":"Intérêts","de":"Zinsen","it":"Interessi","pt":"Juros"}},{"key":"fees","applies_to":"expense","icon":"receipt","color_index":11,"name":{"en":"Fees","es":"Comisiones","fr":"Frais","de":"Gebühren","it":"Commissioni","pt":"Tarifas"}},{"key":"investment_income","applies_to":"income","icon":"savings","color_index":8,"name":{"en":"Investment income","es":"Rendimientos de inversión","fr":"Revenus de placement","de":"Kapitalerträge","it":"Redditi da investimenti","pt":"Rendimentos de investimentos"}}]}'::jsonb;
$$;

do $$
declare
  h record;
  c jsonb;
  v_lang text;
  v_parent uuid;
  v_sort integer;
  v_debt text;
  v_sub text;
begin
  for h in select id, locale from fulla.households loop
    v_lang := fulla.lang_of(h.locale);
    for c in select value from jsonb_array_elements(fulla.web_defaults() -> 'categories')
             where value ->> 'key' in ('fees', 'investment_income') loop
      if exists (select 1 from fulla.categories k where k.household_id = h.id and k.parent_id is null
                   and lower(k.name) = lower(c -> 'name' ->> v_lang)) then
        continue;
      end if;
      select coalesce(max(sort), -1) + 1 into v_sort from fulla.categories k where k.household_id = h.id and k.parent_id is null;
      insert into fulla.categories (id, household_id, name, applies_to, icon, color_index, sort, fixed)
      values (gen_random_uuid(), h.id, c -> 'name' ->> v_lang, c ->> 'applies_to', c ->> 'icon', (c ->> 'color_index')::smallint,
              v_sort, coalesce((c ->> 'fixed')::boolean, false));
    end loop;

    -- Credit card interest, under the household's Debt payments when it has one (not fixed: it changes every month).
    select value -> 'name' ->> v_lang into v_debt from jsonb_array_elements(fulla.web_defaults() -> 'categories') where value ->> 'key' = 'debt_payments';
    select value -> 'name' ->> v_lang into v_sub
      from jsonb_array_elements((select value -> 'subcategories' from jsonb_array_elements(fulla.web_defaults() -> 'categories') where value ->> 'key' = 'debt_payments'))
     where value ->> 'key' = 'card_interest';
    select k.id into v_parent from fulla.categories k
     where k.household_id = h.id and k.parent_id is null and not k.archived and lower(k.name) = lower(v_debt) limit 1;
    if v_parent is not null and not exists (
      select 1 from fulla.categories k where k.parent_id = v_parent and lower(k.name) = lower(v_sub)
    ) then
      update fulla.categories set sort = sort + 1 where parent_id = v_parent;
      insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed)
      select gen_random_uuid(), h.id, v_parent, v_sub, p.applies_to, p.icon, p.color_index, 0, false
        from fulla.categories p where p.id = v_parent;
    end if;
  end loop;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 28;
$$;
revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
