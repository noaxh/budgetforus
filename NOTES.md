# Budget App — Planning Notes

Shared budgeting website for two people (me + friend). Supabase backend, private access only.

Status: **LIVE.** Google login works end to end as of 2026-07-15.

- Live: https://budgetforus.vercel.app
- Repo: https://github.com/noaxh/budgetforus (own repo, separate from the desktop monorepo — keeps NDP client work out of the Vercel deploy)
- Supabase project: `budgetforus` / ref `aeqydektxshybtyjkekp`

| File | What |
|---|---|
| `index.html` | Markup |
| `styles.css` | All styling |
| `app.js` | Client logic, Supabase, auth |
| `schema.sql` | Tables, RLS policies, triggers |

Deploy: push to `main`, Vercel auto-deploys. Vercel settings — Preset "Other", Root `./`, no build command, no env vars (config is public by design and lives in `app.js`).

Local dev: `budget-app` config in `.claude/launch.json`, port 5620.
Self-check: load `?selftest`, console shows `selftest ok`.

### Still to do

- [x] ~~Rotate `sb_secret_…`~~ — done 2026-07-15.
- [ ] **Onboard the friend, then close signups.** Sign-ups are still on deliberately; closing them first locks the friend out. Order:
      1. Add their Gmail as a **test user** on the Google OAuth consent screen (still in Testing mode — Google refuses anyone not listed, and it looks like a broken login rather than a permissions error).
      2. They sign in at the live URL.
      3. Authentication → Users → copy their id.
      4. `insert into budget_members values ('<budget-id>', '<their-user-id>');` — get the budget id from `select id, name from budgets;`
      5. **Then** Auth → Sign-ups → disable.

### Setup traps hit along the way (for next time)

The OAuth chain took four rounds. In order:

1. **`redirect_uri_mismatch`** — Google's "Authorized redirect URIs" needs `https://aeqydektxshybtyjkekp.supabase.co/auth/v1/callback` exactly. Easy to mis-paste into "Authorized JavaScript origins" right above it, which rejects paths.
2. **Bounced to `localhost:3000`** — when `redirectTo` isn't allowlisted, Supabase silently falls back to Site URL, which defaults to `localhost:3000`. Fix in Auth → URL Configuration. Needs the `/**` wildcard, since the app sends `origin + pathname`.
3. **`Unable to exchange external code`** — stale Client Secret. The Client ID matched, but a second OAuth client had been created and only the ID field was updated. The secret is masked in both UIs, so it can't be verified by eye — re-issue it rather than trying to compare.
4. Google Cloud Console needs **no change** when the app's own URL changes. Google only ever redirects to the Supabase callback; Supabase redirects onward.

---

## Architecture

Supabase is **not** a website host. It gives you Postgres + Auth + auto-generated API + Storage. The frontend goes somewhere else:

- Frontend: Vercel / Netlify / Cloudflare Pages (free tier fine)
- Backend: Supabase (Postgres + Auth)
- They talk over HTTPS

Consequence: the frontend JS ships to the browser, so **the Supabase anon key is public**. Anyone can read it in devtools. That's by design. The anon key is not a secret, it's a "which project" pointer. RLS is the actual lock.

### The two keys

| Key | Where it lives | What it does |
|---|---|---|
| `anon` / publishable | Browser, public, fine to expose | Subject to RLS |
| `service_role` | Server only, never in frontend, never in git | **Bypasses RLS entirely** |

`service_role` leaking into client code or a public repo = whole database readable by anyone who finds it. Biggest single risk. This project probably needs it never.

---

## Frontend delivery (iPhone)

Target is both of us using it on our phones. Plan: **single responsive HTML file, deployed free, Add to Home Screen.**

Safari → Share → Add to Home Screen gives a springboard icon, full-screen with no browser chrome, working `localStorage`. Behaves like a real app. Same HTML as desktop — "mobile version" is just the viewport tag plus responsive CSS, not a separate build.

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Budget">
```

```css
body {
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
           env(safe-area-inset-bottom) env(safe-area-inset-left);
}
```

### Why not just open the .html from the Files app

Considered and rejected. iOS can do it, but:

- `localStorage` on `file://` origins in Safari is unreliable — data may not persist. Fatal for this.
- `<script type="module">` and `fetch()` of local files are CORS-blocked on `file://`.
- No Add to Home Screen.

And two blockers specific to this app, independent of the above:

- Google OAuth needs a real `https://` origin to redirect back to. No `file://` login flow exists. Adding Supabase auth makes hosting mandatory.
- The friend needs it on *their* phone. Anything local to one machine only ever serves one person.

### Dev loop

To see changes on the iPhone while building: run the dev server bound to the network (`npx vite --host`, or `python -m http.server` for a plain file), open `http://<pc-lan-ip>:5173` in Safari. Same Wi-Fi, PC on. Build loop only — not a way to run the app day to day.

Supabase login won't work over that LAN IP unless it's added to the redirect allowlist. Easier to test auth against the deployed URL.

---

## Access control — locking it to two people

Three layers, all needed:

1. **Disable public signups** (Auth settings) after both accounts exist. Otherwise anyone with the anon key registers themselves and RLS treats them as a legitimate logged-in user. Most-skipped step.
2. **Enable RLS on every table.** Dashboard-created tables get it by default; raw-SQL-created tables do **not**. Check each one.
3. **Write policies scoping rows to budget members.**

### Schema sketch

