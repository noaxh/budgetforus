-- v4: category groups (as a label) + transaction flags.
-- Idempotent: run after schema-v3.sql. Paste into the budgetforus SQL editor
-- (Ctrl+A first, contents not filename).
--
-- ponytail: a group is a text label on the category, not its own table. The
-- distinct group_name values ARE the groups; the UI groups categories by this
-- string. Ceiling: no independent group ordering and no one-click rename (a
-- rename edits every category carrying that name). Promote group_name to a
-- `category_groups` table if reorderable groups with their own identity are
-- ever wanted.

alter table categories add column if not exists group_name text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'categories_group_name_len') then
    alter table categories add constraint categories_group_name_len
      check (group_name is null or length(trim(group_name)) between 1 and 40);
  end if;
end $$;

-- Flags: YNAB's six colours, nullable. The check is the boundary validation, so
-- a bad value is refused by the database rather than trusted from the client.
alter table transactions add column if not exists flag text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_flag_check') then
    alter table transactions add constraint transactions_flag_check
      check (flag is null or flag in ('red','orange','yellow','green','blue','purple'));
  end if;
end $$;

-- No new RLS: both columns sit on tables that already have member policies, and
-- there are no column-level grants in this project.
