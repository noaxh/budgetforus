# Budget App

Private budgeting app for Noah and one friend. Live, in real use.

- **Live:** https://budgetforus.vercel.app
- **Repo:** https://github.com/noaxh/budgetforus — its OWN git repo, not the desktop monorepo
- **Supabase:** project `budgetforus`, ref `aeqydektxshybtyjkekp`
- **Full history/rationale:** [NOTES.md](NOTES.md). Read it before proposing anything structural.

## Where this is going

**The app is being modeled on YNAB** — its interface and its feature set. This is the
governing direction. When a choice is ambiguous, the answer is usually "what does YNAB do".
The **"Visual and layout spec"** section of [NOTES.md](NOTES.md) is the governing design
reference: exact tokens, the four Available states, the category table, the Inspector, the
register columns, and the mobile five-tab / desktop sidebar shell. Read it before any UI work.

**The envelope model shipped in v3** (`schema-v3.sql`, 2026-07-15) — `assignments` holds
one row per category per month, and `Assigned`, `Activity`, `Available` and Ready to Assign
all derive from it in `rollup()`. Read the v3 section of NOTES.md before touching that
function: it documents three deliberate divergences from YNAB, and each one looks like a
bug if you don't know it was a decision.

Roadmap: **"Roadmap v2: YNAB core, Monarch surfaces" in [NOTES.md](NOTES.md) is the live
plan** (2026-07-17). The "YNAB feature parity" audit in NOTES.md is the reference inventory
(statuses frozen 2026-07-16); Roadmap v2 owns status and order. Already shipped: Phases A,
B (targets engine), C (recurring cadences + auto-apply, Money Moves, bulk bar), the Spruce
& Bone redesign, Phase D reports, the register search bar, and Roadmap v2 **Phases 1, 2, 3
and 4** — all deployed, with `schema-v7/v8/v9.sql` confirmed run (REST probe 2026-07-21:
`target_snoozes`, `rules`, `accounts`, `balance_snapshots` all present, RLS holding).
**Phase 6 (category lifecycle) is built and needs `schema-v10.sql` run before its deploy.**
Remaining phases, in order:

1. ~~**Envelope finishers.**~~ **Shipped 2026-07-20** (`schema-v7.sql`): quick-move / cover
   overspending (tap an Available pill), focused views (filter chips over the plan,
   remembered in localStorage), the remaining auto-assign modes (3-month average assigned /
   spent, reduce overfunding, reset available, all group-scopable), target snooze (per
   category per month, `target_snoozes` table, suppresses the amber + Zz mark), split
   transactions (`transactions.parent_id`; parent is a container, children carry categories,
   `rollup`/`cashFlow`/`spendingBreakdown` skip parents via `splitParentIds`), the txn
   micro-features (`memo` column, `evalAmount` calculator in every money field, duplicate,
   convert-to-recurring, add-now on a rule), and Age of Money (FIFO in `core.js`).
2. ~~**Home dashboard (Monarch).**~~ **Shipped** — landing tab with plan state, spending
   summary, upcoming recurring, recent transactions, alert cards; hide/reorder stored locally.
3. ~~**Rules + recurring calendar (Monarch).**~~ **Shipped** (`schema-v8.sql`) —
   description-match rules setting category and flag, retro-apply with preview,
   payee-memory fallback, calendar of recurring bills.
4. ~~**Net worth lite.**~~ **Shipped** (`schema-v9.sql`) — manual `accounts` + monthly
   `balance_snapshots`, net worth view + dashboard card. Transactions never reference
   accounts (decided 2026-07-17).
5. **File import:** CSV/OFX drag-drop, column map, dedupe, categorized by the rules.
   Deliberately still unbuilt — the roadmap gates it on a real bank export existing.
6. ~~**Category + plan management.**~~ **Built 2026-07-21, needs `schema-v10.sql` run
   before deploy.** Scope was cut on the ladder, and the cuts are the interesting part:
   - **Reorder** — `categories.sort` had existed since `schema.sql` sitting at 0 on every
     row, never written. Wired up with up/down arrows (the `.rule-move` idiom), no drag lib,
     no migration; the first press re-packs the whole list to its array index.
   - **Archive** — one `archived` flag covering both "hide" and "archive"; they were the
     same act at this scale. This is also the *correct* retirement path, since deleting a
     category nulls `category_id` on its history and rewrites closed months.
   - **Notes** — one column, rendered in the move sheet where the decision happens.
   - **Cut:** emoji (type it into the name), colour (`group_name` already organizes),
     merge (bulk-recategorize + delete does it in two steps), copy/archive budget and
     Fresh Start (two people, one budget). Future-month assigning needed no work —
     `goMonth` never clamped and `assign` has no month guard.