```sql
create table budgets (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table budget_members (
  budget_id uuid references budgets(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  primary key (budget_id, user_id)
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references budgets(id) on delete cascade,
  amount numeric(12,2) not null,
  description text,
  occurred_on date not null default current_date,
  created_by uuid not null default auth.uid() references auth.users(id)
);

alter table budgets enable row level security;
alter table budget_members enable row level security;
alter table transactions enable row level security;

-- helper: is the caller a member of this budget?
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

create policy "members read transactions"
  on transactions for select
  using (is_budget_member(budget_id));

create policy "members write transactions"
  on transactions for insert
  with check (is_budget_member(budget_id) and created_by = auth.uid());

create policy "members update transactions"
  on transactions for update
  using (is_budget_member(budget_id))
  with check (is_budget_member(budget_id));

create policy "members delete transactions"
  on transactions for delete
  using (is_budget_member(budget_id));
```

Two things this sketch is deliberately doing:

- `security definer` on the helper avoids infinite recursion — a policy on `budget_members` that queries `budget_members` will loop.
- `using` filters what you can **see**; `with check` validates what you're allowed to **write**. Insert needs `with check` or a member can attribute rows to someone else, or write into a budget they don't belong to. Most common RLS bug.

`budgets` and `budget_members` still need their own policies written — not sketched above.

---

## Auth — Google OAuth ("Sign in with Google")

Chosen over magic links and passwords. Both of us are on Gmail. No password to leak, no reset flow to attack, inherits Google account MFA.

Rejected: **magic links**. Work fine, zero Google setup, but Supabase's built-in mailer is rate-limited to a few messages/hour on free and lands in spam. Reliable version needs own SMTP (Resend free tier). More setup, worse experience. Only revisit if someone isn't on Gmail.

### Setup (~10 min, mostly in Google Cloud Console)

1. Google Cloud Console → new project → **OAuth consent screen**. External, app name + email. Leave publishing status **Testing**, add both Gmail addresses as test users. Free second lock — Google refuses anyone not listed.
2. **Credentials → Create OAuth client ID → Web application.** Authorized redirect URI, exactly:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   Must match character-for-character or you get `redirect_uri_mismatch`. Most common failure.
3. Copy Client ID + Secret → Supabase dashboard → **Authentication → Providers → Google** → toggle on, paste, save.
4. Supabase dashboard → **Authentication → URL Configuration**. Site URL = prod domain. Add `http://localhost:5173` (or dev port) to Additional Redirect URLs. Skip this and login works in prod but silently bounces in dev.

### Client code

```js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

async function signIn() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  })
  if (error) console.error(error)
}

async function signOut() {
  await supabase.auth.signOut()
}

// fires on login, logout, token refresh, and page load with restored session
supabase.auth.onAuthStateChange((event, session) => {
  render(session?.user ?? null)
})
```

Library handles the redirect round-trip, session storage, token refresh. Build the UI around `onAuthStateChange` — don't read the session synchronously on page load, it hasn't restored yet.

**Auth method doesn't affect the schema.** `auth.uid()` is the Supabase user id, not the Google one. Supabase mints its own user row on first OAuth login and manages its own session afterward; Google is only consulted at the login moment. Can start with magic links and switch to Google later, policies don't care.

---

## Hardening

- MFA on the **Supabase dashboard account** itself. That login has full database access and skips every policy — bigger risk than the app.
- Run Supabase's security advisor after schema setup. Flags RLS-off tables, weak policies, exposed views.
- **Backups.** Free tier has nothing worth relying on. Either Pro (daily + point-in-time recovery) or a scripted periodic `pg_dump`. Data loss is likelier to hurt than a breach.
- Turn on leaked-password protection if passwords ever get used (checks HaveIBeenPwned).

### Not doing

**Column encryption via pgcrypto.** Supabase already encrypts at rest, TLS in transit. App-level column encryption breaks summing and filtering amounts — the entire point of a budgeting app — and defends a threat model we don't have.

---

## Realistic threat model

Two people, private budget, no public surface. Actual risk is basically four things:

1. Leaked `service_role` key
2. Signups left enabled
3. A table where RLS was never turned on
4. Losing/compromising the Supabase dashboard password

Everything else is secondary.

---

## Design direction: model on YNAB (decided 2026-07-15)

The app is being deliberately modeled on YNAB — its interface and its feature
set. This supersedes the "collapse it to two numbers" simplifications made for
v1; those were scope calls, not preferences, and they get revisited as we take
more of the real model.

**What we take:** the envelope model itself (assign every dollar a job, Ready to
Assign counts down to zero), the `Category | Assigned | Activity | Available`
table, category groups, targets, the red/yellow/green/gray Available semantics,
the icon vocabulary, the Inspector sidebar, progress bars, the layout and
information density. Interface conventions and product mechanics are fair game
and are the substance of what makes YNAB good.

**What we build in their idiom rather than copy outright:** their logo, and
Wishfarm (their proprietary display face). Figtree — their body font — is
open-source under the OFL, so that one we can use directly. A close visual
relative without lifting their brand marks costs us nothing here, since the
value is in the interaction model, not the wordmark.

Palette pulled from their site, for reference:
`#FEF9ED` cream canvas, `#545BFE` blurple, `#AEE865` lime, `#1C1F58` navy ink.
6–8px radii, no shadows, large type (h1 64px, body 24px).

Implication: v1's flat category list with a monthly limit is an interim state.
The envelope model needs `assigned` per category per month, which the current
schema has no place for — that's the next real migration, not a coat of paint.

---

## Competitor research (2026-07-15)

Top three by consistent placement across NerdWallet, CNBC, Forbes, Kiplinger, Ramsey: **YNAB, Monarch Money, Rocket Money**. Mint shut down 2024, don't bother looking at it.

