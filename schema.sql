-- Budget app schema. Paste into Supabase SQL editor, run once.

create table budgets (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);

create table budget_members (
  budget_id uuid not null references budgets(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  primary key (budget_id, user_id)
);

create table categories (
  id            uuid primary key default gen_random_uuid(),
  budget_id     uuid not null references budgets(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 40),
  monthly_limit numeric(12,2) not null default 0 check (monthly_limit >= 0),
  sort          int not null default 0
);

create table transactions (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references budgets(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  amount      numeric(12,2) not null check (amount > 0),
  description text not null default '' check (length(description) <= 120),
  occurred_on date not null default current_date,
  created_by  uuid not null default auth.uid() references auth.users(id),
  created_at  timestamptz not null default now()
);

create index on transactions (budget_id, occurred_on);
create index on categories (budget_id);
create index on budget_members (user_id);

-- ---------------------------------------------------------------- RLS

alter table budgets        enable row level security;
alter table budget_members enable row level security;
alter table categories     enable row level security;
alter table transactions   enable row level security;

-- security definer, so a policy on budget_members can call it without
-- recursing into budget_members' own policy.
create or replace function is_budget_member(b uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from budget_members
    where budget_id = b and user_id = auth.uid()
  );
$$;

-- Creating a budget makes you its first member. Done in a trigger so it can't
-- half-fail the way two client-side inserts can.
create or replace function add_creator_as_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into budget_members (budget_id, user_id) values (new.id, auth.uid());
  return new;
end;
$$;

create trigger budgets_add_creator
  after insert on budgets
  for each row execute function add_creator_as_member();

create policy "read own budgets" on budgets for select to authenticated
  using (is_budget_member(id));
create policy "create budgets" on budgets for insert to authenticated
  with check (true);
create policy "members rename budget" on budgets for update to authenticated
  using (is_budget_member(id)) with check (is_budget_member(id));

-- Read-only from the client. To add your friend to a budget, run this by hand
-- in the SQL editor once (get their id from Authentication -> Users):
--   insert into budget_members values ('<budget-id>', '<their-user-id>');
-- ponytail: no invite UI. Two people, one-time action, and nothing to attack.
create policy "read co-members" on budget_members for select to authenticated
  using (is_budget_member(budget_id));

create policy "members read categories" on categories for select to authenticated
  using (is_budget_member(budget_id));
create policy "members add categories" on categories for insert to authenticated
  with check (is_budget_member(budget_id));
create policy "members edit categories" on categories for update to authenticated
  using (is_budget_member(budget_id)) with check (is_budget_member(budget_id));
create policy "members delete categories" on categories for delete to authenticated
  using (is_budget_member(budget_id));

create policy "members read transactions" on transactions for select to authenticated
  using (is_budget_member(budget_id));
-- created_by = auth.uid() stops a member attributing a row to the other person.
create policy "members add transactions" on transactions for insert to authenticated
  with check (is_budget_member(budget_id) and created_by = auth.uid());
create policy "members edit transactions" on transactions for update to authenticated
  using (is_budget_member(budget_id)) with check (is_budget_member(budget_id));
create policy "members delete transactions" on transactions for delete to authenticated
  using (is_budget_member(budget_id));
