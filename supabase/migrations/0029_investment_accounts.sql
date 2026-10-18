-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Investment accounts. A TFSA, RRSP, FHSA, RESP, non-registered or crypto
-- account was "other" until now; it gets a type of its own, so the web fork
-- can tell it apart from a stand-in for an account whose statement has not
-- been imported, and list it as an investment (and, later, in net worth).
-- Clients that do not know the type yet read it as "other" (core's
-- AccountType.of), so nothing breaks for them.

alter table fulla.accounts drop constraint accounts_type_check;
alter table fulla.accounts add constraint accounts_type_check
  check (type in ('cash', 'checking', 'savings', 'credit_card', 'investment', 'other'));

-- save_account (0025, 0028) checks the same list: the same function, with investment added.
do $$
declare
  v_def text := pg_get_functiondef('fulla.save_account(uuid, jsonb)'::regprocedure);
  v_old text := 'if v_type not in (''cash'', ''checking'', ''savings'', ''credit_card'', ''other'') then';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'save_account: type check not found';
  end if;
  v_def := replace(v_def, v_old, 'if v_type not in (''cash'', ''checking'', ''savings'', ''credit_card'', ''investment'', ''other'') then');
  v_def := replace(v_def, '`type` must be cash, checking, savings, credit_card or other.',
                   '`type` must be cash, checking, savings, credit_card, investment or other.');
  execute v_def;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 29;
$$;
revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