Caveat on the design numbers below: pulled from marketing sites, not the in-app UI. Good proxy for each brand's design language, not literally the product screens.

### YNAB — the one to steal the model from

Zero-based envelope budgeting. Every dollar gets assigned a job until "Ready to Assign" hits 0. The budget screen is a **category table**: `Category | Assigned | Activity | Available`, grouped into Category Groups, optional progress bar under each row.

The valuable part is the **color semantics in the Available column** (from their own docs):

| Color | Meaning |
|---|---|
| Red | Cash overspending. Immediate action, move money now. |
| Yellow | Underfunded — credit overspend, or not enough assigned for an upcoming target/scheduled txn. |
| Green | Positive, covers what's upcoming, on track for target. |
| Gray | Zero and not underfunded. |

Icons layer more detail on top (credit card = credit overspend, calendar = scheduled txn unfunded, pie = target progress, check = target met, Zz = snoozed). Right sidebar "Inspector" shows detail for the selected category.

Design: warm cream `#FEF9ED` bg, blurple `#545BFE` primary, lime `#AEE865` CTA, navy `#1C1F58` text. 6–8px radius, no shadows. Figtree body / Wishfarm heading. Big type — h1 64px, body 24px.

### Monarch — the one to steal the sharing model from

Dashboard-first. Net worth, flexible (non-envelope) budgets, reports, goals, 13k+ institutions synced.

**The couples model is exactly what we picked**: invite someone to your "household" → they get their own separate login, contribute their own data, and you get one shared view spanning both separate *and* joint accounts. Tag your partner on a transaction for review. Monthly summary for check-ins. Personal budgets stay personal, household view sits on top. Free — no extra seat cost.

Design: warm off-white `#F6F5F3` bg, orange `#FF692D` primary, near-black `#22201D` text. Fully-round pill buttons (9999px), 8px card radius, whisper-thin shadows (5% alpha). Copernicus serif headings over ABC Oracle body — that serif/sans split is what makes it read "considered" rather than "fintech template". Small body text (15px). Tailwind.

### Rocket Money — least relevant to us

Subscription manager that grew a budget feature, not the reverse. Finds and cancels unwanted subscriptions, negotiates bills, tracks credit score, autosaves. 10M+ members, claims $2.5B saved. Free tier with pay-what-you-want premium.

Design: white bg, black pill buttons, red `#DE3341` accent, electric blue `#0000EE`. Sharp 0px corners everywhere except fully-round buttons. h1 56px. Framer site.

### What we take / leave

Take: YNAB's category table + the red/yellow/green/gray semantics. Monarch's household model (personal budgets + one shared view) and its warm-neutral, flat, serif-heading restraint.

Leave: bank sync (Plaid costs money and is most of the complexity in all three), subscription cancellation, credit score, net worth, investments, goals, reports. (Superseded note: this v1-era list also said "leave envelope rollover and Ready to Assign." v3 built both. They are the core now, not skipped.)

All three land on a warm off-white background rather than pure white, restrained palette, one saturated accent, near-zero shadow. Converging on that is a signal, not a coincidence.

---

## v1 spec (decided 2026-07-15)

- **Model**: personal *and* shared. Monarch household style — each person has their own budget, plus one shared budget both belong to. Switcher between them.
- **Stack**: single-file HTML + JS. No build step. Supabase via CDN script tag.
- **Scope**: log/list/edit/delete transactions, categories with monthly limits, progress against limit. Auth + RLS working.

Deliberately out of v1: recurring transactions, charts/trends, settle-up/who-owes-who, bank sync.

### Simplifications vs YNAB (ponytail)

- ~~No envelope rollover, no "Ready to Assign", no targets engine. A category has a **monthly limit**; spent = sum of that month's transactions; available = limit − spent.~~ **Superseded by v3 — see below.**
- ~~Color rule collapses YNAB's four states into something derivable from two numbers: over limit → red, ≥80% → yellow, under → green, no limit set → gray.~~ **Superseded by v3.**
- No `kind` column on budgets. A personal budget is just a budget with one member; shared is one with two. Membership already encodes it — the switcher lists whatever you belong to.

### Schema

Adds to the sketch above: `categories (id, budget_id, name, monthly_limit, sort)`, and `transactions.category_id`.

**Superseded, read the real files.** The two schema sketches in this document (the
Access-control sketch and this v1 one) predate the migrations that actually
shipped. v2 (`schema-v2.sql`) added `transactions.kind` and the `recurring` table;
v3 (`schema-v3.sql`) added `assignments`. The sketches show `transactions` with no
`kind` and no `recurring_id`, which is no longer true. Trust `schema.sql` +
`schema-v2.sql` + `schema-v3.sql`, not the prose sketches.

---

## v3 — the envelope model + deleting budgets (2026-07-15)

`schema-v3.sql`. The thing v1 called an interim state. YNAB's actual core, and the reason
it isn't just CSS: a category's plan stopped being one static number and became
**one row per category per month**.

### Deleting budgets

The client could always have called `delete()`. RLS refused, silently, because `schema.sql`
never wrote a delete policy for `budgets` — the one table that got read/insert/update and
no delete. One policy is the whole feature; every child table already cascades.

The confirm is **type-the-budget-name**, not `confirm()`. This wipes every category,
transaction, assignment and rule in the budget with no undo, and the control lives on a
phone. It sits at the bottom of the page, deliberately far from the header where the
budget *switcher* is.

### The model

| | |
|---|---|
| `assigned` | what you gave the category **this** month (`assignments` row) |
| `activity` | what happened to it this month — negative is spending |
| `available` | every assignment + every activity, **cumulative over all months** |
| Ready to Assign | uncategorized income − everything assigned − uncategorized spending |

