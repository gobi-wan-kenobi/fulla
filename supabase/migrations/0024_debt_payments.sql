-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Debt payments, a starting category of the web fork: repaying loans, lines
-- of credit, student and car loans, and buy-now-pay-later plans. It is
-- spending (the money leaves the household) and fixed (the same every month),
-- with subcategories, so it cannot live in fulla.defaults(), whose shape the
-- phone shares. fulla.web_defaults() is testdata/defaults/web-categories.json
-- verbatim (a test checks the two agree), and a new household gets it after
-- the shared defaults. Existing households are not changed here.

create or replace function fulla.web_defaults() returns jsonb
language sql immutable
as $$
  select '{"categories":[{"key":"debt_payments","applies_to":"expense","icon":"account_balance","color_index":9,"fixed":true,"name":{"en":"Debt payments","es":"Pago de deudas","fr":"Remboursements","de":"Schuldentilgung","it":"Rate dei debiti","pt":"Pagamento de dívidas"},"subcategories":[{"key":"personal_loan","name":{"en":"Personal loan","es":"Préstamo personal","fr":"Prêt personnel","de":"Privatkredit","it":"Prestito personale","pt":"Empréstimo pessoal"}},{"key":"line_of_credit","name":{"en":"Line of credit","es":"Línea de crédito","fr":"Marge de crédit","de":"Kreditlinie","it":"Linea di credito","pt":"Linha de crédito"}},{"key":"bnpl","name":{"en":"Buy now pay later","es":"Compra ahora, paga después","fr":"Achat maintenant, paiement plus tard","de":"Jetzt kaufen, später zahlen","it":"Compra ora, paga dopo","pt":"Compre agora, pague depois"}},{"key":"student_loan","name":{"en":"Student loan","es":"Préstamo estudiantil","fr":"Prêt étudiant","de":"Studienkredit","it":"Prestito studentesco","pt":"Empréstimo estudantil"}},{"key":"car_loan","name":{"en":"Car loan","es":"Préstamo del coche","fr":"Prêt auto","de":"Autokredit","it":"Prestito auto","pt":"Empréstimo automóvel"}},{"key":"other_debt","name":{"en":"Other debt","es":"Otras deudas","fr":"Autres dettes","de":"Sonstige Schulden","it":"Altri debiti","pt":"Outras dívidas"}}]}]}'::jsonb;
$$;

create or replace function fulla.seed_defaults(p_household_id uuid, p_locale text) returns void
language plpgsql
as $$
declare
  v_lang text := fulla.lang_of(p_locale);
  c jsonb;
  s jsonb;
  i integer := 0;
  j integer;
  v_parent uuid;
begin
  for c in select value from jsonb_array_elements(fulla.defaults() -> 'categories') loop
    insert into fulla.categories (id, household_id, name, applies_to, icon, color_index, sort)
    values (gen_random_uuid(), p_household_id, c -> 'name' ->> v_lang, c ->> 'applies_to',
            c ->> 'icon', (c ->> 'color_index')::smallint, i);
    i := i + 1;
  end loop;
  for c in select value from jsonb_array_elements(fulla.web_defaults() -> 'categories') loop
    v_parent := gen_random_uuid();
    insert into fulla.categories (id, household_id, name, applies_to, icon, color_index, sort, fixed)
    values (v_parent, p_household_id, c -> 'name' ->> v_lang, c ->> 'applies_to',
            c ->> 'icon', (c ->> 'color_index')::smallint, i, coalesce((c ->> 'fixed')::boolean, false));
    i := i + 1;
    j := 0;
    for s in select value from jsonb_array_elements(coalesce(c -> 'subcategories', '[]'::jsonb)) loop
      insert into fulla.categories (id, household_id, parent_id, name, applies_to, icon, color_index, sort, fixed)
      values (gen_random_uuid(), p_household_id, v_parent, s -> 'name' ->> v_lang, c ->> 'applies_to',
              c ->> 'icon', (c ->> 'color_index')::smallint, j, coalesce((c ->> 'fixed')::boolean, false));
      j := j + 1;
    end loop;
  end loop;
  i := 0;
  for c in select value from jsonb_array_elements(fulla.defaults() -> 'accounts') loop
    insert into fulla.accounts (id, household_id, name, type, sort)
    values (gen_random_uuid(), p_household_id, c -> 'name' ->> v_lang, c ->> 'type', i);
    i := i + 1;
  end loop;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 24;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
