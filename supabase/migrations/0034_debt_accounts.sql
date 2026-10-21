-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Debt accounts. A line of credit and a loan (a personal loan, a car or
-- student loan) get types of their own, so their statements can be imported
-- like a card's: what is owed is the account's balance (negative), a payment
-- from the bank is a transfer into it, and net worth counts it with the
-- cards under "Cards & debt". Clients that do not know the types yet read
-- them as "other" (core's AccountType.of), so nothing breaks for them.

alter table fulla.accounts drop constraint accounts_type_check;
alter table fulla.accounts add constraint accounts_type_check
  check (type in ('cash', 'checking', 'savings', 'credit_card', 'line_of_credit', 'loan', 'investment', 'other'));

-- save_account (0032) checks the same list: the same function, with the two debt types added.
do $$
declare
  v_def text := pg_get_functiondef('fulla.save_account(uuid, jsonb)'::regprocedure);
  v_old text := 'if v_type not in (''cash'', ''checking'', ''savings'', ''credit_card'', ''investment'', ''other'') then';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'save_account: type check not found';
  end if;
  v_def := replace(v_def, v_old,
    'if v_type not in (''cash'', ''checking'', ''savings'', ''credit_card'', ''line_of_credit'', ''loan'', ''investment'', ''other'') then');
  v_def := replace(v_def, '`type` must be cash, checking, savings, credit_card, investment or other.',
                   '`type` must be cash, checking, savings, credit_card, line_of_credit, loan, investment or other.');
  execute v_def;
end;
$$;

create or replace function public.fulla_schema_version() returns integer
language sql immutable security definer
set search_path = ''
as $$
  select 34;
$$;

revoke all on all functions in schema fulla from public, anon, authenticated;
revoke all on function public.fulla_schema_version() from public, anon;
grant execute on function public.fulla_schema_version() to authenticated;
