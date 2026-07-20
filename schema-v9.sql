-- v9: Phase 4 — net worth lite (accounts + monthly balance snapshots). Idempotent:
-- run after schema-v8.sql. Paste into the budgetforus SQL editor (Ctrl+A first,
-- contents not filename). Run this BEFORE pushing the Phase 4 client.

-- Accounts ----------------------------------------------------------------
-- A net-worth account: an asset (checking, savings, cash) or a liability (a loan,
-- a card balance). This is DELIBERATELY not the transaction/register subsystem —
-- transactions never reference accounts (decided 2026-07-17). No cleared state, no
-- reconcile, no transfers. Balances are typed in by hand, month by month.
--
-- unique (id, budget_id) exists so balance_snapshots can carry a composite FK that
-- pins a snapshot to an account in the SAME budget (the assignments/snoozes trick).
create table if not exists accounts (
  id         uuid primary key default gen_random_uuid(),
  budget_id  uuid not null references budgets(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 60),
  kind       text not null check (kind in ('asset', 'liability')),
  sort       int  not null default 0,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  constraint accounts_id_budget_uniq unique (id, budget_id)
);
create index if not exists accounts_budget_idx on accounts (budget_id, sort);

-- Balance snapshots -------------------------------------------------------
-- One typed-in balance per account per month, in integer cents (bigint: a net
-- worth can exceed the int cents ceiling). balance_cents may be negative (an asset
-- overdraft); a liability's balance is stored positive and SUBTRACTED in the net
-- worth math by its account's kind, never as a signed amount (the app-wide rule).
-- Net worth carries the latest balance forward until a newer month is entered
-- (core.js netWorthAt), so months you skip keep the last figure and just read stale.
--
-- budget_id is denormalized so RLS checks membership without a join; the composite
-- FK keeps it honest (a snapshot's account must live in the same budget).
create table if not exists balance_snapshots (
  account_id    uuid   not null,
  budget_id     uuid   not null references budgets(id) on delete cascade,
  month         date   not null check (extract(day from month) = 1),
  balance_cents bigint not null,
  primary key (account_id, month),
  constraint balance_snapshots_account_fk
    foreign key (account_id, budget_id) references accounts (id, budget_id) on delete cascade
);
create index if not exists balance_snapshots_budget_month_idx on balance_snapshots (budget_id, month);

-- RLS: members of the budget can read and write both tables ----------------
alter table accounts enable row level security;
alter table balance_snapshots enable row level security;
do $$
declare t text;
begin
  foreach t in array array['accounts', 'balance_snapshots'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'members read ' || t) then
      execute format('create policy "members read %1$s" on %1$s for select to authenticated using (is_budget_member(budget_id))', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'members add ' || t) then
      execute format('create policy "members add %1$s" on %1$s for insert to authenticated with check (is_budget_member(budget_id))', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'members edit ' || t) then
      execute format('create policy "members edit %1$s" on %1$s for update to authenticated using (is_budget_member(budget_id)) with check (is_budget_member(budget_id))', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'members delete ' || t) then
      execute format('create policy "members delete %1$s" on %1$s for delete to authenticated using (is_budget_member(budget_id))', t);
    end if;
  end loop;
end $$;
