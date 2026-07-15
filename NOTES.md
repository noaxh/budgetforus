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

- [ ] **Rotate `sb_secret_…`** — it was pasted into a chat transcript, treat as burned. Nothing uses it, so rotating breaks nothing.
- [ ] **Disable sign-ups** (Auth → Sign-ups) once both users have logged in. Until then anyone with the public key can register an account.
- [ ] Add the friend to the shared budget: Authentication → Users → copy their id →
      `insert into budget_members values ('<budget-id>', '<their-user-id>');`

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

Leave: bank sync (Plaid costs money and is most of the complexity in all three), subscription cancellation, credit score, net worth, investments, goals, reports, envelope rollover, "Ready to Assign".

All three land on a warm off-white background rather than pure white, restrained palette, one saturated accent, near-zero shadow. Converging on that is a signal, not a coincidence.

---

## v1 spec (decided 2026-07-15)

- **Model**: personal *and* shared. Monarch household style — each person has their own budget, plus one shared budget both belong to. Switcher between them.
- **Stack**: single-file HTML + JS. No build step. Supabase via CDN script tag.
- **Scope**: log/list/edit/delete transactions, categories with monthly limits, progress against limit. Auth + RLS working.

Deliberately out of v1: recurring transactions, charts/trends, settle-up/who-owes-who, bank sync.

### Simplifications vs YNAB (ponytail)

- No envelope rollover, no "Ready to Assign", no targets engine. A category has a **monthly limit**; spent = sum of that month's transactions; available = limit − spent.
- Color rule collapses YNAB's four states into something derivable from two numbers: over limit → red, ≥80% → yellow, under → green, no limit set → gray.
- No `kind` column on budgets. A personal budget is just a budget with one member; shared is one with two. Membership already encodes it — the switcher lists whatever you belong to.

### Schema

Adds to the sketch above: `categories (id, budget_id, name, monthly_limit, sort)`, and `transactions.category_id`.

---

## Open decisions

- Policies for `budgets`, `budget_members`, `categories` still to write
- Recurring transactions, reports — deferred past v1
