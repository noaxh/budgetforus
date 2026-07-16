-- v3: deleting budgets + the envelope model. Run after schema-v2.sql.
-- Idempotent: every statement is guarded, so re-running is safe. (An earlier
-- partial run left the budget delete policy behind, and the un-guarded version
-- then died on "policy already exists" -- 42710. This one converges instead.)

-- Deleting a budget ---------------------------------------------------------
-- The client could always call delete(); RLS just refused, silently, because
-- there was no delete policy on budgets. Every child table already references
-- budgets(id) on delete cascade, so this one policy is the whole feature:
-- members, categories, transactions, recurring and assignments all follow.

drop policy if exists "members delete budget" on budgets;
create policy "members delete budget" on budgets for delete to authenticated
  using (is_budget_member(id));

-- Assignments ---------------------------------------------------------------
-- The envelope model. A category's plan is no longer one static number; it is
-- "how much did you give this category in THIS month", one row per category per
-- month. Assigned, Activity, Available and Ready to Assign all fall out of it.
--
-- month is always the 1st. It is a month stamp, not a date, and the check is
-- what stops '2026-07-14' and '2026-07-01' becoming two separate Julys.

create table if not exists assignments (
  budget_id   uuid not null references budgets(id) on delete cascade,
  category_id uuid not null,
  month       date not null check (extract(day from month) = 1),
  amount      numeric(12,2) not null default 0,
  primary key (category_id, month)
);

-- budget_id is denormalized so the RLS policies can check membership without a
-- join to categories. The composite FK below is what keeps it honest: without
-- it, a member of budget A could insert an assignment carrying budget_id = A
-- against a category belonging to budget B, pass the membership check, and
-- quietly corrupt A's own Ready to Assign with a row it can't see.
-- Guarded in a DO block because constraints have no CREATE ... IF NOT EXISTS.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'categories_id_budget_key') then
    alter table categories add constraint categories_id_budget_key unique (id, budget_id);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assignments_category_fk') then
    alter table assignments add constraint assignments_category_fk
      foreign key (category_id, budget_id) references categories (id, budget_id)
      on delete cascade;
  end if;
end $$;

-- Drop the old auto-named index (from an un-guarded prior run) so we converge to
-- one named index rather than stacking a duplicate.
drop index if exists assignments_budget_id_month_idx;
create index if not exists assignments_budget_month_idx on assignments (budget_id, month);

-- No check (amount >= 0). YNAB lets you assign a negative number to pull money
-- back out of an envelope, and a constraint here would present that as a
-- database error rather than as a refusal.

alter table assignments enable row level security;

-- Drop-then-create so the policy set is exactly this, no matter what a prior
-- partial run left behind.
drop policy if exists "members read assignments"   on assignments;
drop policy if exists "members add assignments"    on assignments;
drop policy if exists "members edit assignments"   on assignments;
drop policy if exists "members delete assignments" on assignments;

create policy "members read assignments" on assignments for select to authenticated
  using (is_budget_member(budget_id));
create policy "members add assignments" on assignments for insert to authenticated
  with check (is_budget_member(budget_id));
create policy "members edit assignments" on assignments for update to authenticated
  using (is_budget_member(budget_id)) with check (is_budget_member(budget_id));
create policy "members delete assignments" on assignments for delete to authenticated
  using (is_budget_member(budget_id));

-- Seed ----------------------------------------------------------------------
-- monthly_limit was the old plan, so it is the best guess at this month's
-- assignment. Without this, everyone opens v3 to a budget where every envelope
-- reads $0 and all their money is unassigned -- which is technically true and
-- completely useless.
--
-- Current month only. Backfilling every past month would invent assignments
-- that were never made and produce a fictional history of Available.
-- on conflict do nothing keeps the re-run safe: an already-seeded month is left
-- as the user last set it, never reset back to monthly_limit.

insert into assignments (budget_id, category_id, month, amount)
select budget_id, id, date_trunc('month', current_date)::date, monthly_limit
from categories
where monthly_limit > 0
on conflict do nothing;

-- monthly_limit is kept, not dropped: it stops being the plan and becomes the
-- target -- the usual monthly amount that the Auto-assign button fills to.
comment on column categories.monthly_limit is
  'Target: the usual monthly amount. Auto-assign fills empty envelopes to this. Not a limit.';
