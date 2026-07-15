# Budget App

Private budgeting app for Noah and one friend. Live, in real use.

- **Live:** https://budgetforus.vercel.app
- **Repo:** https://github.com/noaxh/budgetforus — its OWN git repo, not the desktop monorepo
- **Supabase:** project `budgetforus`, ref `aeqydektxshybtyjkekp`
- **Full history/rationale:** [NOTES.md](NOTES.md). Read it before proposing anything structural.

## Where this is going

**The app is being modeled on YNAB** — its interface and its feature set. This is the
governing direction. When a choice is ambiguous, the answer is usually "what does YNAB do".

The next real piece of work is **the envelope model**, and it is a migration, not a restyle:

- YNAB's core is `Category | Assigned | Activity | Available`, with "Ready to Assign"
  counting down to zero as you give every dollar a job.
- The current schema **cannot express this**. A category has one static `monthly_limit`.
  The envelope model needs **`assigned` per category per month** — a table that doesn't
  exist yet. `Assigned`, `Activity`, `Available` and Ready to Assign all fall out of it.
- v1's flat category+limit list is an **interim state**, not a design preference. It was
  a scope call.
- Doing this means: new table, a migration, and rewriting the category rendering. Budget
  the work accordingly. Anyone who says "make it look like YNAB" and means CSS has not
  understood the problem.

Also on the roadmap, in rough order of value:

1. Envelope model (above)
2. Category groups (YNAB nests categories under groups)
3. Targets per category (YNAB's goals)
4. Settle-up / who-owes-who — **only if asked**; the shared budget is a joint pot, not
   split costs, so this may never be wanted
5. Charts — explicitly deprioritized; nice to look at, changes no decisions

Deliberately **not** doing: bank sync (Plaid costs money and is most of the complexity in
every competitor), subscription cancellation, credit score, net worth, investments.

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
- Files: `index.html` / `styles.css` / `app.js` / `schema*.sql`. Keep each under 500 lines.
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

## Open items (as of 2026-07-15)

- [ ] **Rotate `sb_secret_…`** — pasted into a chat transcript, treat as burned. Nothing
      uses it, so rotating breaks nothing. Has been raised repeatedly and not yet done.
- [ ] **Disable sign-ups** (Auth → Sign-ups) once both users are in. Until then anyone
      with the public key can register an account. RLS still blocks their reads, so it's
      not an emergency — but it's one of three layers currently switched off.
- [ ] Add the friend to the shared budget:
      `insert into budget_members values ('<budget-id>', '<their-user-id>');`
- [ ] Recommended before more building: **use it for a week with real data.** The envelope
      model is demanding and plenty of people bounce off it. Better to learn that from real
      use than to migrate the schema twice.
