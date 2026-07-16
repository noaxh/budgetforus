# Phase B prep — the targets engine

New-session briefing. Everything a fresh session needs to build Phase B without
re-deriving context. Read this, then the two NOTES.md sections named below, then
start.

## Who should run this stage

**Lead: Senior full-stack engineer.** Phase B is not a surface change. It spans
three layers at once: a schema migration (`categories` target columns), the money
math (`rollup()` gains a per-category "needed" and a funded/underfunded verdict),
and the UI (a real yellow state, a target editor, Cost to Be Me). The value and
the risk both live in the rollup logic, so the owner has to be comfortable in the
Postgres schema, the cents-based JS money code, and the render layer together.

**Support: design engineer**, for one bounded piece: the new underfunded (yellow)
state and the target-progress affordance (pill or ring plus icon), measured to AA
4.5:1 like the other four states. The shell and the existing four states are
already built and AA-verified, so this is an addition, not a restyle.

Not the right owners here: a pure frontend engineer (this is mostly money logic),
a DBA (the schema is trivial, the interpretation is the hard part).

## Read before starting

- `NOTES.md` -> "v3 — the envelope model" : how `rollup()`, `assignments`,
  Available and Ready to Assign work today. Phase B extends this function.
- `NOTES.md` -> "Visual and layout spec" -> the state-colors section and its
  "Current vs target semantics" note: the yellow state is a stub today and Phase B
  is what makes it real. This is the whole point of the stage.
- `NOTES.md` -> "Build plan for the gaps" -> Phase B bullet.
- `CLAUDE.md` : locked decisions and the manual-migration workflow. Do not
  relitigate the locked list.

## Where things are

- `app.js` : `rollup(cats, assigns, history, ms)` returns
  `{ cats: Map(id -> {assigned, activity, available, spent}), rta }`, all in
  integer cents. `envStatus(availC, assignedC, activityC)` returns
  `over | ok | close | none`. `unfilledCats(roll)` and `autoAssignRows(mode, roll)`
  are the auto-assign path. `?selftest` runs the money/date/rollup assertions.
- `schema.sql` + `schema-v2.sql` + `schema-v3.sql` + `schema-v4.sql` are the
  migrations, run in order. `categories.monthly_limit` already exists and already
  means "the target amount" (it feeds auto-assign). Phase B builds on it.
- Live at budgetforus.vercel.app, repo `noaxh/budgetforus`, Supabase ref
  `aeqydektxshybtyjkekp`.

## The goal

Replace the single flat `monthly_limit` with real YNAB goals, and make the
**underfunded (yellow)** state mean what YNAB means (a target or scheduled txn is
not funded yet), instead of today's stand-in (`close` = "funded and spent to
exactly zero"). Add Cost to Be Me on top.

## Scope (ponytail: two kinds first, not five)

YNAB has five target kinds. Build the two highest-value ones first and defer the
rest behind the same column set:

1. **Monthly refill-to.** Get the category's Available up to the target amount
   each month. This is essentially what `monthly_limit` already implies.
2. **By-date savings.** Save a total by a date. Needed per month is the remaining
   amount divided by the number of months left.

Defer: weekly, set-aside-another, have-a-balance-of. The schema below already
holds them, so they are later `switch` arms, not another migration.

## Schema (draft `schema-v5.sql`, idempotent)

Ponytail: a target is one-per-category, exactly what `categories` rows already
are, so this is columns on `categories`, not a `targets` table. `monthly_limit`
stays and becomes the target amount for every kind; `target_kind` interprets it.

```sql
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
-- Migration choice to confirm with Noah: default existing categories that have a
-- monthly_limit > 0 to target_kind='monthly', so today's behaviour is unchanged.
update categories set target_kind = 'monthly'
  where target_kind is null and monthly_limit > 0;
```

No new RLS (columns on an already-policied table). Same manual paste workflow as
v3/v4: the Supabase MCP in `.mcp.json` is pinned to the song-ranker ref, so it
cannot reach this project. Hand Noah the SQL, he pastes it (Ctrl+A first,
contents not filename), and it runs **before** the code that reads the columns
deploys.

## rollup() changes (the substance)

Add, per category with a target, a **needed-this-month** in cents and a verdict.
Sketch, to be firmed up in the session:

- `needed`:
  - `monthly`  -> `max(0, targetAmount - available)` (refill Available up to target)
  - `by_date`  -> `ceil( max(0, targetAmount - available) / monthsLeft )`,
                  where `monthsLeft = months from ms to target_due, min 1`
- verdict per category:
  - `available < 0`            -> `over` (red), unchanged
  - has target and `available < neededFloorForMonth` -> `underfunded` (yellow)
  - `available > 0` and target met (or no target) -> `ok` (green)
  - `available == 0`, no target, untouched -> `none` (gray)

This is where the current `close` state folds away: "funded and spent to zero"
with no target becomes gray or green, and yellow becomes real underfunded. Update
`envStatus` accordingly (it will need the category's target/needed, so its
signature changes) and **update the selftest** that currently asserts
`envStatus(0, 30000, -30000) === 'close'`; that expectation changes with the new
semantics. Keep everything in integer cents.

## The rest of Phase B

- **Auto-assign "fill to target".** Add a mode to `autoAssignRows` that assigns
  each category its `needed` for the month. The existing "fill empty to target"
  becomes a special case.
- **Cost to Be Me.** Sum of every category's `needed` for the month, an
  expected-income input, and a covered/short banner in the summary. Small once
  `needed` exists.
- **Target editor UI.** In the category manage sheet: pick a kind, an amount
  (reuse the `monthly_limit` field), and a due date for by_date. The progress
  affordance (pie/ring or the pill) is the design-engineer piece.

## Divergences and ceilings to mark with `ponytail:` comments

- By-date math assumes an even monthly contribution, not front-loading or catch-up.
- "Months left" is a whole-month count; a target due mid-month still funds over
  the remaining whole months.
- One target per category. Promoting to a table is the upgrade path if that ever
  bites.

## Verification (the app is auth-gated, so lean on selftest)

- The money/date logic goes through `?selftest`. Add assertions for `needed`
  (monthly and by_date, including the months-left boundary and a met vs unmet
  target) next to the existing rollup tests. This is the primary check, since the
  live UI needs Google login and cannot be driven in the preview.
- For any visual work, the preview caches `styles.css`; cache-bust the `<link>`
  when measuring. Measure the new yellow/underfunded contrast over its real
  background and keep it at or above 4.5:1.

## Locked context (do not relitigate)

Static HTML/CSS/JS, no build step, Supabase via CDN ESM. Integer cents, never
floats. `kind` column, amount always > 0. RLS is the only access gate. Mobile
first, 44px targets, 16px inputs. Migrations are manual. No Plaid.

## Deploy workflow

Paste `schema-v5.sql` first, confirm it ran, then commit and push (push to `main`
auto-deploys via Vercel). Running the SQL first avoids a window where the new code
reads columns that do not exist yet. Do not add a Claude co-author trailer to
commits.