Available rolling forward is what forces the whole-history fetch: no number here can be
read off a single month, so `loadMonth` now pulls every transaction up to the end of the
month on screen and sums it in the browser. **Ceiling: PostgREST's row cap.** A truncated
fetch wouldn't error — it would sum fewer rows and quietly under-report. Two people and a
few hundred transactions a year is thousands of rows away from it; move the rollup into a
SQL view before it gets close.

### Three places we knowingly differ from YNAB

1. **Negative Available rolls forward as negative.** YNAB resets the category to zero and
   docks next month's Ready to Assign. Ours leaves the hole in the category that dug it,
   which is one cumulative sum instead of a month-by-month walk. `rollup()` is the rewrite
   point if YNAB's exact behaviour is ever wanted.
2. **Uncategorized expense comes straight out of Ready to Assign.** YNAB won't let such a
   transaction exist; we allow it, so it has to leave the pot somewhere or RTA keeps
   offering money that's already spent.
3. **No yellow.** YNAB's amber means "target not met" and there's no targets engine. Ours
   means "funded and spent to exactly zero".

Income **filed under a category is a refund** — it refills that one envelope and never
touches Ready to Assign. This is a real behaviour change: under v1 income in a category was
ignored so a paycheque tagged "Groceries" couldn't buy back headroom. Under v3 it would.
Paycheques belong uncategorized; that's what makes them new money.

### monthly_limit

Kept, not dropped. It stops being *the plan* and becomes **the target** — the usual monthly
amount that the Auto-assign button fills empty envelopes to. That's YNAB's auto-assign
minus the target types, and it's what makes the start of a month one tap instead of twelve.
Auto-assign only touches categories still on zero; overwriting a number typed on purpose is
not a convenience. Roadmap item 3 (a real targets engine) is what brings the yellow back.

The migration seeds the **current month only** from `monthly_limit`. Backfilling past months
would invent assignments nobody made and produce a fictional history of Available.

---

## YNAB feature parity — full audit (2026-07-16)

Researched YNAB's complete feature set (its `/features` page plus the support
glossary, which lists every in-app term and action) and mapped each one against
this app. The point is not to build all of it. It is to have a single place that
says, for every YNAB feature, whether we have it, are missing it, or are choosing
to skip it, so the roadmap is a set of decisions rather than a set of surprises.

Status legend:

- **HAVE** — shipped and working.
- **PARTIAL** — a subset works; the gap is named.
- **PLANNED** — worth building, plan below.
- **OPTIONAL** — only if the account subsystem is ever wanted; low value for a
  two-person joint pot.
- **SKIP** — deliberately not doing, reason given.

### Core envelope model

| YNAB feature | Status | Note |
|---|---|---|
| Zero-based planning | HAVE | v3 core |
| Categories | HAVE | flat list today |
| Category Groups | HAVE | label-based (`categories.group_name`, schema-v4), grouped render with per-group Available subtotal; display only, `rollup()` untouched (2026-07-16) |
| Assigned / Activity / Available columns | HAVE | v3 |
| Ready to Assign | HAVE | v3, with the uncategorized-expense divergence |
| Monthly rollover | HAVE | Available rolls forward; three documented divergences |
| Move money between categories (Whack-a-Mole) | PARTIAL | reassign works; no dedicated "move from X to Y" quick UI |
| Auto-Assign | HAVE | modes sheet: fill empty to target, assign last month's amounts, assign last month's spending, clear to zero (2026-07-16). Average and underfunded deferred (underfunded needs Phase B targets) |
| Over-assigning (red Ready to Assign) | HAVE | v3 |
| Cash overspending (red Available) | HAVE | v3 |
| Credit overspending (yellow Available) | SKIP | no credit-card subsystem, see below |

### Targets / goals (the keystone gap)

| YNAB feature | Status | Note |
|---|---|---|
| Targets (spend / save / set-aside per category) | PLANNED | `monthly_limit` is a one-type proto-target today |
| Goal types: monthly, weekly, by-date, "have a balance of", "set aside another" | PLANNED | by-date needs remaining / months-left math |
| Underfunded (yellow) state | PLANNED | falls out of targets; this is what brings back YNAB's yellow |
| Cost to Be Me | PLANNED | sum of month's targets vs entered expected income; one header stat once targets exist |
| Category / plan templates | SKIP | targets across all categories already are the template; import/export is low value for two people |

### Accounts and balances

| YNAB feature | Status | Note |
|---|---|---|
| Multiple accounts (checking / savings / cash) | OPTIONAL | app is one pot today; joint-pot use may never need per-account balances |
| Account register | HAVE | the transaction list is the register |
| Cleared / Uncleared / Working balance | OPTIONAL | needs the accounts table + a `cleared` flag |
| Reconcile | OPTIONAL | needs accounts + cleared; enter bank balance, app writes an adjustment |
| Tracking accounts (assets, investments, loans, off-plan) | OPTIONAL | `on_budget = false` |
| Net Worth | OPTIONAL | assets minus liabilities; needs tracking accounts |

### Credit cards

| YNAB feature | Status | Note |
|---|---|---|
| Credit Card Payment category (auto) | OPTIONAL | YNAB's single most complex subsystem |
| Credit Card Float / Paid in Full | OPTIONAL | reporting on top of the payment category |
| Credit overspending logic | OPTIONAL | this is the real source of "yellow means credit" |

### Bank connectivity