7. ~~**Productivity + QoL.**~~ **Built 2026-07-21, no migration.** Undo built NARROW —
   one level, this session, assignments only, guarded by `core.js undoStomped()` which
   compares in cents (PostgREST returns numerics as strings, so a raw `!==` would call
   every row stomped) and refuses rather than stomping a partner's edit. Redo cut (retype
   it); undo of transaction edits/deletes cut (needs soft-delete + a filter on every read).
   Keyboard shortcuts `n / [ ] a u ?`, ignored while typing or with a sheet open. PWA
   manifest + generated icons, still **no service worker** — a stale cached balance is
   worse than a spinner. First-run explainer, once per device, re-openable from the menu.

**With Phase 7 done, Phase 5 (file import) is the only roadmap item left, and it is gated
on a real bank export existing.** Don't invent more phases — the standing recommendation
below (use it for a week with real data) is the actual next step.

Parked (build on real demand): loan calculator, real payees table, richer target kinds,
realtime sync, offline. Settle-up / who-owes-who stays out unless asked (the shared budget
is a joint pot, not split costs).

Deliberately **not** doing: bank sync via Plaid (costs money, most of the complexity in every
competitor), the full accounts subsystem and credit-card handling (cut 2026-07-17; balance
snapshots replace them), subscription cancellation, credit score, receipts/OCR, AI features,
investments, forecasting, mobile native widgets, public API.

## Locked decisions — do not relitigate

- **Static HTML/CSS/JS. No build step, no framework, no npm.** Supabase via CDN ESM.
- **`kind` column, never signed amounts.** Income is `kind='income'`, `amount` always > 0.
- **Money is summed in integer cents.** Never float. `0.1 + 0.2` drifts and it shows up
  across a month of transactions.
- **A personal budget is just a budget with one member.** No `kind` column on budgets —
  membership already encodes personal vs shared.
- **No invite UI.** The second member is added by hand in the SQL editor, once.
- **RLS is the only access gate.** No auth checks in the client — the client is not trusted.
- **No column encryption.** Breaks summing amounts, which is the whole app.
- **Glass on chrome only** (header, FAB, sheets), never on content rows. Per Apple's own
  guidance, and because the numbers must stay readable.

## Conventions

- **Ponytail applies**: build the laziest thing that actually works. Mark deliberate
  simplifications with a `ponytail:` comment naming the ceiling.
