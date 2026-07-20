-- v8: Phase 3 — categorization rules. Idempotent: run after schema-v7.sql. Paste
-- into the budgetforus SQL editor (Ctrl+A first, contents not filename). Run this
-- BEFORE pushing the Phase 3 client, so the new code never hits a missing table.

-- Categorization rules ----------------------------------------------------
-- A rule sets a category (and optionally a flag) on any transaction whose
-- description CONTAINS `match` (case-insensitive). Priority is `sort` order,
-- first match wins (core.js matchRule). Applied as a pre-fill on manual entry
-- and, on demand, retro-applied to existing uncategorized rows. Distinct from
-- the `recurring` table, which creates transactions; a rule only classifies them.
--
-- category_id is a plain (single-column) FK with ON DELETE SET NULL: deleting a
-- category leaves the rule in place (it may still set a flag) rather than dropping
-- it. Unlike assignments/snoozes there is no composite budget FK here — a rule is
-- only ever read back through its own budget's RLS, and the client only offers its
-- own categories, so a cross-budget id would simply never match anything.
create table if not exists rules (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references budgets(id) on delete cascade,
  match       text not null check (length(trim(match)) between 1 and 120),
  category_id uuid references categories(id) on delete set null,
  flag        text,
  sort        int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists rules_budget_sort_idx on rules (budget_id, sort, created_at);

alter table rules enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'rules' and policyname = 'members read rules') then
    create policy "members read rules" on rules for select to authenticated
      using (is_budget_member(budget_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'rules' and policyname = 'members add rules') then
    create policy "members add rules" on rules for insert to authenticated
      with check (is_budget_member(budget_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'rules' and policyname = 'members edit rules') then
    create policy "members edit rules" on rules for update to authenticated
      using (is_budget_member(budget_id)) with check (is_budget_member(budget_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'rules' and policyname = 'members delete rules') then
    create policy "members delete rules" on rules for delete to authenticated
      using (is_budget_member(budget_id));
  end if;
end $$;