| YNAB feature | Status | Note |
|---|---|---|
| Direct Import (bank linking) | SKIP | Plaid costs money and is most of the complexity in every competitor. Locked. |
| File-based import (CSV / OFX / QFX / QIF) | PLANNED | drag-drop a bank export, parse, dedupe. No Plaid, no cost. The cheap way to get most of import's value. |
| Apple Card import | SKIP | a special case of file import, not a separate feature |
| Pending transactions | SKIP | only meaningful with Direct Import |

### Transactions

| YNAB feature | Status | Note |
|---|---|---|
| Add / edit / delete | HAVE | |
| Scheduled / recurring transactions | HAVE (basic) | shipped in v2 as the `recurring` table: day-of-month rules, explicit per-month "Add them", once-per-month unique index. Enhance later, do not rebuild |
| Split transactions | PLANNED | one transaction across categories; child table or `parent_id` |
| Payees | HAVE (light) | `description` autocompletes from distinct past descriptions via a datalist, no payees table (ponytail, 2026-07-16) |
| Flags / color tags | HAVE (light) | `transactions.flag` (schema-v4, 6-colour check), flag picker in the txn sheet, coloured dot on the row. Filter-by-flag still to add (2026-07-16) |
| Bulk action bar (multi-select) | PLANNED (light) | select rows, categorize / flag / delete together |
| Export transactions to CSV | HAVE (light) | Export button dumps the month on screen (`state.txns`) to CSV (2026-07-16) |
| Transfers between accounts | OPTIONAL | needs accounts |
| Approve / match imported | SKIP | only with import |
| Pin frequent categories | SKIP | nicety |

### Reflect / reports

| YNAB feature | Status | Note |
|---|---|---|
| Spending breakdown (by category) | PLANNED | charts were deprioritized, but this one changes decisions |
| Income vs Expense (cash flow) | PLANNED (light) | one table per month range |
| Age of Money | PLANNED (light) | derivable from transaction history; niche |
| Net Worth report | OPTIONAL | needs tracking accounts |
| Money Moves (history of category moves) | PLANNED (light) | log assignment changes, show the trail |

### Debt

| YNAB feature | Status | Note |
|---|---|---|
| Loan / debt paydown calculator | PLANNED (optional) | pure client math (principal, APR, payment -> payoff date, interest saved). Self-contained, no schema. |
| Interest tracking | OPTIONAL | needs loan accounts |

### Lifecycle, platform, sharing

| YNAB feature | Status | Note |
|---|---|---|
| Multi-device sync | HAVE | Supabase |
| Multiple plans / budget switcher | HAVE | v3 |
| Delete a budget / plan | HAVE | type-the-name confirm, cascades to every category, transaction, assignment and rule; `members delete budget` policy (schema-v3), handler + danger-zone button shipped. See "Deleting budgets" section |
| Rename a budget / plan | HAVE | pencil button beside the switcher, native prompt, `members rename budget` policy; also the fix for two budgets sharing a name |
| YNAB Together (share one sub, up to 6) | PARTIAL | `budget_members` already supports N members; sharing model differs but the capability is there |
| Hide amounts toggle | HAVE | header eye toggle blurs every `.num`/`.pill`, remembered in localStorage (2026-07-16) |
| Focused / customizable views | PLANNED (light) | show/hide columns, collapse groups |
| Fresh Start / Plan Reset | PLANNED | archive current plan, keep categories / targets / scheduled / payees |
| Offline access | SKIP (later) | service-worker PWA is a real lift; revisit after the above |
| Mobile widgets | SKIP | needs a native app; this is a web PWA |
| Forecasting (assign future money) | SKIP | YNAB itself frames it as the risky cousin; against the "money you already have" ethos |
| Public API | SKIP | it is our own app |

---

## Build plan for the gaps (phased, 2026-07-16)

Ordered by value-per-effort and by dependency. Each phase is independently
shippable. Effort is rough: S = an afternoon, M = a day or two, L = a week-ish.

**Phase A — cheap wins, no dependencies.** Each is a small isolated change; do
them in any order between bigger work.

Note: the *shell itself* (tokens, the category table, and the four Available
states) was already built in `styles.css` and is AA-verified. Measured 2026-07-16
by compositing each tint over the white card: green 5.79, amber 4.89, red 5.32,
gray 6.76, all past 4.5:1. So Phase A is just the cheap-win features below, not a
restyle.

- Category groups (S). **DONE 2026-07-16.** Label-based (`categories.group_name`,
  schema-v4), grouped render with a per-group Available subtotal. `rollup()`
  never sees a group.
- Flags / color tags (S). **DONE 2026-07-16.** `transactions.flag` (schema-v4,
  6-colour check), picker in the txn sheet, coloured dot on the row.
  Filter-by-flag still to add.
- Hide-amounts toggle (S). **DONE 2026-07-16.** Header eye toggle blurs every
  `.num`/`.pill`, remembered in localStorage.
- Payee autocomplete (S). **DONE 2026-07-16.** Distinct past descriptions feed a
  datalist. No payees table.
- Export to CSV (S). **DONE 2026-07-16.** Export button dumps the month on screen.
- Auto-assign modes (M). **DONE 2026-07-16.** Fill empty to target, last month's
  amounts, last month's spending, clear to zero. Average and underfunded deferred
  (underfunded needs Phase B). All derive from existing data, no schema change.

Phase A is complete. Next substantive work is Phase B (the targets engine).

**Phase B — the targets engine.** The single highest-value gap. It is what
turns `monthly_limit` from one flat number into YNAB's real goals, and it is the
only thing that can express the yellow "underfunded" state v3 cannot.

