-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Two more starting categories of the web fork. Insurance (fixed): life,
-- home, auto and health premiums, which used to fall to Other. Interest
-- (income): interest a bank pays, which used to fall to Other income.
-- fulla.web_defaults() is testdata/defaults/web-categories.json again, and a
-- household that has neither yet gets them now, after its other categories
-- (the same rows a new household gets; a category it already has by that
-- name is left alone).

create or replace function fulla.web_defaults() returns jsonb
language sql immutable
as $$
  select '{"categories":[{"key":"debt_payments","applies_to":"expense","icon":"account_balance","color_index":9,"fixed":true,"name":{"en":"Debt payments","es":"Pago de deudas","fr":"Remboursements","de":"Schuldentilgung","it":"Rate dei debiti","pt":"Pagamento de dívidas"},"subcategories":[{"key":"personal_loan","name":{"en":"Personal loan","es":"Préstamo personal","fr":"Prêt personnel","de":"Privatkredit","it":"Prestito personale","pt":"Empréstimo pessoal"}},{"key":"line_of_credit","name":{"en":"Line of credit","es":"Línea de crédito","fr":"Marge de crédit","de":"Kreditlinie","it":"Linea di credito","pt":"Linha de crédito"}},{"key":"bnpl","name":{"en":"Buy now pay later","es":"Compra ahora, paga después","fr":"Achat maintenant, paiement plus tard","de":"Jetzt kaufen, später zahlen","it":"Compra ora, paga dopo","pt":"Compre agora, pague depois"}},{"key":"student_loan","name":{"en":"Student loan","es":"Préstamo estudiantil","fr":"Prêt étudiant","de":"Studienkredit","it":"Prestito studentesco","pt":"Empréstimo estudantil"}},{"key":"car_loan","name":{"en":"Car loan","es":"Préstamo del coche","fr":"Prêt auto","de":"Autokredit","it":"Prestito auto","pt":"Empréstimo automóvel"}},{"key":"other_debt","name":{"en":"Other debt","es":"Otras deudas","fr":"Autres dettes","de":"Sonstige Schulden","it":"Altri debiti","pt":"Outras dívidas"}}]},{"key":"insurance","applies_to":"expense","icon":"shield","color_index":10,"fixed":true,"name":{"en":"Insurance","es":"Seguros","fr":"Assurances","de":"Versicherungen","it":"Assicurazioni","pt":"Seguros"},"subcategories":[{"key":"life_insurance","name":{"en":"Life insurance","es":"Seguro de vida","fr":"Assurance vie","de":"Lebensversicherung","it":"Assicurazione vita","pt":"Seguro de vida"}},{"key":"home_insurance","name":{"en":"Home insurance","es":"Seguro del hogar","fr":"Assurance habitation","de":"Hausratversicherung","it":"Assicurazione casa","pt":"Seguro residencial"}},{"key":"auto_insurance","name":{"en":"Auto insurance","es":"Seguro del coche","fr":"Assurance auto","de":"Kfz-Versicherung","it":"Assicurazione auto","pt":"Seguro automóvel"}},{"key":"health_insurance","name":{"en":"Health insurance","es":"Seguro médico","fr":"Assurance santé","de":"Krankenversicherung","it":"Assicurazione sanitaria","pt":"Seguro de saúde"}}]},{"key":"interest","applies_to":"income","icon":"savings","color_index":7,"name":{"en":"Interest","es":"Intereses","fr":"Intérêts","de":"Zinsen","it":"Interessi","pt":"Juros"}}]}'::jsonb;
$$;

do $$
declare
  h record;
  c jsonb;
  s jsonb;
  v_lang text;
  v_parent uuid;
  v_sort integer;
  j integer;
begin
  for h in select id, locale from fulla.households loop
    v_lang := fulla.lang_of(h.locale);
    for c in select value from jsonb_array_elements(fulla.web_defaults() -> 'categories')
             where value ->> 'key' in ('insurance', 'interest') loop
      if exists (select 1 from fulla.categories k where k.household_id = h.id and k.parent_id is null
                   and lower(k.name) = lower(c -> 'name' ->> v_lang)) then
        continue;
      end if;
      select coalesce(max(sort), -1) + 1 into v_sort from fulla.categories k where k.household_id = h.id and k.parent_id is null;
      v_parent := gen_random_uuid();
      insert into fulla.categories (id, household_id, name, applies_to, icon, color_index, sort, fixed)
      values (v_parent, h.id, c -> 'name' ->> v_lang, c ->> 'applies_to', c ->> 'icon', (c ->> 'color_index')::smallint,
              v_sort, coalesce((c ->> 'fixed')::boolean, false));
      j := 0;
      for s in select value from jsonb_array_elements(coalesce(c -> 'subcategories', '[]'::jsonb)) loop
        insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed)
        values (gen_random_uuid(), h.id, v_parent, s -> 'name' ->> v_lang, c ->> 'applies_to', c ->> 'icon',
                (c ->> 'color_index')::smallint, j, coalesce((c ->> 'fixed')::boolean, false));
        j := j + 1;
      end loop;
    end loop;
  end loop;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 26;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
