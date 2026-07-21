-- v11: currency. Idempotent: run after schema-v10.sql. Paste into the budgetforus
-- SQL editor (Ctrl+A first, contents not filename). Run this BEFORE pushing the
-- client, which selects budgets.currency and will error on a missing column.

-- What this budget's amounts ARE. Every number in transactions and assignments is
-- already stored in one currency as integer cents; this records which one, so the
-- client can label it and convert for display. It does NOT convert anything:
-- changing it reinterprets existing amounts, which is why the client confirms it
-- in those words.
--
-- The viewer's *display* currency is deliberately NOT here. It is a per-person
-- reading preference, it lives in that device's localStorage, and keeping it out of
-- the database is what stops one member's choice from changing what the other one
-- sees. Shared data is the money; the units you read it in are yours.
alter table budgets add column if not exists currency text not null default 'CAD';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'budgets_currency_check') then
    alter table budgets add constraint budgets_currency_check
      check (currency in ('CAD', 'USD'));
  end if;
end $$;

-- No RLS change needed: `currency` rides on `budgets`, which already restricts
-- select/update to members via is_budget_member().
