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

(Status columns frozen 2026-07-16. "Roadmap v2" below owns live status and
order.)

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
| Future-month budgeting (navigate ahead, assign) | PLANNED | month picker already moves; assigning in a not-yet-current month + carrying it forward is the gap. This is *assigning money you have* into a future month, NOT forecasting money you don't (that stays SKIP) |
| Budget history (scroll back through past months) | PARTIAL | past months render read-through from history; a "what changed when" view is Money Moves (below) |
| Move money between categories (Whack-a-Mole) | PARTIAL | reassign works; no dedicated "move $X from A to B" quick UI |
| Cover overspending from another category | PLANNED | one-tap on a red Available to pull the shortfall from another category or from Ready to Assign. Same quick-move UI as above |

### Auto Assign (the modes sheet)

| YNAB mode | Status | Note |
|---|---|---|
| Assigned Last Month | HAVE | 2026-07-16 |
| Spent Last Month | HAVE | 2026-07-16 |
| Reset Assigned (clear to zero) | HAVE | 2026-07-16 |
| Fill to target ("Underfunded") | PLANNED | needs Phase B targets; deferred with them |
| Average Assigned | PLANNED | mean of prior N months assigned |
| Average Spent | PLANNED | mean of prior N months activity |
| Reduce Overfunding | PLANNED | pull back anything assigned past its target |
| Reset Available | PLANNED | set Available back to Assigned (drop rollover) |
| Bulk Auto Assign (run a mode across all / a group) | PLANNED | one action over every category or a selected group |

### Category management

| YNAB feature | Status | Note |
|---|---|---|
| Category groups | HAVE | label-based, schema-v4 |
| Custom categories | HAVE | |
| Reorder / drag-and-drop ordering | PLANNED | `categories.sort_order`; drag on desktop, up/down on mobile |
| Collapse / expand groups | PLANNED (light) | per-group open state in localStorage |
| Category notes | PLANNED (light) | `categories.note` text |
| Category emojis / icons | PLANNED (light) | `categories.icon`; emoji is free, no icon set to ship |
| Category colors | PLANNED (light) | `categories.color`, same 6-swatch palette as flags |
| Hide category | PLANNED | `categories.hidden`; drops from the plan, keeps history |
| Archive category | PLANNED | soft state distinct from delete; keeps history, no rollover |
| Delete category | HAVE | with the RTA-shift warning (see discrepancies) |
| Category progress indicator | PLANNED | the target progress bar; falls out of Phase B |
| Pin favourite categories | SKIP | mobile nicety |

### Targets / goals (the keystone gap)

| YNAB feature | Status | Note |
|---|---|---|
| Targets (spend / save / set-aside per category) | PLANNED | `monthly_limit` is a one-type proto-target today |
| Goal types: monthly, weekly, by-date, "have a balance of", "set aside another" | PLANNED | by-date needs remaining / months-left math |
| Yearly / annual target | PLANNED | a by-date target one year out, or an annual cadence; fold into the kind list |
| Refill Up To / Set Aside Another / Pay Specific Amount / Pay Off By Date | PLANNED | YNAB's exact wording for the kinds above; same math |
| Progress bars | PLANNED | per-category fill vs needed; the category progress indicator |
| Underfunded (yellow) state | PLANNED | falls out of targets; this is what brings back YNAB's yellow |
| Underfunded calculation + auto-funding suggestion | PLANNED | "$X to fund" per category and the fill-to-target Auto Assign mode |
| Snooze target (skip a month) | PLANNED (light) | a per-category per-month "skip" flag so a snoozed target does not count as underfunded |
| Edit / delete target | PLANNED | part of the target editor |
| Copy target to another category | PLANNED (light) | duplicate a target definition; cheap once the editor exists |
| Cost to Be Me | PLANNED | sum of month's targets vs entered expected income; one header stat once targets exist |
| Category / plan templates | SKIP | targets across all categories already are the template; import/export is low value for two people |

### Budget / focused views

