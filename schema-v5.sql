-- v5: real targets. Idempotent, run after schema-v4.sql (Ctrl+A, paste contents).
-- ponytail: one target per category, so these are columns, not a table. If a
-- category ever needs multiple targets (YNAB does not), promote to a targets table.

alter table categories add column if not exists target_kind text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categories_target_kind_check') then
    alter table categories add constraint categories_target_kind_check
      check (target_kind is null or target_kind in
        ('monthly','by_date','weekly','setaside','balance'));
  end if;
end $$;

-- by_date needs a due date; the other kinds leave it null.
alter table categories add column if not exists target_due date;

-- monthly_limit is the target amount for whichever kind is set. Kept as-is.
-- Default existing categories that already carry a monthly_limit to
-- target_kind='monthly', so today's behaviour (auto-assign fill-to-target) is
-- unchanged and they immediately get the real underfunded state.
update categories set target_kind = 'monthly'
  where target_kind is null and monthly_limit > 0;