- `targets (category_id, kind, amount_cents, due_date, cadence, created_month)`.
  Kinds: monthly refill-to, weekly, by-date savings, have-a-balance-of,
  set-aside-another.
- `rollup()` gains a per-category "needed this month" and a funded/underfunded
  verdict, which drives the yellow state.
- Auto-assign learns "fill to target".
- Cost to Be Me (S, after the above): sum of the month's needed amounts, an
  expected-income input, and a covered / short banner.
- Ceiling to name in a `ponytail:` comment: by-date math assumes even monthly
  contribution, not front-loading.

**Phase C — richer transactions.**

- Recurring transactions: **already shipped** (v2 `recurring` table, explicit
  per-month "Add them"). Only enhancements remain (S to M): optional auto-apply
  on month open, cadences beyond day-of-month (weekly, every-N-months), and
  feeding a rule's next occurrence into Phase B's by-date "upcoming" targets.
  Extend `recurring`; do not add a second `scheduled_transactions` table.
- Split transactions (M). `parent_id` self-reference on `transactions`; the
  parent nets to the split total, children carry the categories.
- Bulk action bar (M). Multi-select, then categorize / flag / delete in one go.
- Money Moves history (M). Append-only log of assignment changes; a read-only
  trail per category.

**Phase D — reflect / reports.**

- Spending breakdown (M). Category totals for a month range, a simple bar or
  donut. This is the one report that changes decisions.
- Income vs Expense (S to M). A cash-flow table over a range.
- Age of Money (M). Rolling average age of spent dollars from transaction
  history. Niche, do last in this phase.

**Phase E — accounts subsystem (OPTIONAL, biggest architectural change).**
Only start this if per-account tracking, reconciliation, or net worth is
actually wanted. For a two-person joint pot it may never be. If it is:

- `accounts (id, budget_id, name, type, on_budget)` + `transactions.account_id`.
- `transactions.cleared` and a Working Balance per account.
- Reconcile flow (enter bank balance, write an adjustment, lock prior rows).
- Transfers between accounts (one movement, two register lines).
- Tracking accounts (`on_budget = false`) unlock a Net Worth report.
- Credit-card handling last and separately (L): the auto payment category, the
  float, paid-in-full, and the credit-overspend yellow. This is genuinely the
  hard part of YNAB; do not start it casually.

**Phase F — standalone tools and lifecycle.** No dependency on the others.

- File-based CSV / OFX import (M). Drag-drop, map columns, dedupe against
  existing rows by date + amount + description. The sanctioned alternative to
  the skipped Plaid import.
- Loan / debt calculator (M). Pure client math, no schema. Principal, APR, and
  payment in; payoff date and interest-saved-per-extra-dollar out.
- Fresh Start / Plan Reset (M). Archive the current plan, carry categories,
  targets, scheduled transactions, and payees into a clean one.
- Focused views (S). Show/hide columns, remember collapsed groups.

### Recommended order

Phase A (quick momentum) then B (targets, the real substance) then C, then D.
E and F are opt-in and can slot in whenever a specific need shows up. Everything
still honors the locked decisions: static files, no build step, `kind` column
never signed amounts, integer cents, RLS as the only gate, no Plaid.

---

## Visual and layout spec — YNAB parity (2026-07-16)

Goal: the app should read as YNAB at a glance. This section is the design system
and a screen-by-screen layout so any build phase renders into a settled look
rather than inventing one per feature. It is copied from YNAB's actual app (web
sidebar + Inspector, mobile five-tab), not just the marketing site.

What we copy: the layout, the information density, the category table, the
Available color and icon language, the Inspector, the register columns, the
five-tab mobile shell. What we do not lift: YNAB's logo and its proprietary
display face Wishfarm. Figtree (their body font) is OFL-licensed and we use it
directly; for headings we pick a close open display face. Copying interaction and
layout is the point; copying brand marks is not.

### Design tokens (exact)

Pulled from YNAB via Firecrawl branding extract.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FEF9ED` | cream canvas, every screen |
| `--ink` | `#1C1F58` | navy, primary text and numbers |
| `--brand` | `#545BFE` | blurple, primary actions, selected state, links |
| `--accent` | `#AEE865` | lime, main CTA fill only (sparingly) |
| `--surface` | `#FFFFFF` at ~60% over cream | glass chrome only (header, tab bar, sheets) |
| radius | `6px` controls, `8px` cards | never fully round except avatars |
| elevation | none | flat. No content shadows. Chrome uses a 1px hairline + blur, not a drop shadow |
| base unit | `4px` | all spacing is a multiple of 4 |

Body font Figtree. Headings: an open display face standing in for Wishfarm.
Numbers use Figtree with `font-variant-numeric: tabular-nums` so columns align.

App type scale (denser than the 64/40/24 marketing scale, which is for landing
pages, not a data table):

| Role | Size / weight |
|---|---|
| Screen title | 28 / 600 |
| Section + group header | 17 / 600 |
| Category name, register text | 16 / 500 (16 is also the iOS no-zoom input floor) |
| Money numbers | 16 / 600 tabular |
| Ready to Assign figure | 32 / 700 tabular |
| Meta (dates, hints, secondary) | 13 / 500 |

### State colors (the heart of the Available column)

These four states are the most important visual language in the app. YNAB colors
the Available amount, not the whole row. We render Available as a **pill** when it
needs attention (red or yellow) and as a **plain colored number** when it does not
(green or gray), which matches YNAB and keeps the table calm.

