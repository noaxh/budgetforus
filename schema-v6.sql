-- v6: Phase C — richer transactions (the additive three).
-- Idempotent: run after schema-v5.sql. Paste into the budgetforus SQL editor
-- (Ctrl+A first, contents not filename).
--
-- Splits (parent_id self-reference) are deliberately NOT here — they change
-- rollup() semantics and ship in their own pass.

-- Recurring enhancements --------------------------------------------------
-- The rule table already exists (schema-v2). These columns add cadences beyond
-- day-of-month and an opt-in auto-apply. day_of_month stays the anchor day for
-- monthly / every_n; weekly ignores it and uses day_of_week instead.

alter table recurring add column if not exists cadence text not null default 'monthly';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recurring_cadence_check') then
    alter table recurring add constraint recurring_cadence_check
      check (cadence in ('monthly','weekly','every_n'));
  end if;
end $$;

-- 0=Sunday .. 6=Saturday, only meaningful (and only set) for weekly rules.
alter table recurring add column if not exists day_of_week int;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recurring_day_of_week_check') then
    alter table recurring add constraint recurring_day_of_week_check
      check (day_of_week is null or day_of_week between 0 and 6);
  end if;
end $$;

-- every_n: fire once every N months, anchored on the rule's creation month.
alter table recurring add column if not exists interval_months int not null default 1;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recurring_interval_months_check') then
    alter table recurring add constraint recurring_interval_months_check
      check (interval_months between 1 and 60);
  end if;
end $$;

-- Opt-in: when true, the app applies this rule's due occurrences on its own the
-- first time the month (current or past) is opened, instead of waiting for the
-- "Add them" banner.
alter table recurring add column if not exists auto_apply boolean not null default false;

-- Money Moves -------------------------------------------------------------
-- Append-only trail of assignment changes: every time an envelope's Assigned
-- amount changes, one row records from -> to. Read-only history; nothing ever
-- updates or deletes a move. category_id nulls (not cascades-away) if a category
-- is deleted, so the trail survives the category it described.

create table if not exists money_moves (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references budgets(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  month       date not null,
  from_amount numeric(12,2) not null default 0,
  to_amount   numeric(12,2) not null,
  moved_at    timestamptz not null default now()
);
create index if not exists money_moves_budget_idx on money_moves (budget_id);
create index if not exists money_moves_cat_idx on money_moves (category_id);

-- RLS. The project has an automatic-RLS event trigger, but raw-SQL tables are
-- exactly the case where it can be missed, so enable and policy explicitly.
-- No update/delete policies: the log is append-only by construction.
alter table money_moves enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'money_moves' and policyname = 'members read moves') then
    create policy "members read moves" on money_moves for select to authenticated
      using (is_budget_member(budget_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'money_moves' and policyname = 'members add moves') then
    create policy "members add moves" on money_moves for insert to authenticated
      with check (is_budget_member(budget_id));
  end if;
end $$;