- Files: `index.html` / `styles.css` / `app.js` / `core.js` / `schema*.sql`. `core.js` is
  the pure logic (money, dates, `rollup`, and Phase B's targets math): no DOM, no Supabase,
  exercised by `?selftest`. `app.js` imports from it and holds the Supabase, render, and
  event glue. Treat ~500 lines per file as a *smell trigger*, not a hard cap (see below).

### When to split a file

- **No build step, ever.** JS splits use native ES modules (`import`/`export`; the entry is
  already `type="module"`). CSS splits use extra `<link>` tags. Never a bundler.
- **JS: split when a file crosses ~500 lines AND there is a clean seam** (a cohesive chunk
  with no dependency on the rest). Extract by responsibility, not to hit a number: pure logic
  goes to `core.js` and stays testable via `?selftest`; DOM/data/render/event glue stays in
  `app.js`. Prefer two or three well-separated files over many tiny ones. A 550-line file
  with no clean seam is fine, leave it.
- **CSS: do not split by default.** A single well-sectioned `styles.css` is easier to work in
  than a rule chased across files, and extra `<link>`s add requests plus the stale-cache
  flakiness seen during preview. Split only past ~800 lines or for a genuinely separate
  surface (for example a print sheet). If the guideline bites, trim dead rules first.
- **Mobile is the primary target.** iPhone, Add to Home Screen. Design phone-first:
  44px minimum tap targets, 16px inputs (anything smaller makes iOS zoom the page on focus).
- **Measure contrast, don't eyeball it.** Translucency silently eats contrast — the glass
  FAB shipped at 3.89:1 before it got caught. AA (4.5:1) is not negotiable on a money app.
- `?selftest` runs the money/date assertions in the console. Extend it when adding logic
  that can be quietly wrong; leave trivial code alone.
- Local dev: `budget-app` entry in `../.claude/launch.json`, port 5620. Never use Bash
  to run a server.

## Gotchas that cost real time

- **Migrations are manual.** The Supabase MCP in `.mcp.json` is pinned to the SONG-RANKER
  project (`pqnfracutqznykuclsss`) and **cannot see this one**. Repointing needs a Claude
  Code restart. So: hand Noah the SQL and have him paste it into the SQL editor. Tell him
  to Ctrl+A first — he has twice pasted a *filename* into the editor instead of contents.
- **"Could not find the table in the schema cache" usually means the migration never ran**,
  not that a cache is stale. Probe the REST endpoint: a `42703` (column does not exist)
  comes from Postgres itself and proves the DDL never executed. Don't hunt for a reload button.
- **Raw-SQL-created tables don't get RLS by default.** The project has the automatic-RLS
  event trigger on, but always verify.
- **Verify RLS actually holds** by fetching the REST endpoint anonymously with the
  publishable key. `200` + `[]` means RLS denied it. Rows coming back means it's off.
- OAuth setup traps (redirect_uri, the silent Site URL fallback, the invisible Client
  Secret) are written up in NOTES.md and in the ruflo `bugs` namespace. Search there before
  debugging auth.

## Keys

- `sb_publishable_…` is **public by design** — safe to commit, safe in the browser, it's
  in the repo. RLS is what protects the data.
- `sb_secret_…` **bypasses RLS entirely.** Never in client code, never in the repo, never
  in chat. If one appears anywhere it shouldn't, say so and tell Noah to rotate it.

## Open items (as of 2026-07-20)

- [ ] **Run `schema-v11.sql`** (adds `budgets.currency`, CAD/USD). **Not a deploy blocker
      this time** — the client selects `budgets.*` rather than naming `currency`, so it
      falls back to CAD until the migration lands and the two can ship in either order.
      Copy that pattern for future columns; naming a not-yet-existing column is what
      turns a migration into a hard 400 on every load. Until it runs, the currency
      chooser's *display* side still works (it is per-device localStorage); only
      changing the budget's base currency will error.
- [x] ~~**Run `schema-v10.sql` BEFORE deploying Phase 6.**~~ Done 2026-07-21; verified
      by REST probe (`categories.archived`, `categories.notes` both `200`+`[]`).
- [x] ~~**Run `schema-v7/v8/v9.sql`.**~~ All confirmed run 2026-07-21 by REST probe:
      `target_snoozes`, `rules`, `accounts` and `balance_snapshots` all answer `200` with
      `[]` on the publishable key, which is both "the table exists" and "RLS is denying
      anonymous reads". `transactions.parent_id` and `memo` are present too.
- [x] ~~**Run `schema-v3.sql`.**~~ Done 2026-07-16. A prior partial run had left the budget
      delete policy behind, so the plain script died on `42710` (policy already exists); an
      idempotent version ran clean and `schema-v3.sql` is now guarded (drop-if-exists /
      if-not-exists) so future re-runs are safe.
- [x] ~~**Run `schema-v4/v5/v6.sql`.**~~ All shipped. v4 (`group_name`, `flag`) with Phase A,
      v5 (targets engine) with Phase B, v6 (recurring cadences) with Phase C. When adding the
      next migration: run the SQL FIRST, then push the code, so the new client never hits
      missing columns.
- [x] ~~Rotate `sb_secret_…`~~ — done 2026-07-15.
- [ ] **Onboard the friend, then close signups.** Sign-ups are deliberately still ON —
      closing them before the friend registers would lock them out. Order matters:
      1. Confirm their Gmail is a **test user** on the Google OAuth consent screen. It's
         still in Testing mode (an intentional extra gate), so Google refuses anyone not
         listed — which presents as a broken login, not as a permissions message.
      2. They sign in at the live URL.
      3. Authentication → Users → copy their id.
      4. `insert into budget_members values ('<budget-id>', '<their-user-id>');`
      5. **Then** Auth → Sign-ups → disable.

      Until step 5, anyone holding the public key can register an account. RLS still
      blocks their reads, so it isn't an emergency — but one of the three layers is off.
- [ ] Recommended before more building: **use it for a week with real data.** The envelope
      model is demanding and plenty of people bounce off it. Better to learn that from real
      use than to migrate the schema twice.