| State | Meaning | Rendering | Proposed color |
|---|---|---|---|
| Green | positive, covers what is upcoming, on target | plain number | `#1F7A3D` on cream |
| Yellow | underfunded: credit overspend, or not enough for an upcoming target/scheduled txn | pill, dark text | navy `#1C1F58` on `#F2C94C` |
| Red | cash overspending, act now | pill, light text | `#FBF3E4` on `#C2412D` |
| Gray | zero and not underfunded | muted number | `#8A8DA8` on cream |

Hard rule (project): every one of these must be **measured** at AA 4.5:1, not
eyeballed. Translucency in the glass chrome eats contrast; numbers never sit on
glass. The values above are starting points, contrast-check before shipping.

**Current vs target semantics (important).** The yellow row above is the *Phase B*
meaning, matching YNAB ("underfunded"). The code today does not mean that. Until
the targets engine ships, `envStatus` in app.js returns only three of these plus
one of its own: over to red, ok to green, none to gray, and `close` (Available is
exactly zero and the category was touched) which renders amber and means "funded
and spent to zero", not "underfunded". That amber is a pre-targets stand-in. When
Phase B lands, yellow flips to YNAB's meaning, the `close` state folds into gray
or green, and the `envStatus` selftest assertion changes with it. Do not wire new
UI to "yellow = underfunded" before Phase B exists.

### Iconography (Available column, web parity)

YNAB layers an icon on top of the color to say *why*. Build this set:

| Icon | Trigger | Where detail shows |
|---|---|---|
| Credit card + `!` | credit overspending (most urgent) | Inspector: cover-from menu |
| Calendar | a scheduled txn later this month is unfunded | Inspector: amount assigned vs needed |
| Pie (partly filled) | target set, not yet fully funded this month | Inspector: amount still needed |
| Green check circle | target met this month | celebratory, no action |
| Zz snooze | target snoozed this month | no nag this month |

Snooze + yellow together means a scheduled txn still needs funding even though
the target is snoozed. These icons only appear on wide layout (web parity); on
phone the color plus the Inspector sheet carry the same information.

### App shell and navigation

Two layouts off one responsive HTML file, breakpoint at 768px.

**Phone (primary target), bottom tab bar, five tabs matching YNAB mobile:**

```
┌───────────────────────────────┐
│  glass header: ‹ Month Year ›  │  month nav + overflow (⋯)
│  Ready to Assign  $0.00        │  sticky banner, colored by state
├───────────────────────────────┤
│                               │
│   active tab content          │
│                               │
│                    ( + )      │  FAB: Add Transaction (glass)
├───────────────────────────────┤
│ Home  Plan  Spending  Acct  Reflect │  glass tab bar, 44px targets
└───────────────────────────────┘
```

**Desktop / wide, left sidebar + optional right Inspector (YNAB web):**

```
┌────────────┬───────────────────────────────┬────────────┐
│  sidebar   │  ‹ Month Year ›   Auto-Assign  │ Inspector  │
│  Plan      │  Ready to Assign  $0.00  ↺ ↻   │  (selected │
│  Reflect   ├───────────────────────────────┤  category  │
│            │  CATEGORY  ASSIGNED  ACT  AVAIL │  detail)   │
│  Accounts: │  ▾ Group name        subtotal   │            │
│   Checking │    Category ▓▓▓░  120  -40  80  │            │
│   Savings  │    Category ▓▓▓▓  200    0 200  │            │
│  All Accts │  ▾ Group name                   │            │
│  + Add     │    ...                          │            │
│            │                                 │            │
│ Budget ▾   │                                 │            │
└────────────┴───────────────────────────────┴────────────┘
```

The budget switcher (personal vs shared) sits at the sidebar bottom on desktop
and behind the header overflow on phone. This is the existing switcher, kept.

### Screen 1 — Plan (the hero screen)

Header: month navigation (`‹ Month Year ›`), the Ready to Assign banner,
Auto-Assign, and undo/redo on wide. Ready to Assign banner has three states:
positive (green, "Assign" affordance), zero (gray, calm), negative (red,
"You assigned more than you have").

Category table columns, left to right:

| Column | Content |
|---|---|
| (select) | wide only, checkbox for bulk actions |
| Category | name, plus an optional progress bar underneath (toggle) |
| Assigned | this month's assigned amount, tap to edit inline |
| Activity | sum of this month's transactions, tap opens the activity list |
| Available | the colored pill/number + icon described above |

Category groups are collapsible rows with a bold name and a right-aligned group
subtotal for each column. Reorder by drag on wide, by long-press on phone. A
category row is the atomic unit: name, optional progress bar, three numbers,
44px tall minimum. Empty state: a single "Add your first category" prompt.

### Screen 2 — Inspector (category detail)

Desktop: right sidebar, always present, shows the selected category (or a hint to
select one). Phone: a bottom sheet that rises when a category is tapped. Same
content both places, top to bottom:

- Category name + Available figure, large.
- Target block: the target if one is set (Phase B), a progress ring/bar, "assigned
  X of Y needed", and a snooze control.
- Auto-Assign row: quick buttons (fill to target, assigned last month, spent last
  month, average, underfunded, reset to zero).
- Cover overspending / Move money: when red or yellow, a "cover from" picker
  listing funded categories; this is the money-move interaction.
- Activity: this month's transactions in the category, tappable.
- Notes: free text on the category.

### Screen 3 — Spending / Account register

Phone "Spending" tab: one list of every cash and credit transaction (tracking
accounts excluded), newest first. Wide: per-account registers reached from the
sidebar, plus an All Accounts view.