| YNAB feature | Status | Note |
|---|---|---|
| Default budget view | HAVE | the plan screen |
| Underfunded / Overfunded / Assigned / Available views | PLANNED (light) | client-side filters over the already-loaded categories; no schema |
| Snoozed view | PLANNED (light) | needs the snooze flag above |
| Custom Focused Views (save a filter set) | PLANNED | `views` in localStorage first, a table only if it must sync; up-to-12 cap is arbitrary, no hard limit |
| Persistent / saved views | PLANNED | remember the last active view |
| Auto Assign within a view | PLANNED | run a mode over only the view's categories; depends on Bulk Auto Assign + views |

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
| Split transactions | PLANNED | one transaction across categories; `parent_id` self-ref, parent nets to split total, children carry categories. Changes `rollup()` |
| Auto-distribute split amounts | PLANNED (light) | ships with splits; even-split the remainder across the child rows |
| Split templates | SKIP | reuse a saved split; low value for two people until splits themselves prove used |
| Transaction memo / notes | PLANNED (light) | a free-text `memo` on the row, shown in the register and edit sheet |
| Transaction calculator (math in the amount field) | PLANNED (light) | evaluate `5+3.50` in the money input; client only, no schema |
| Duplicate transaction | PLANNED (light) | copy a row into a new draft |
| Convert to recurring | PLANNED (light) | seed a `recurring` rule from an existing transaction |
| Enter scheduled transaction immediately | PLANNED (light) | "add now" on a recurring rule instead of waiting for month open |
| Payees | HAVE (light) | `description` autocompletes from distinct past descriptions via a datalist, no payees table (ponytail, 2026-07-16) |
| Flags / color tags | HAVE (light) | `transactions.flag` (schema-v4, 6-colour check), flag picker in the txn sheet, coloured dot on the row. Filter-by-flag still to add (2026-07-16) |
| Bulk action bar (multi-select) | PLANNED (light) | select rows, categorize / flag / delete together |
| Bulk memo / payee / flag edit | PLANNED (light) | extra actions on the same bulk bar |
| Selected-transaction running total | PLANNED (light) | sum of the multi-selected rows, shown in the bulk bar |
| Export transactions to CSV | HAVE (light) | Export button dumps the month on screen (`state.txns`) to CSV (2026-07-16) |
| Receipt / photo attachments | SKIP (later) | needs Supabase Storage + a bucket; real lift, revisit only if wanted |
| Transfers between accounts | OPTIONAL | needs accounts |
| Approve / reject / match imported | SKIP | only meaningful with bank import |
| Pin frequent categories | SKIP | nicety |

### Payees (if the light datalist is outgrown)

| YNAB feature | Status | Note |
|---|---|---|
| Payee autocomplete | HAVE (light) | datalist over distinct past descriptions, no table |
| Real payee records (rename / merge / hide) | PLANNED (optional) | a `payees` table only if the datalist proves too loose; medium lift |
| Auto-categorize by payee | PLANNED (light) | remember the last category used for a payee and pre-fill it; the highest-value payee feature, doable without a full table |
| Automatic merchant renaming / cleanup | SKIP | needs a rename map; low value at two-person scale |
| Transfer payees | OPTIONAL | needs accounts |

### Search & filtering

| YNAB feature | Status | Note |
|---|---|---|
| Search by payee / category / memo / amount / date / flag | PLANNED | one search box + filter chips over the loaded transactions; client-side, no schema |
| Exact / phrase match | PLANNED (light) | quoted-substring match in the same box |
| Filter transactions (by the above) | PLANNED | the chip row |
| Saved filters | PLANNED (light) | same store as Focused Views |
| Search by cleared status | OPTIONAL | needs the accounts / cleared subsystem |

### Reflect / reports

