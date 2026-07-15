-- v2: income + recurring. Run once, after schema.sql.

-- Income ------------------------------------------------------------------
-- A kind column rather than signed amounts. Negative-means-income reads fine
-- until you're staring at -45.00 wondering which it was, and every sum needs a
-- sign convention nobody wrote down. amount stays > 0 and always means "how much".

alter table transactions
  add column kind text not null default 'expense'
  check (kind in ('expense', 'income'));

-- Recurring ---------------------------------------------------------------
-- Rules, not transactions. Nothing exists until a month is explicitly applied,
-- so there is no cron, no edge function, and no surprise rows appearing in a
-- month you never opened.

create table recurring (
  id           uuid primary key default gen_random_uuid(),
  budget_id    uuid not null references budgets(id) on delete cascade,
  category_id  uuid references categories(id) on delete set null,
  kind         text not null default 'expense' check (kind in ('expense', 'income')),
  amount       numeric(12,2) not null check (amount > 0),
  description  text not null default '' check (length(description) <= 120),
  day_of_month int not null default 1 check (day_of_month between 1 and 31),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index on recurring (budget_id);

alter table transactions
  add column recurring_id uuid references recurring(id) on delete set null;

-- The date a rule lands on in a given month is deterministic, so uniqueness on
-- (rule, date) is the entire guard against both of us hitting "add them" at the
-- same moment and paying rent twice.
--
-- Not a partial index: recurring_id is null for manual transactions, and Postgres
-- treats nulls as distinct in a unique index, so those never collide with each
-- other. A plain index also lets ON CONFLICT infer it, which a partial one won't.
create unique index transactions_recurring_once_per_month
  on transactions (recurring_id, occurred_on);

alter table recurring enable row level security;

create policy "members read recurring" on recurring for select to authenticated
  using (is_budget_member(budget_id));
create policy "members add recurring" on recurring for insert to authenticated
  with check (is_budget_member(budget_id));
create policy "members edit recurring" on recurring for update to authenticated
  using (is_budget_member(budget_id)) with check (is_budget_member(budget_id));
create policy "members delete recurring" on recurring for delete to authenticated
  using (is_budget_member(budget_id));