Register columns (wide): Flag, Date, Payee, Category, Memo, Outflow, Inflow,
Cleared. Optional Running Balance column via the View menu. Sort by clicking a
column header (flags by color, date asc/desc, text alphabetical, amounts by
value, cleared by state). Default sort: date descending, then by amount within a
date.

Cleared states, three, shown as a `C` chip / lock:

| State | Look | Meaning |
|---|---|---|
| Uncleared | outline `C`, muted | entered, bank does not know yet |
| Cleared | filled green `C` | bank knows, matched |
| Reconciled | lock | frozen at a past reconcile |

Search is additive (stack terms), with suggested searches, filtering by amount,
payee, category, flag, memo, cleared state, approved, inflow/outflow, date. A
Select mode reveals checkboxes and a live **selected total** at the top. On phone
this is long-press to enter select mode; on wide it is the header checkbox.

### Screen 4 — Add / edit transaction (sheet)

A bottom sheet (phone) or modal (wide). Fields, in order: Account, Date (default
today), Payee (autocomplete from history), Category, Memo, and a single amount
that toggles Outflow/Inflow. Secondary controls: Flag color, Cleared toggle,
Split (add sub-rows that must sum to the total), and Repeat (turns it into a
scheduled transaction, Phase C). Money input is 16px+ so iOS does not zoom.

### Screen 5 — Reflect (reports)

A tab (phone) / sidebar section (wide) holding, in this order of build value:
Spending Breakdown (donut or bar of category totals for a range), Net Worth
(month-by-month assets vs debts, needs the accounts subsystem), Income vs Expense
(cash-flow table), and Age of Money (single metric with a small trend). Each
report has a range selector and an export-to-CSV action. These map to Phase D,
and Net Worth waits on Phase E.

### Screen 6 — Home (phone only)

YNAB's mobile landing tab. Top: action alerts (money to assign, transactions to
approve, overspending to cover), each a tappable card in the state color. Then:
pinned priority categories, a Current Goal, a month summary, and month-ahead
progress. This is a convenience surface over data other screens own; build it
after the Plan and Spending screens exist.

### Motion and interaction

- Money moving between categories animates the two Available figures counting.
- Ready to Assign counts to its new value on assign.
- Sheets slide up with a spring; the Inspector cross-fades its content on
  selection change.
- Everything above collapses to instant under `prefers-reduced-motion`.
- Durations 150 to 250ms, one shared easing. No decorative motion on the table.

### Accessibility (non-negotiable, project rule)

- Every state color measured at AA 4.5:1 against its actual background.
- 44px minimum tap targets, 16px minimum inputs.
- Color is never the only signal: the icon and the sign of the number carry the
  same meaning as the color, so the four states survive color blindness.
- Focus rings on all interactive elements; Inspector and sheets trap focus and
  restore it on close. Money figures get screen-reader labels ("Available: 80
  dollars, on track").

### Build note

This spec is not a phase, it is the surface every phase renders into. Phase A
should stand up the shell (tabs, sidebar, header, tokens, the category table, and
the four Available states) so later phases have a settled frame to build in.

**Phase gating of these screens (do not build out of order).** The Plan screen,
the Inspector, and the Add/edit transaction sheet render on today's data model.
The Spending register (Payee, Category, Memo, Outflow/Inflow, **Cleared**, running
balance), the Accounts tab, every cleared/reconciled state, and the Net Worth
report all depend on the **Phase E accounts subsystem**, which is the open "commit
or drop" decision below. They cannot exist until that fork is resolved, so treat
those screens as blocked, not ready. On today's single-pot model the "Spending"
list is just the flat transaction list this app already renders, without the
account-scoped columns.

---

## Open decisions

- Policies for `budgets`, `budget_members`, `categories` still to write.
- **Accounts subsystem (Phase E): commit or drop?** It is the fork in the road.
  Everything through Phase D treats the budget as one pot. Reconcile, net worth,
  transfers, and real credit-card handling all hang off an accounts table that
  does not exist yet. Decide before Phase C so transactions are not reshaped
  twice.
- Recurring transactions **already shipped** (v2 `recurring` table); only
  enhancements remain (Phase C). Reports are still unbuilt (Phase D).

### Known code discrepancies found in review (2026-07-16)

These are defects or overclaims in the shipped code, not roadmap items. Fix
independently of the phases.

- **Deleting a category silently shifts Ready to Assign** (RESOLVED 2026-07-16,
  ponytail). Root cause stands: `transactions.category_id ... on delete set null`
  turns the deleted category's past expenses into uncategorized spend, which
  `rollup()` subtracts from Ready to Assign, while its `assignments` cascade away.
  Fix shipped: the delete confirm now counts the category's transactions and, when
  non-zero, says the spending moves into Ready to Assign and changes past months.
  We warn, we do not block. Ceiling: the count is from history loaded up to the
  month on screen, so it under-reports when viewing an earlier month.
- **No realtime sync** (RESOLVED 2026-07-16, ponytail). app.js now refreshes on
  `visibilitychange` when the tab returns to view, so a partner's changes show up
  on refocus instead of never. Ceiling: this is not live-while-both-looking, and
  assignment writes are still last-write-wins with no merge. Add a Supabase
  Realtime channel only if simultaneous editing ever actually happens.
- **Single currency and local-time months.** app.js hardcodes CAD / `en-CA`, and
  month boundaries use local `new Date()`. Fine for two Canadians in one timezone,
  but both are undocumented assumptions, not settings. Note before assuming
  otherwise.
- **Assign input coerces junk to zero.** The category assign handler uses
  `Number(value) || 0`, so a non-numeric entry silently empties the envelope
  rather than being rejected. Violates "validate at boundaries". Validate before
  writing.