| YNAB feature | Status | Note |
|---|---|---|
| Spending breakdown (by category) | PLANNED | charts were deprioritized, but this one changes decisions |
| Spending trends / historical | PLANNED (light) | the breakdown over a multi-month range instead of one month |
| Average spending | PLANNED (light) | mean per-category over the range; a column on the breakdown |
| Income vs Expense (cash flow) | PLANNED (light) | one table per month range |
| Age of Money | PLANNED (light) | derivable from transaction history; niche |
| Drill into a report category | PLANNED (light) | click a slice/bar to the filtered transaction list (reuses Search) |
| Export report data (CSV) | PLANNED (light) | same CSV path as the transaction export |
| Share report image / hide balances while sharing | PARTIAL | hide-amounts already blurs; a dedicated share-image is SKIP (native share, low value) |
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
| Multiple / unlimited plans / budget switcher | HAVE | v3; no cap |
| Delete a budget / plan | HAVE | type-the-name confirm, cascades to every category, transaction, assignment and rule; `members delete budget` policy (schema-v3), handler + danger-zone button shipped. See "Deleting budgets" section |
| Rename a budget / plan | HAVE | pencil button beside the switcher, native prompt, `members rename budget` policy; also the fix for two budgets sharing a name |
| Copy a budget / plan | PLANNED (light) | clone categories + targets into a new empty plan (no transactions); cheap |
| Archive a budget / plan | PLANNED (light) | a `budgets.archived` flag hides it from the switcher without deleting |
| YNAB Together (share one sub, up to 6) | PARTIAL | `budget_members` already supports N members; sharing model differs but the capability is there |
| Permission management (member roles) | PLANNED (optional) | a role column on `budget_members`; low value while it is two trusted people, so optional |
| Educational onboarding / first-run tour | PLANNED (light) | a dismissable first-run explainer for the envelope model; the model is where people bounce off |
| Hide amounts toggle | HAVE | header eye toggle blurs every `.num`/`.pill`, remembered in localStorage (2026-07-16) |
| Focused / customizable views | PLANNED (light) | see the Budget / focused views table above |
| Fresh Start / Plan Reset | PLANNED | archive current plan, keep categories / targets / scheduled / payees |
| Offline access | SKIP (later) | service-worker PWA is a real lift; revisit after the above |
| Mobile widgets / native app features | SKIP | Face/Touch ID, Siri, Spotlight, push, widgets all need a native app; this is a web PWA |
| Forecasting (assign future money you don't have) | SKIP | distinct from future-month budgeting (PLANNED); against the "money you already have" ethos |
| Public API / OAuth endpoints / webhooks | SKIP | it is our own app |

### Productivity

| YNAB feature | Status | Note |
|---|---|---|
| Carry balances between months | HAVE | v3 rollover |
| Move money between categories | PARTIAL | see Core; quick-move UI is PLANNED |
| Cover overspending from another category | PLANNED | see Core |
| Bulk operations (multi-select) | PLANNED (light) | the bulk action bar |
| Multi-select categories | PLANNED (light) | select categories for a bulk Auto Assign / target action |
| Calculator in money fields | PLANNED (light) | the transaction calculator, applied to every amount input |
| Drag & drop ordering | PLANNED | category reorder |
| Undo / redo | PLANNED | undo the last assignment / edit; real value, medium lift (an action stack) |
| Keyboard shortcuts / keyboard-only flow | PLANNED (light) | desktop only; assign, next category, add transaction |
| Sticky sidebar / inspector, per-device layout | PARTIAL | desktop sidebar + inspector and the mobile 5-tab shell are in the visual spec; build with the shell |
| Persistent settings | HAVE (light) | hide-amounts, active month, and view state live in localStorage |

### Quality of life

| YNAB feature | Status | Note |
|---|---|---|
| Desktop app mode (browser install / PWA) | PLANNED (light) | a `manifest.json` + icons; makes Add-to-Home / install work. No service worker yet (that's offline, SKIP later) |
| Privacy-first, no advertising | HAVE | by nature |
| Free trial / billing | SKIP | free two-person app |
| Receipt storage / transaction photos | SKIP (later) | same as attachments above; needs Storage |
| Auto payee cleanup / merchant renaming | SKIP | see Payees |

### Excluded on purpose (bank + platform technicalities)

Per the 2026-07-16 decision, every YNAB feature is in this plan **except** the two
groups below. These are not "not yet" — they are out of scope by design.

- **Bank connectivity.** Direct / automatic import, linked institutions, connector
  switching, reset bank connection, pending-transaction matching, Apple Card /
  Cash / Savings import. Plaid costs money and is most of the complexity in every
  competitor. *File-based import (CSV / OFX / QFX / QIF) is the sanctioned
  substitute and IS planned (Phase F).*
- **Platform / infrastructure technicalities.** Native iOS/Android apps, tablet
  apps, offline editing, widgets, Face ID / Touch ID, Siri Shortcuts, Spotlight,
  push notifications; two-factor auth and encryption (Google OAuth + HTTPS +
  RLS + Postgres backups already cover the real threat model, and column
  encryption is a locked no); the public REST API, OAuth endpoints, and webhooks.

---

## Roadmap v2: YNAB core, Monarch surfaces (2026-07-17)

Replaces the lettered build plan (Phases A to J, 2026-07-16), which had become a
YNAB gap list ordered by effort, with statuses drifting behind the code. This
version is organized by pillar, folds in Monarch Money (full feature inventory
in `monarch feature list.txt`), and starts from what actually shipped. The YNAB
parity audit above stays as the reference inventory; this section owns status
and order.

### Decisions locked 2026-07-17 (Noah's calls)

1. **Envelope core stays.** The v3 zero-based engine plus the Phase B targets
   engine is the only budget model. Monarch contributes surfaces on top of it,
   never a second budgeting mode.
2. **Monarch pillars in: Home dashboard, rules + recurring calendar.** Not
   chosen: a separate goals engine (targets already carry that weight) and the
   reports extras (sankey, merchant reports, monthly review recap). The shipped
   Reflect reports stand.
3. **Net worth via balance snapshots.** Manual accounts, balances typed in
   monthly. Transactions stay one pot.
4. **Cuts and keeps at discretion:** the full accounts subsystem and the
   credit-card subsystem are cut; CSV/OFX file import and undo/redo stay; the
   loan calculator is parked.

Unchanged and non-negotiable: no bank connections of any kind. From Monarch's
list that also excludes receipts/OCR, all AI features, investments, credit
score, bill split, forecasting, push notifications, and native apps.

### Shipped ledger

Where the old plan actually got to, compressed. Git log is the receipt.

- **v1 to v3 core:** auth, RLS, transactions, envelope model, Ready to Assign,
  budget switcher, delete/rename budget.
- **Phase A:** category groups (with collapse), flags, hide-amounts, payee
  autocomplete datalist, CSV export, the auto-assign modes sheet.
- **Phase B:** targets engine (monthly refill and by-date kinds as columns on
  `categories`, schema-v5), per-category needed math, the underfunded yellow
  (`envStatus` returns `under`; the pre-targets `close` state is gone),
  fill-empty and fund-to-target auto-assign, Cost to Be Me.
- **Phase C, part:** recurring cadences + auto-apply (schema-v6), Money Moves
  log, bulk action bar. Splits and the transaction micro-features did not ship.
- **Spruce & Bone:** the design-system redesign; current visual truth
  (`styles.css` §1 tokens supersede the YNAB tokens in the visual spec below).
- **Phase D:** spending breakdown, income vs expense, drill-through to the
  register, report CSV export. Age of Money remains.
- **Phase H, part:** the register search bar.

### Phase 1: envelope finishers — SHIPPED 2026-07-20 (`schema-v7.sql`)

Closed the daily-use gaps in the YNAB core. Migration `schema-v7.sql` (parent_id,
memo, target_snoozes) must run before the client deploys. Verified via `?selftest`
(new `core.js` assertions) and `?preview`.

- Quick-move + cover overspending (M). DONE. Tapping a category's Available pill
  opens the move sheet; an overspent one prefills covering the shortfall from
  Ready to Assign. A move is two assignment writes (minus source, plus dest); an
  RTA endpoint writes nothing (it's derived). Reuses `assign()`, so each move
  still lands in Money Moves.
- Focused views (M). DONE. Filter chips over the plan — All / Underfunded /
  Overspent / Has money / Overfunded / Snoozed, each with a live count — filtering
  which categories render without touching the money. Active view is remembered in
  localStorage (`budget.view`). ponytail: preset filters, not an arbitrary
  saved-view builder; "remember the last one" is the persistence.
- Auto-assign completion (S). DONE. Added 3-month average assigned, 3-month
  average spent, reduce overfunding to target, reset available to assigned; every
  mode (old and new) is now group-scopable via an "Apply to" picker in the sheet.
- Snooze a target (S). DONE. Per-category per-month row in `target_snoozes`;
  `envStatus` takes a `snoozed` flag that suppresses the amber, and the pill shows
  a Zz + "Snoozed". Toggled from the move sheet; excluded from Cost to Be Me and
  the fund-to-target auto-assign. There's a Snoozed focused view rather than a
  separate screen.
- Split transactions (M). DONE. `transactions.parent_id`: the parent is a
  container (total, no category), children carry the categories and shares.
  `splitParentIds` + a skip in `rollup`/`cashFlow`/`spendingBreakdown`/`ageOfMoney`
  stop the parent double-counting; `distributeSplit` spreads the remainder over
  blank rows. The register folds children into one parent line ("Split · N
  categories"). `?selftest` covers all of it.
- Transaction micro-features (S each). DONE. `memo` column (shown in the register
  meta + CSV), `evalAmount` calculator in every money field (assign, move, txn
  amount, split rows), duplicate a row, convert a row to a monthly recurring rule,
  and add-now on a due rule.
- Age of Money (S). DONE. `ageOfMoney` in `core.js` — FIFO income→expense, mean of
  the last 10 expenses, null until there's banked income. Renders as a Reflect
  card (days, not money, so it never blurs under hide-amounts).

### Phase 2: Home dashboard (Monarch)

Monarch's landing screen, adapted. This is visual-spec Screen 6 finally built,
and the Home tab stub in the Spruce & Bone shell finally filled.

- Home tab as first screen (M). Phone-first card stack: plan state (Ready to
  Assign plus overspent-category count, tap through to the plan), spending
  summary (this month vs last), upcoming recurring (next 7 days), recent
  transactions.
- Alerts row (S). "Money to assign", "overspending to cover", each a tappable
  card in its state color.
- Widget controls (S). Hide and reorder cards, stored per device in
  localStorage. ponytail: a settings list, not a drag-and-drop grid builder.
- The net worth card slots in when Phase 4 ships.

### Phase 3: rules + recurring calendar (Monarch)

Kills most manual categorization, which is the main daily friction left.

- Rules engine (M). A `rules` table: description substring match sets category
  and optionally a flag. Priority is list order, first match wins. Applied as
  pre-fill on manual entry.
- Retro-apply with preview (S). Run the rules over existing uncategorized rows,
  show the would-be changes, commit on confirm.
- Payee-memory fallback (S). No matching rule: pre-fill the last category used
  for that description. The old Phase J idea, folded in here.
- Recurring calendar (M). Month view of recurring rules with paid/pending state
  (paid = the rule's transaction exists this month), tap to add-now. Feeds the
  dashboard's upcoming card.
- When Phase 5 lands, imported rows run through the same rules.

### Phase 4: net worth lite (Monarch, snapshots only)

- Schema (M). `accounts (id, budget_id, name, kind asset|liability, sort,
  archived)` and `balance_snapshots (account_id, month, balance_cents)`. Same
  member-RLS pattern as every other table.
- Balances screen (S). Type in current balances; a staleness chip when the
  month has no entry yet.
- Net worth view (M). Assets minus liabilities over time, per-account
  breakdown, range picker, plus the dashboard card.
- Hard boundary, restating the decision: transactions never reference accounts.
  No cleared state, no reconcile, no transfers, no credit-card handling.
  Reopening that is a new decision, not a phase.

### Phase 5: file import

- CSV/OFX import (M). Drag-drop a bank export, map columns, dedupe against
  existing rows on date + amount + description, preview before commit. Phase 3
  rules categorize incoming rows. The sanctioned substitute for bank sync.

### Phase 6: category + plan management — BUILT 2026-07-21 (`schema-v10.sql`)

Old Phase G plus the lifecycle bits of F. Taken out of order (Phase 5 is gated
on a real bank export existing). Migration `schema-v10.sql` (`archived`, `notes`)
must run before the client deploys. Verified via `?selftest` and `?preview`.

Two thirds of the listed scope did not survive the ladder, which is the useful
record here:

- Reorder categories (M). DONE, and it needed no migration. `categories.sort`
  has existed since `schema.sql` (`int not null default 0`) and the load has
  always ordered by it — but nothing ever *wrote* it, so every row sat at 0 and
  the tiebreak on name did the real ordering. Up/down arrows in the manage
  dialog, reusing the `.rule-move` idiom from Phase 3; the first press re-packs
  the whole live list to its array index, healing the all-zeros legacy state.
  ponytail: no drag-and-drop — HTML5 DnD needs a library to work on touch, and
  arrows work identically on both.
- Hide + archive a category (S). DONE, as **one** `archived` flag. Hide and
  archive were the same act at this scale, so they are one thing. This is also
  the correct way to retire a category: deleting one sets `category_id` to null
  on its past transactions, dropping that spending into Ready to Assign and
  rewriting closed months (the defect recorded below). Archiving touches no
  transaction. The delete confirm now points at it.

  **The invariant this rests on:** `rollup` only knows the categories it is
  handed, and `core.js` silently *drops* a transaction pointing at one that is
  missing (`if (!e) continue` — it does not fall through into uncategorized). So
  `state.cats` stays the complete list and only the display sites filter, via
  `liveCats()`. Hand `rollup` the filtered list instead and an archived
  envelope's past spending vanishes, inflating Ready to Assign by exactly that
  amount — measured at $45 on the preview fixture. Two `?selftest` assertions
  now pin this. Name lookups deliberately read the full list, so an old
  transaction still shows its category name, and the transaction editor keeps an
  archived category selectable on the row already in it (labelled "(archived)")
  so saving can't quietly re-point it at Uncategorized.

  Guard: archiving a category that still holds money is refused, since an
  archived envelope with a balance is money you can no longer see. Move it out
  first — the move sheet already does that in two taps.
- Category notes (S). DONE. One `notes` column, rendered in the move sheet,
  which is where you're deciding about the envelope, rather than on the plan row
  where it would just add density.
- Category emoji, colour (S each). CUT. An emoji typed into the name field is
  the same feature for zero code, and `group_name` already does the organizing
  that colour would duplicate.
- Merge a category (S). CUT. The bulk action bar (Phase C) recategorizes the
  source's transactions, and deleting the now-empty category is then harmless —
  two steps, no new code. Revisit if that proves annoying in real use.
- Future-month assigning (M). ALREADY WORKED. `goMonth` never clamped forward
  and `assign` has no month guard; the only future-month guard in the codebase
  is `maybeAutoApply`, which deliberately refuses to auto-add recurring
  transactions into a month you are merely browsing. Nothing to build.
- Copy budget (S), archive budget (S), Fresh Start (M). CUT. Two people, one
  budget; delete-budget already exists. Speculative until someone wants a second
  budget for real.

### Phase 7: productivity + QoL — BUILT 2026-07-21 (no migration)

Old Phase I. Entirely client-side, no schema change. Verified via `?selftest`
(five new `undoStomped` assertions) and `?preview` at 375px.

- Undo/redo (M). **Built narrow, and the narrowing is the decision.** Not an
  action stack: one level, this session only, assignments only. The inverse of
  the last `assign()` batch is kept in `state.undo` (sourced from the Money Moves
  rows that call already computes, so there is no new table and no extra fetch),
  offered as a banner above the plan, and dropped on a month or budget change.
  One Undo covers a whole batch, so an auto-assign run reverses in one press.

  **Redo: cut.** Undoing an assignment leaves the figure on screen and typing it
  again is the redo. A redo stack would be state to maintain for no new capability.

  **Undo of transaction edits and deletes: cut.** That needs soft-delete, which
  means a schema change plus a deleted-row filter on every read and every report,
  for an action that already carries a counted confirm. Revisit if a real
  mis-delete ever costs something.

  **The two-editor hazard, and the guard.** Undo puts *old* figures back, so if
  the other person has touched the same envelope since, a naive undo silently
  stomps them. `core.js undoStomped(expect, assigns)` compares what we wrote
  against what is there now and returns the rows that moved; a non-empty result
  refuses the undo and says so, touching nothing. It compares in **cents**, not
  raw values, because PostgREST returns numerics as strings (`"40.00"`) and a
  plain `!==` would declare every row stomped and make undo permanently useless.
  That string/number case is one of the selftests.
- Keyboard shortcuts (S). DONE. `n` new transaction, `/` search, `[` / `]` month,
  `a` auto-assign, `u` undo, `?` the list. Single letters with no modifiers, which
  is only safe because the handler bails on a focused field, an open dialog, or
  any modifier combination — so browser and OS shortcuts are never shadowed. `[`
  and `]` step months rather than the arrow keys, which belong to scrolling. The
  sheet is built from the same `SHORTCUTS` array the handler reads, so the keys
  and their documentation cannot drift apart.
- PWA manifest + icons (S). DONE. `manifest.json` + 192/512/maskable PNGs and an
  apple-touch-icon, generated from one SVG source (petrol tile, cream allocation
  bars echoing the spending breakdown). **Deliberately still no service worker** —
  every figure here is money, and a stale cached balance is worse than a spinner.
  The `apple-mobile-web-app-*` metas were already in place from the redesign, so
  this was the missing half of an iPhone install. First icon drawn was an
  envelope, matching the model's name; it read as Mail on a home screen and was
  replaced.
- First-run envelope explainer (S). DONE. Three numbered steps (money arrives →
  you assign it → you spend from a category), shown once on a budget that has no
  categories yet, dismissal remembered per device in `budget.seen-intro`, and
  re-openable from the overflow menu as "How this works". An existing budget never
  sees it. This is the surface that matters for onboarding the second person.

### Parked (unscheduled, revisit on real demand)

- Loan/debt calculator. Self-contained client math; build it the day a real
  loan needs planning.
- Real payees table (rename / merge / hide), only if datalist + rules prove
  too loose.
- Richer target kinds (weekly, set-aside-another, have-a-balance-of,
  pay-specific-amount). Monthly refill + by-date cover real use so far.
- Realtime sync channel, only if simultaneous editing actually happens.
- Offline / service worker.

### Cut (2026-07-17, do not resurrect casually)

- Full accounts subsystem: per-transaction accounts, cleared/uncleared,
  reconcile, transfers. Balance snapshots cover the need at this scale.
- Credit-card subsystem: payment category, float, credit overspend. It rode
  entirely on full accounts.
- Goals engine and the reports extras (sankey, merchant reports, monthly
  review recap): offered 2026-07-17, not chosen.
- Monarch's bank-adjacent and platform features: sync/aggregators, receipts
  and OCR, AI everything, investments, credit score, bill split, forecasting,
  notifications, native apps.

### Order

Phase 1, then 2, then 3, then 4: finish the core, then the visible Monarch
win, then automation, then net worth. **All four shipped and deployed by
2026-07-21**, migrations v7/v8/v9 confirmed run by REST probe. Phase 6 was then
pulled forward and built, because Phase 5 stays gated on the first real bank
export showing up. **Phase 7 followed on 2026-07-21, so Phase 5 is now the only
roadmap item left** — and it stays gated until a real bank export exists. The
honest next move is not another phase: it is using this with real money for a
few weeks and letting that decide what gets built. Everything honors the locked decisions: static files, no build step,
`kind` column never signed amounts, integer cents, RLS as the only gate, no
Plaid.

---

## Visual and layout spec — YNAB parity (2026-07-16)

(The exact tokens below are superseded by the Spruce & Bone redesign;
`styles.css` §1 is the live token source. The layouts, screens, and the four
Available-state semantics still govern.)

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

**Superseded 2026-07-16: Phase B shipped.** Yellow now carries the YNAB meaning
(underfunded); `envStatus` returns `under` and the pre-targets `close` state is
gone. Historical paragraph kept for context:

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

**Phase gating of these screens (resolved 2026-07-17).** The Plan screen, the
Inspector, and the Add/edit transaction sheet render on today's data model. The
account-scoped parts (per-account registers, the Cleared/Reconciled states and
chips, running balances, transfers, the tracking-accounts Net Worth report)
depended on the full accounts subsystem, which Roadmap v2 cut. They are out for
good, not blocked. The "Spending" list stays the flat transaction list this app
already renders, and net worth arrives instead as the snapshot chart (Roadmap
v2, Phase 4).

---

## Open decisions

- Policies for `budgets`, `budget_members`, `categories` still to write.
- ~~Accounts subsystem (Phase E): commit or drop?~~ **Resolved 2026-07-17:**
  balance snapshots only (Roadmap v2, Phase 4). The full subsystem, and the
  credit-card handling that rode on it, are cut.
- Recurring shipped in v2; its enhancements (cadences, auto-apply) shipped with
  Phase C. Reports shipped in Phase D except Age of Money (Roadmap v2, Phase 1).

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
  **Superseded 2026-07-21 (Phase 6):** archiving is now the intended way to retire
  a category and has none of this behaviour, because it touches no transaction.
  The warning stays and now names archive as the alternative.
- **No realtime sync** (RESOLVED 2026-07-16, ponytail). app.js now refreshes on
  `visibilitychange` when the tab returns to view, so a partner's changes show up
  on refocus instead of never. Ceiling: this is not live-while-both-looking, and
  assignment writes are still last-write-wins with no merge. Add a Supabase
  Realtime channel only if simultaneous editing ever actually happens.
- **Single currency and local-time months.** app.js hardcodes CAD / `en-CA`, and
  month boundaries use local `new Date()`. Fine for two Canadians in one timezone,
  but both are undocumented assumptions, not settings. Note before assuming
  otherwise.
- **Assign input coerces junk to zero** (RESOLVED 2026-07-20, Phase 1). The assign
  handler now runs the value through `evalAmount` (the calculator): a non-numeric
  entry is rejected and the field is put back to the current assigned amount rather
  than silently emptying the envelope. A bare number or a little sum ("40+5") both
  work. Same validation guards the move sheet and the transaction amount field.
