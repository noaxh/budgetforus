-- v10: Phase 6 — category lifecycle (archive + notes). Idempotent: run after
-- schema-v9.sql. Paste into the budgetforus SQL editor (Ctrl+A first, contents
-- not filename). Run this BEFORE pushing the Phase 6 client.

-- Archiving retires a category without deleting it. Deleting sets category_id to
-- null on that category's past transactions, which drops their spending into
-- Ready to Assign and rewrites months you already closed — the defect NOTES.md
-- records. Archiving touches no transaction: the category stops rendering in the
-- plan and the pickers, while rollup and the reports still count every row that
-- points at it, so history stays exactly as it was.
--
-- There is no separate "hidden" state. Hide and archive are the same act at this
-- scale, so they are one flag. The client refuses to archive a category holding
-- money, because an archived envelope with a balance is money you can no longer
-- see; move it out first (the move sheet already does that).
alter table categories add column if not exists archived boolean not null default false;

-- Why this envelope exists, in your own words. Rendered in the move sheet, which
-- is where you're deciding about the category. Plain text, no formatting.
alter table categories add column if not exists notes text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'categories_notes_len') then
    alter table categories add constraint categories_notes_len
      check (notes is null or length(notes) <= 280);
  end if;
end $$;

-- `categories.sort` has existed since schema.sql (int not null default 0) and the
-- load has always ordered by it, but nothing ever wrote it — every row sat at 0
-- and the tiebreak on name did the real ordering. The Phase 6 client is the first
-- writer. No backfill needed: the first reorder re-packs the whole list to its
-- array index, the same way the rules list does.
