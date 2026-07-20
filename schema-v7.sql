-- v7: Phase 1 — split transactions, transaction memo, and target snoozes.
-- Idempotent: run after schema-v6.sql. Paste into the budgetforus SQL editor
-- (Ctrl+A first, contents not filename). Run this BEFORE pushing the Phase 1
-- client, so the new code never hits missing columns/tables.

-- Split transactions ------------------------------------------------------
-- A split is one PARENT transaction (the whole amount, no category) plus N
-- CHILD rows, each carrying a category and its share and pointing back with
-- parent_id. Only children are counted in the money math; the parent is a
-- display container whose amount equals the sum of its children, so counting
-- both would double the split (core.js splitParentIds enforces this).
--
-- on delete cascade: deleting the parent takes its children with it, so a split
-- never leaves orphan halves behind.
alter table transactions
  add column if not exists parent_id uuid references transactions(id) on delete cascade;
create index if not exists transactions_parent_idx on transactions (parent_id);

-- Transaction memo --------------------------------------------------------
-- A free-text note distinct from description (which doubles as the payee for the
-- autocomplete datalist). Nullable; the length check is the boundary validation.
alter table transactions add column if not exists memo text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_memo_len') then
    alter table transactions add constraint transactions_memo_len
      check (memo is null or length(memo) <= 200);
  end if;
end $$;

-- Target snoozes ----------------------------------------------------------
-- One row per (category, month) that has been snoozed: its target does not count
-- as underfunded that month, so a category you have deliberately skipped stops
-- nagging. Shared budget data (a snooze one partner sets shows for both), so it
-- lives in Postgres, not localStorage.
--
-- budget_id is denormalized so RLS checks membership without a join, exactly like
-- assignments; the composite FK below keeps it honest (a member of budget A can't
-- snooze a category belonging to budget B and corrupt A's view).
create table if not exists target_snoozes (
  budget_id   uuid not null references budgets(id) on delete cascade,
  category_id uuid not null,
  month       date not null check (extract(day from month) = 1),
  primary key (category_id, month)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'target_snoozes_category_fk') then
    alter table target_snoozes add constraint target_snoozes_category_fk
      foreign key (category_id, budget_id) references categories (id, budget_id)
      on delete cascade;
  end if;
end $$;
create index if not exists target_snoozes_budget_month_idx on target_snoozes (budget_id, month);

alter table target_snoozes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'target_snoozes' and policyname = 'members read snoozes') then
    create policy "members read snoozes" on target_snoozes for select to authenticated
      using (is_budget_member(budget_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'target_snoozes' and policyname = 'members add snoozes') then
    create policy "members add snoozes" on target_snoozes for insert to authenticated
      with check (is_budget_member(budget_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'target_snoozes' and policyname = 'members delete snoozes') then
    create policy "members delete snoozes" on target_snoozes for delete to authenticated
      using (is_budget_member(budget_id));
  end if;
end $$;
