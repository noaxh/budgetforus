import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import {
  cents, formatMoney, convertC, monthKey, monthStart, monthEnd, monthLabel, today,
  prevMonthStart, sumSpentInRange, spendingBreakdown, cashFlow, txnMatches, rollup, recurringOccurrences,
  splitParentIds, distributeSplit, evalAmount, ageOfMoney,
  matchRule, lastCategoryFor, retroApply,
  netWorthAt, netWorthSeries, undoStomped
} from './core.js'

// Safe to commit and ship to the browser: the publishable key is public by
// design and RLS is what protects the data. The sb_secret_ key never goes here.
const SUPABASE_URL = 'https://aeqydektxshybtyjkekp.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable__AX_N4UOwp4mBBXIe_ynRQ_D616UKp6'

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ---------------------------------------------------------------- state

// txns is the month on screen (the list). history is everything up to the end of
// it (the rollup) -- two views of one fetch, because Available rolls forward.
const state = { budgets: [], budgetId: null, month: new Date(), cats: [], txns: [], history: [], assigns: [], recurring: [], rules: [], accounts: [], snapshots: [], snoozed: new Set(), editing: null, splitRows: null, selMode: false, sel: new Set(), tab: 'budget', closedGroups: new Set(), txnFilter: null, txnSearch: '', view: localStorage.getItem('budget.view') || 'all', moveCat: null, undo: null,
  // base = what the budget's amounts ARE; display = what this device reads them in;
  // rate 1 means no conversion (same currency, or no rate available).
  fx: { base: 'CAD', display: 'CAD', rate: 1, at: null, stale: false, failed: false } }
const $ = id => document.getElementById(id)

// ---- currency (2026-07-21). The budget stores one currency; each *device* picks
// what to read amounts in. Noah banks in CAD and his friend may read in USD, so
// this is a per-viewer preference, not budget data — it lives in localStorage and
// is never written back, which also means one person switching can't move the
// other person's numbers.
//
// `money()` shadows core's export deliberately: it is the single place a figure
// becomes a string, so wrapping it converts all 40-odd call sites at once without
// touching one of them. Everything upstream stays integer cents in the base
// currency.
const FX_KEY = 'budget.display-currency'
const FX_CACHE = 'budget.fx-rate'
const CURRENCIES = ['CAD', 'USD']

const money = c =>
  state.fx.rate === 1
    ? formatMoney(c, state.fx.base)
    : formatMoney(convertC(c, state.fx.rate), state.fx.display)

// A converted figure is an estimate at today's rate, so it is marked. Callers that
// show a headline number use this to append "≈" rather than implying precision the
// rate can't support.
const isConverted = () => state.fx.rate !== 1

// One rollup for the whole app, snooze-aware. Every screen and action reads the
// same numbers, so the four states and Ready to Assign never disagree between
// the banner, the table, and an auto-assign preview.
const rollNow = () => rollup(state.cats, state.assigns, state.history, monthStart(state.month), state.snoozed)

// Archived categories (Phase 6) are retired, not deleted: every transaction still
// points at them, so rollup and the reports must keep seeing them or their past
// spending would vanish and inflate Ready to Assign. state.cats therefore stays
// the complete list and only the *display* sites filter — the plan, the pickers,
// the counts, auto-assign. Name lookups deliberately read state.cats, so an old
// transaction in an archived category still shows its category name.
const liveCats = () => state.cats.filter(c => !c.archived)
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))

// ---------------------------------------------------------------- data

async function loadBudgets() {
  // select('*'), not an explicit column list: naming `currency` here would make the
  // client hard-fail with a 400 on every load until schema-v11 runs, which is the
  // migration-ordering foot-gun this project keeps stepping on. With `*` the column
  // is simply absent until the migration lands and `currency` falls back to CAD, so
  // the client and the migration can ship in either order.
  const { data, error } = await sb.from('budgets').select('*').order('name')
  if (error) return fail(error)
  state.budgets = data ?? []
  if (!state.budgets.some(b => b.id === state.budgetId)) state.budgetId = state.budgets[0]?.id ?? null
  await refreshFx()
}

// Resolve the pair (what this budget stores, what this device wants to read) into
// a rate. Same currency is the common case and costs nothing.
//
// Rates come from frankfurter.app: ECB reference data, no key, CORS-enabled, and
// cached for the day — a budget is not a trading desk, and a rate that moves while
// you read the screen would be worse than one that's a few hours old. Every failure
// path degrades to showing the real stored currency rather than a guessed number,
// because a wrong figure is worse than an unconverted one in an app about money.
async function refreshFx() {
  const base = state.budgets.find(b => b.id === state.budgetId)?.currency || 'CAD'
  const display = localStorage.getItem(FX_KEY) || base
  const fx = { base, display, rate: 1, at: null, stale: false, failed: false }
  if (display === base || !CURRENCIES.includes(display)) { state.fx = fx; return }

  const pair = `${base}-${display}`
  const day = today()
  let cached = null
  try { cached = JSON.parse(localStorage.getItem(FX_CACHE) || 'null') } catch { cached = null }
  if (cached?.pair === pair && cached.day === day) {
    state.fx = { ...fx, rate: cached.rate, at: cached.at || cached.day }
    return
  }
  try {
    // frankfurter.dev, not the older frankfurter.app — that domain no longer
    // resolves. `date` is the rate's own publication date (ECB publishes on
    // weekdays), which is what we show; it is not always today.
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${display}`)
    const json = await res.json()
    const rate = json?.rates?.[display]
    if (!(rate > 0)) throw new Error('no rate for ' + pair)
    const at = json.date || day
    localStorage.setItem(FX_CACHE, JSON.stringify({ pair, day, rate, at }))
    state.fx = { ...fx, rate, at }
  } catch (e) {
    console.warn('fx lookup failed', e)
    // Yesterday's rate is fine and is labelled as such; no rate at all means we
    // show the stored currency untouched rather than invent one.
    state.fx = cached?.pair === pair
      ? { ...fx, rate: cached.rate, at: cached.at || cached.day, stale: true }
      : { ...fx, display: base, rate: 1, failed: true }
  }
}

async function loadMonth() {
  if (!state.budgetId) { state.cats = []; state.txns = []; state.history = []; state.assigns = []; state.recurring = []; state.rules = []; state.accounts = []; state.snapshots = []; state.snoozed = new Set(); return }
  const ms = monthStart(state.month)
  const [c, t, r, a, sn, ru, ac, bs] = await Promise.all([
    sb.from('categories').select('*').eq('budget_id', state.budgetId).order('sort').order('name'),
    // Everything up to the end of this month, not just this month: last year's
    // leftovers are part of this month's Available.
    //
    // ponytail: the entire history, summed in the browser. Ceiling is PostgREST's
    // row cap -- at two people and a few hundred transactions a year that is
    // thousands of rows away. It matters because a truncated fetch wouldn't
    // error, it would just sum fewer rows and quietly under-report. Move the
    // rollup into a SQL view before it gets near that.
    sb.from('transactions').select('*').eq('budget_id', state.budgetId)
      .lte('occurred_on', monthEnd(state.month))
      .order('occurred_on', { ascending: false }),
    sb.from('recurring').select('*').eq('budget_id', state.budgetId)
      .eq('active', true).order('day_of_month'),
    sb.from('assignments').select('category_id,month,amount').eq('budget_id', state.budgetId)
      .lte('month', ms),
    // Only this month's snoozes matter — a snooze is per category per month.
    sb.from('target_snoozes').select('category_id').eq('budget_id', state.budgetId).eq('month', ms),
    // Categorization rules, in priority order (first match wins in matchRule).
    sb.from('rules').select('*').eq('budget_id', state.budgetId).order('sort').order('created_at'),
    // Net-worth accounts + every balance snapshot up to this month (carry-forward
    // + the trend both read the whole history; it's one small row per account/month).
    sb.from('accounts').select('*').eq('budget_id', state.budgetId).order('sort').order('created_at'),
    sb.from('balance_snapshots').select('account_id,month,balance_cents').eq('budget_id', state.budgetId).lte('month', ms)
  ])
  if (c.error) return fail(c.error)
  if (t.error) return fail(t.error)
  if (r.error) return fail(r.error)
  if (a.error) return fail(a.error)
  if (sn.error) return fail(sn.error)
  if (ru.error) return fail(ru.error)
  if (ac.error) return fail(ac.error)
  if (bs.error) return fail(bs.error)
  state.cats = c.data ?? []
  state.history = t.data ?? []
  state.txns = state.history.filter(x => x.occurred_on >= ms)
  state.recurring = r.data ?? []
  state.assigns = a.data ?? []
  state.snoozed = new Set((sn.data ?? []).map(s => s.category_id))
  state.rules = ru.data ?? []
  state.accounts = ac.data ?? []
  state.snapshots = bs.data ?? []
}

// Rule occurrences due in the month on screen that have no transaction yet, as
// {rule, date} pairs. Occurrence-level, not rule-level: a weekly rule is due
// several times a month, so "applied" has to match on the exact date, not just
// the rule id. An inactive rule is due for nothing.
const pendingRecurring = () => {
  const ms = monthStart(state.month)
  const have = new Set(state.txns.filter(t => t.recurring_id).map(t => `${t.recurring_id}|${t.occurred_on}`))
  const out = []
  for (const r of state.recurring) {
    if (r.active === false) continue
    for (const date of recurringOccurrences(r, ms))
      if (!have.has(`${r.id}|${date}`)) out.push({ rule: r, date })
  }
  return out
}

// Build the transaction rows for a set of {rule, date} pending occurrences.
const recurringRows = pend => pend.map(({ rule: r, date }) => ({
  budget_id: state.budgetId, kind: r.kind, amount: r.amount,
  description: r.description, category_id: r.category_id, occurred_on: date, recurring_id: r.id
}))

// Auto-apply: opt-in rules add themselves the first time a month (current or
// past, never a future month you're only browsing) is opened. Idempotent via the
// same unique index "Add them" leans on, so re-running on every refresh is safe
// and cheap -- it only writes when something is genuinely still due.
async function maybeAutoApply() {
  if (monthStart(state.month) > monthStart(new Date())) return false
  const rows = recurringRows(pendingRecurring().filter(p => p.rule.auto_apply))
  if (!rows.length) return false
  const { error } = await sb.from('transactions')
    .upsert(rows, { onConflict: 'recurring_id,occurred_on', ignoreDuplicates: true })
  if (error) { fail(error); return false }
  return true
}

const fail = e => { console.error(e); alert(e.message ?? String(e)) }

// ---- Home dashboard config (Phase 2). Which cards show and in what order, per
// device in localStorage. ponytail: a plain array merged with the default, so a
// newly-added card shows up for existing users instead of silently vanishing.
const HOME_CARD_LABELS = { alerts: 'Alerts', plan: 'Plan state', networth: 'Net worth', spending: 'Spending summary', upcoming: 'Upcoming bills', recent: 'Recent transactions' }
const HOME_DEFAULT = Object.keys(HOME_CARD_LABELS)
const HOME_KEY = 'budget.home'
function homeConfig() {
  let cfg = []
  try { const c = JSON.parse(localStorage.getItem(HOME_KEY)); if (Array.isArray(c)) cfg = c.filter(x => x && HOME_CARD_LABELS[x.id]) } catch {}
  for (const id of HOME_DEFAULT) if (!cfg.some(c => c.id === id)) cfg.push({ id, hidden: false })
  return cfg
}
const saveHomeConfig = cfg => localStorage.setItem(HOME_KEY, JSON.stringify(cfg))

// ---------------------------------------------------------------- render

const sumKind = k => state.txns.filter(t => t.kind === k).reduce((s, t) => s + cents(t.amount), 0)

// Expected-income for Cost to Be Me. Per budget, in localStorage: it's a personal
// what-if, not budget data, so it never touches Supabase or RLS.
const ctbmKey = () => `ctbm-income-${state.budgetId}`
const ctbmIncome = () => Number(localStorage.getItem(ctbmKey())) || 0

// Categories still sitting at zero that have a target to fill. Untouched only:
// overwriting a number someone typed on purpose is not a convenience.
const unfilledCats = roll =>
  liveCats().filter(c => cents(c.monthly_limit) > 0 && (roll.cats.get(c.id)?.assigned ?? 0) === 0)

// Auto-assign modes. Amounts stay in cents until the last step to dodge float
// drift, then convert to dollars for assign(). Every mode derives from data we
// already hold: assigns (every month up to this one) and history (every txn up
// to this month's end), so "last month" is always in hand.
function autoAssignRows(mode, roll, scope = null) {
  const ms = monthStart(state.month)
  const prev = prevMonthStart(ms)
  const prevEnd = monthEnd(new Date(prev + 'T00:00'))
  // scope restricts a run to one category group (or all when null). Everything
  // below maps over this list, so every mode is group-scopable for free.
  const inScope = c => !scope || (c.group_name || '') === scope
  const scoped = liveCats().filter(inScope)
  const row = (c, amount) => ({ budget_id: state.budgetId, category_id: c.id, month: ms, amount })
  const assignedIn = (id, m) => state.assigns.filter(a => a.category_id === id && a.month === m).reduce((s, a) => s + cents(a.amount), 0)
  // The N month-starts before `ms`, newest first — the window the averages read.
  const backMonths = n => { const out = []; let m = ms; for (let i = 0; i < n; i++) { m = prevMonthStart(m); out.push(m) } return out }
  const AVG_N = 3
  switch (mode) {
    case 'target': return unfilledCats(roll).filter(inScope).map(c => row(c, c.monthly_limit))
    // Fund every target to what it needs this month, topping up whatever is
    // already assigned. 'target' above is the special case of this that only
    // touches empty envelopes; 'fund' also tops up the partly-assigned ones. A
    // snoozed target is skipped — you said skip it this month. assign() replaces
    // the month's amount, so the new amount is this month's assignment plus the
    // remaining shortfall.
    case 'fund':   return scoped.map(c => { const e = roll.cats.get(c.id); return e && e.needed > 0 && !e.snoozed ? row(c, (e.assigned + e.needed) / 100) : null }).filter(Boolean)
    case 'last':   return scoped.map(c => row(c, assignedIn(c.id, prev) / 100)).filter(r => r.amount > 0)
    case 'spent':  return scoped.map(c => row(c, sumSpentInRange(state.history, c.id, prev, prevEnd) / 100)).filter(r => r.amount > 0)
    // Average of the last AVG_N months' assigned / spent, months with nothing
    // counted as zero so a sometimes-funded category averages down honestly.
    case 'average': return scoped.map(c => { const ms3 = backMonths(AVG_N); return row(c, Math.round(ms3.reduce((s, m) => s + assignedIn(c.id, m), 0) / AVG_N) / 100) }).filter(r => r.amount > 0)
    case 'avgspent': return scoped.map(c => { const ms3 = backMonths(AVG_N); return row(c, Math.round(ms3.reduce((s, m) => s + sumSpentInRange(state.history, c.id, monthStart(new Date(m + 'T00:00')), monthEnd(new Date(m + 'T00:00'))), 0) / AVG_N) / 100) }).filter(r => r.amount > 0)
    // Reduce overfunding: pull back anything assigned past its target. Only
    // targeted, currently-assigned, over-target envelopes; the pull is capped at
    // what's assigned so it never drives assigned negative.
    case 'reduce': return scoped.map(c => {
      const e = roll.cats.get(c.id); const targetC = cents(c.monthly_limit)
      if (!c.target_kind || !e || e.assigned <= 0) return null
      const over = e.available - targetC
      return over > 0 ? row(c, Math.max(0, e.assigned - over) / 100) : null
    }).filter(Boolean)
    // Reset available: drop the rollover so Available equals this month's Assigned.
    // In a cumulative model that means offsetting the carried balance, which can
    // be a negative assignment (allowed, same as pulling money back by hand).
    case 'resetavail': return scoped.map(c => { const e = roll.cats.get(c.id); return e ? row(c, (2 * e.assigned - e.available) / 100) : null }).filter(Boolean)
    case 'reset':  return scoped.map(c => row(c, 0))
    default: return []
  }
}

// One render pass fills every screen's containers; the tab bar only chooses
// which is visible, so switching tabs never refetches or re-renders.
// OPUS: a new screen renders in its own block at the bottom of this function,
// reading `roll` / state like the blocks above it. Keep templates to the §3
// kit markup in styles.css — no new class names.
function render() {
  $('month-label').textContent = monthLabel(state.month)

  // The active budget's name reads as the title; tapping it opens the picker
  // (#switch-dialog). The picker has its own New-budget row, so there is no
  // phantom "New budget…" entry to mis-select the way a <select> option would.
  const active = state.budgets.find(b => b.id === state.budgetId)
  $('budget-name').textContent = active ? active.name : ''

  const has = !!state.budgetId
  $('no-budget').hidden = has
  $('budget-view').hidden = !has
  $('budget-switch').hidden = !has
  $('rename-budget').hidden = !has
  $('add-btn').hidden = !has
  if (!has) { $('rta-banner').innerHTML = ''; return }

  const roll = rollNow()
  const totalSpent = sumKind('expense')
  const assignedNow = state.cats.reduce((s, c) => s + (roll.cats.get(c.id)?.assigned ?? 0), 0)

  // --- rta-banner (kit) — the hero number, counting it to zero is the method.
  const rtaK = roll.rta < 0 ? 'over' : roll.rta > 0 ? 'ok' : 'zero'
  $('rta-banner').innerHTML = `
    <div class="rta-banner rta-${rtaK}">
      <div class="rta-text">
        <span class="rta-label">Ready to Assign</span>
        <span class="rta-amt num">${money(roll.rta)}</span>
        <span class="rta-hint">${
          roll.rta < 0 ? 'More assigned than you have. Take some back.'
          : roll.rta > 0 ? 'Give every dollar a job.'
          : 'Every dollar has a job.'}</span>
      </div>
      ${liveCats().length ? '<button class="btn-quiet" id="auto-assign">Auto-assign</button>' : ''}
    </div>`

  // --- inspector summary card: month totals + Cost to Be Me. CTBM is the sum
  // of every target's needed-this-month vs an expected-income figure the user
  // types (localStorage per budget; a personal what-if, not budget data).
  // Snoozed categories are excluded — you've said skip them this month, so they
  // don't add to what it costs to be you this month.
  const costToBeMe = liveCats().reduce((s, c) => { const e = roll.cats.get(c.id); return s + (e && !e.snoozed ? e.needed : 0) }, 0)
  const hasTargets = liveCats().some(c => c.target_kind)
  const incomeC = cents(ctbmIncome())
  const ctbm = hasTargets ? `
    <div class="ctbm">
      <div class="ctbm-row">
        <span class="small muted">Cost to Be Me</span>
        <span class="num">${money(costToBeMe)}</span>
      </div>
      <div class="ctbm-row">
        <label class="small muted" for="ctbm-income">Expected income</label>
        <input class="num" id="ctbm-income" type="number" step="0.01" min="0" inputmode="decimal"
               placeholder="0.00" value="${ctbmIncome() || ''}">
      </div>
      ${incomeC > 0 ? `<div class="ctbm-verdict ${incomeC >= costToBeMe ? 'ok' : 'short'} num">${
        incomeC >= costToBeMe
          ? `Covered, ${money(incomeC - costToBeMe)} to spare`
          : `Short ${money(costToBeMe - incomeC)}`}</div>` : ''}
    </div>` : ''
  $('summary').innerHTML = `
    <div class="summary-line"><span>Assigned this month</span><span class="num">${money(assignedNow)}</span></div>
    <div class="summary-line"><span>Spent this month</span><span class="num">${money(totalSpent)}</span></div>
    ${ctbm}`

  const pend = pendingRecurring()
  $('rec-banner').hidden = !pend.length
  if (pend.length) {
    $('rec-banner-text').textContent =
      `${pend.length} recurring ${pend.length === 1 ? 'item' : 'items'} not added for ${monthLabel(state.month)}.`
  }

  // Undo banner: only for the month the change landed in, so it can't offer to
  // rewrite a month you've since navigated away from.
  const u = state.undo
  const showUndo = !!u && u.month === monthStart(state.month)
  $('undo-banner').hidden = !showUndo
  if (showUndo) {
    $('undo-banner-text').textContent = u.n === 1
      ? 'Assignment changed.'
      : `${u.n} assignments changed.`
  }

  $('cat-count').textContent = liveCats().length ? `${liveCats().length}` : ''

  // --- avail pill (kit): the four states, quadruple-coded — fill, text color,
  // label, and the amount's own sign — so the verdict survives color-blindness.
  const availPill = e => {
    const label = e.status === 'over' ? 'Overspent'
      : e.status === 'under' ? `Needs ${money(e.needed)}`
      : e.snoozed ? 'Snoozed'
      : e.status === 'ok' ? 'Funded' : 'Empty'
    return `<span class="avail s-${e.status}${e.snoozed ? ' is-snoozed' : ''}"><b class="num">${money(e.available)}</b><i>${e.snoozed ? '<svg class="zzz" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h6l-6 8h6"/><path d="M14 4h6l-6 6h6"/></svg>' : ''}${label}</i></span>`
  }

  // --- cat-row (kit). The pill is Available (everything that rolled in) and
  // carries the verdict; the bar is only this month's pace and stays neutral —
  // an envelope can be over its monthly assignment and still green because
  // last month covered it, and a red bar next to a green pill reads as a bug.
  const catRow = c => {
    const e = roll.cats.get(c.id)
    // Target line: amber rows name the shortfall (with due date for by-date
    // goals), funded ones confirm it. ponytail: text, not a progress ring --
    // the ring is the design-engineer piece and does not gate the money logic.
    const tgt = c.target_kind
      ? `<div class="cat-tgt ${e.needed > 0 ? '' : 'tgt-met'} num">${
          e.needed > 0
            ? `${money(e.needed)} to fund${c.target_kind === 'by_date' && c.target_due ? ` by ${c.target_due}` : ''}`
            : 'Target funded'}</div>`
      : ''
    return `<div class="cat-row">
      <div class="cat-name">${esc(c.name)}</div>
      <div class="cat-meta">
        <div class="cat-assigned">
          <label class="cell-lbl" for="a-${c.id}">Assigned</label>
          <input class="assign num" id="a-${c.id}" type="text" inputmode="decimal" autocomplete="off"
                 value="${(e.assigned / 100).toFixed(2)}" data-assign="${c.id}" aria-label="Assigned to ${esc(c.name)}">
        </div>
        <div class="cat-activity">
          <span class="cell-lbl">Activity</span>
          <span class="num">${money(e.activity)}</span>
        </div>
      </div>
      <button class="cat-avail" data-move="${c.id}" aria-label="Move money for ${esc(c.name)}">${availPill(e)}</button>
      <div class="cat-foot">
        <div class="cat-bar"><i style="width:${e.assigned > 0 ? Math.min(100, e.spent / e.assigned * 100) : 0}%"></i></div>
        ${tgt}
      </div>
    </div>`
  }

  // --- group (kit): native <details> does the collapsing; state.closedGroups
  // remembers what's shut because render() rebuilds this DOM on every refresh.
  // Ungrouped ('') renders first, bare. ponytail: a group is just the label
  // string (schema-v4), presentation only -- rollup() never sees a group. The
  // header subtotal is Available only; per-column group subtotals are an OPUS
  // seam (add two more .num spans to .group-sums and widen its grid).
  // --- focused views: filter which categories show, without touching the money.
  // The predicate reads the rolled entry, so a view always reflects live state;
  // the active view is remembered in localStorage (state.view).
  const viewMatch = (c, e) => !e ? false :
      state.view === 'under'      ? e.status === 'under'
    : state.view === 'over'       ? e.status === 'over'
    : state.view === 'overfunded' ? !!c.target_kind && e.available > cents(c.monthly_limit)
    : state.view === 'available'  ? e.available > 0
    : state.view === 'snoozed'    ? e.snoozed
    : true
  const VIEWS = [
    ['all', 'All'], ['under', 'Underfunded'], ['over', 'Overspent'],
    ['available', 'Has money'], ['overfunded', 'Overfunded'], ['snoozed', 'Snoozed']
  ]
  const viewCount = v => liveCats().filter(c => {
    const e = roll.cats.get(c.id)
    return v === 'all' ? true
      : v === 'under' ? e?.status === 'under'
      : v === 'over' ? e?.status === 'over'
      : v === 'overfunded' ? !!c.target_kind && e && e.available > cents(c.monthly_limit)
      : v === 'available' ? e && e.available > 0
      : v === 'snoozed' ? e?.snoozed
      : false
  }).length
  $('view-bar').innerHTML = liveCats().length ? VIEWS.map(([v, label]) => {
    const n = viewCount(v)
    return `<button class="view-chip${state.view === v ? ' is-active' : ''}" data-view="${v}"${v !== 'all' && !n ? ' disabled' : ''}>${label}${v === 'all' ? '' : ` <span class="view-n">${n}</span>`}</button>`
  }).join('') : ''

  const shownCats = liveCats().filter(c => viewMatch(c, roll.cats.get(c.id)))
  const groups = new Map()
  for (const c of shownCats) {
    const g = c.group_name || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(c)
  }
  const order = [...groups.keys()].sort((a, b) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))
  $('categories').innerHTML = !liveCats().length
    ? '<div class="empty">No categories yet. Add some, then give each one a job.</div>'
    : !shownCats.length
    ? `<div class="empty">No categories ${VIEWS.find(v => v[0] === state.view)?.[1].toLowerCase()} this month.</div>`
    : order.map(g => {
        const cats = groups.get(g)
        const rowsHtml = cats.map(catRow).join('')
        if (!g) return rowsHtml
        const avail = cats.reduce((s, c) => s + (roll.cats.get(c.id)?.available ?? 0), 0)
        return `<details class="group" data-group="${esc(g)}"${state.closedGroups.has(g) ? '' : ' open'}>
          <summary class="group-head">
            <svg class="group-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>
            <span class="group-name">${esc(g)}</span>
            <span class="group-sums num">${money(avail)}</span>
          </summary>
          <div class="group-body">${rowsHtml}</div>
        </details>`
      }).join('')

  // --- acct-row (kit): the Accounts screen. Today an "account" is a budget
  // pot; the active one shows its cash balance (all income minus all expenses
  // across loaded history, i.e. up to the viewed month's end).
  // ponytail: other pots show no balance -- their transactions aren't loaded
  // until you switch. Phase E real accounts replace this block wholesale.
  const balC = state.history.reduce((s, t) => s + (t.kind === 'income' ? 1 : -1) * cents(t.amount), 0)
  const chev = '<svg class="acct-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>'
  $('accounts').innerHTML = `
    <div class="acct-total"><span class="small muted">Cash on hand &middot; as of ${monthLabel(state.month)}</span><b class="num">${money(balC)}</b></div>` +
    state.budgets.map(b => {
      const active = b.id === state.budgetId
      return `<button class="acct-row" data-acct="${b.id}"${active ? ' aria-current="true"' : ''}>
        <span class="acct-dot">${esc((b.name[0] || '?').toUpperCase())}</span>
        <span class="acct-body">
          <span class="acct-name">${esc(b.name)}</span>
          <span class="acct-meta">${active ? 'This pot &middot; open now' : 'Tap to open this pot'}</span>
        </span>
        <span class="acct-bal num">${active ? money(balC) : '&mdash;'}</span>
        ${chev}
      </button>`
    }).join('')

  // --- txn-row (kit): the register. In select mode the row leads with a check
  // and the body toggles selection; the per-row delete yields to the bulk bar.
  const catName = id => state.cats.find(c => c.id === id)?.name ?? 'Uncategorized'
  // The register is a view over the month already loaded: an optional category
  // drill-through (from a Reflect breakdown row, matched on the same '__uncat__'
  // bucket key) AND an optional free-text search, both composing, neither
  // refetching. txnMatches owns which fields the search covers.
  const filterName = state.txnFilter === '__uncat__' ? 'Uncategorized'
    : state.txnFilter ? catName(state.txnFilter) : ''
  const q = state.txnSearch.trim().toLowerCase()
  // Split children fold into their parent (the register shows one line per split);
  // the parent's own category is null, so a category filter matches a split when
  // any of its children is in that category.
  const parentIds = splitParentIds(state.txns)
  const childrenOf = pid => state.txns.filter(t => t.parent_id === pid)
  const inFilter = t => !state.txnFilter
    || (t.category_id ?? '__uncat__') === state.txnFilter
    || (parentIds.has(t.id) && childrenOf(t.id).some(ch => (ch.category_id ?? '__uncat__') === state.txnFilter))
  const visibleTxns = state.txns.filter(t => !t.parent_id && inFilter(t) && txnMatches(t, q, catName))
  $('txn-filter').innerHTML = state.txnFilter
    ? `<div class="filter-chip"><span>${esc(filterName)}</span><button data-clearfilter aria-label="Clear ${esc(filterName)} filter">&times;</button></div>`
    : ''
  // Keep the (static) search box in sync with state. While typing, oninput has
  // already set state.txnSearch = box value, so this no-ops and the caret is safe;
  // the only time they diverge is an external reset (month/budget change), where
  // writing the box — clearing it — is exactly what we want.
  const searchEl = $('txn-search')
  if (searchEl && searchEl.value !== state.txnSearch) searchEl.value = state.txnSearch
  $('txn-count').textContent = visibleTxns.length ? `${visibleTxns.length}` : ''
  const sel = state.selMode
  $('transactions').innerHTML = visibleTxns.length ? visibleTxns.map(t => `
    <div class="txn-row${sel && state.sel.has(t.id) ? ' selected' : ''}">
      ${sel ? `<span class="check" aria-hidden="true">${state.sel.has(t.id) ? '&#10003;' : ''}</span>` : ''}
      ${t.flag ? `<span class="flag-dot" style="background:var(--flag-${t.flag})" title="Flag: ${t.flag}"></span>` : ''}
      <div class="txn-body" ${sel ? `data-sel="${t.id}"` : `data-edit="${t.id}"`}>
        <div class="txn-desc">${esc(t.description) || '<span class="muted">No description</span>'}</div>
        <div class="txn-meta">${t.occurred_on} &middot; ${parentIds.has(t.id) ? `Split &middot; ${childrenOf(t.id).length} categories` : esc(catName(t.category_id))}${t.recurring_id ? ' &middot; recurring' : ''}${t.memo ? ' &middot; ' + esc(t.memo) : ''}</div>
      </div>
      <span class="txn-amt num${t.kind === 'income' ? ' txn-in' : ''}">${t.kind === 'income' ? '+' : '&minus;'}${money(cents(t.amount))}</span>
      ${sel ? '' : `<button class="row-del" data-del="${t.id}" aria-label="Delete transaction">&times;</button>`}
    </div>`).join('') : `<div class="empty">${(state.txnFilter || q) ? 'No transactions match.' : 'Nothing logged this month.'}</div>`

  // Bulk bar reflects the current selection; the Select toggle flips its label.
  // The bar and the FAB share the floating slot, so only one shows at a time.
  $('bulk-bar').hidden = !sel
  $('add-btn').hidden = sel
  $('sel-toggle').textContent = sel ? 'Done' : 'Select'
  if (sel) $('bulk-count').textContent = `${state.sel.size} selected`

  // --- reflect (Phase D reports). Both cards read state.txns (this month's list,
  // the same slice the register shows), so they follow the month stepper with no
  // extra fetch and always describe the same window.
  $('reflect-sub').textContent = `· ${monthLabel(state.month)}`

  // Income vs expense overview: money in, money out, and the net (green surplus /
  // red deficit). Signs are explicit — money() already renders a negative net
  // with its own minus, so only a positive net needs a prepended plus.
  const cf = cashFlow(state.txns)
  const netK = cf.net > 0 ? 'net-pos' : cf.net < 0 ? 'net-neg' : ''
  $('reflect-cashflow').innerHTML = `
    <div class="card cashflow">
      <div class="summary-line"><span>Income</span><span class="num ${cf.income ? 'cf-pos' : ''}">${cf.income ? '+' : ''}${money(cf.income)}</span></div>
      <div class="summary-line"><span>Expenses</span><span class="num">${cf.expense ? '&minus;' : ''}${money(cf.expense)}</span></div>
      <div class="cashflow-net ${netK}"><span>Net this month</span><span class="num">${cf.net > 0 ? '+' : ''}${money(cf.net)}</span></div>
    </div>`

  // Spending breakdown: the month on screen, expenses by category, largest first,
  // each bar the category's share of the total. Each row is a button that drills
  // through to the register filtered to that category (data-bd carries the same
  // bucket key the filter matches on).
  const bd = spendingBreakdown(state.txns, state.cats)
  $('reflect-export').hidden = !bd.total
  $('reflect-report').innerHTML = bd.total ? `
    <div class="card breakdown">
      <div class="bd-total">
        <span class="small muted">Spent in ${monthLabel(state.month)}</span>
        <b class="num">${money(bd.total)}</b>
      </div>
      ${bd.rows.map(r => {
        const pct = Math.round(r.amount / bd.total * 100)
        return `<button class="bd-row" data-bd="${r.id ?? '__uncat__'}">
          <div class="bd-head">
            <span class="bd-name">${esc(r.name)}</span>
            <span class="bd-amt num">${money(r.amount)} &middot; ${pct}%</span>
          </div>
          <div class="bd-bar"><i style="width:${r.amount / bd.total * 100}%"></i></div>
        </button>`
      }).join('')}
    </div>` : '<div class="rows"><div class="empty">Nothing spent in ' + esc(monthLabel(state.month)) + ' yet.</div></div>'

  // Age of Money: how long money sits before it's spent (FIFO over all loaded
  // history, up to the month on screen). Null until there's banked income to
  // spend against, so a new budget shows nothing rather than a misleading zero.
  const aom = ageOfMoney(state.history)
  $('reflect-aom').innerHTML = aom == null ? '' : `
    <div class="card aom">
      <div class="aom-val"><b>${aom}</b><span>day${aom === 1 ? '' : 's'} old</span></div>
      <div class="aom-body">
        <span class="small muted-strong">Age of Money</span>
        <p class="small muted">How long your money typically sits before you spend it. Higher means you're spending income from further back, not paycheque to paycheque.</p>
      </div>
    </div>`

  // Net worth (Phase 4): assets − liabilities as of the month on screen, from the
  // latest snapshot per account (carry-forward). Computed once here; the Reflect
  // card and the Home card both read it.
  const nwMs = monthStart(state.month)
  const nw = netWorthAt(state.accounts, state.snapshots, nwMs)
  renderNetWorth(nw, nwMs)

  // --- home (Phase 2 dashboard). A configurable card stack over data already in
  // hand: roll (plan state), totalSpent vs last month (spending), pendingRecurring
  // (upcoming), state.txns (recent). Each card is a function; homeConfig() decides
  // order and visibility. Cards that would be empty (no alerts, no bills) return ''
  // and are dropped, so the stack never shows a hollow card.
  const overspent = liveCats().filter(c => roll.cats.get(c.id)?.status === 'over').length
  const prevMs = prevMonthStart(monthStart(state.month))
  const prevEndS = monthEnd(new Date(prevMs + 'T00:00'))
  const lastSpent = state.history
    .filter(t => t.kind === 'expense' && !t.parent_id && t.occurred_on >= prevMs && t.occurred_on <= prevEndS)
    .reduce((s, t) => s + cents(t.amount), 0)
  // Recurring occurrences due within the next 7 days (local dates, not UTC, to
  // avoid an off-by-one near midnight). pendingRecurring already drops the added.
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const t0 = iso(new Date()), t7 = iso(new Date(Date.now() + 7 * 864e5))
  const upcoming = pendingRecurring().filter(p => p.date >= t0 && p.date <= t7).sort((a, b) => a.date < b.date ? -1 : 1)
  const recent = state.txns.filter(t => !t.parent_id).sort((a, b) => a.occurred_on < b.occurred_on ? 1 : -1).slice(0, 5)

  // rtaK (over/ok/zero) is already computed above for the RTA banner; reuse it.
  const homeCards = {
    alerts: () => {
      const a = []
      if (roll.rta > 0) a.push(`<button class="home-alert a-ok" data-goto="budget"><span>Money to assign</span><b class="num">${money(roll.rta)}</b></button>`)
      else if (roll.rta < 0) a.push(`<button class="home-alert a-over" data-goto="budget"><span>Assigned more than you have</span><b class="num">${money(roll.rta)}</b></button>`)
      if (overspent) a.push(`<button class="home-alert a-over" data-goto="budget" data-view="over"><span>Overspending to cover</span><b>${overspent} categor${overspent === 1 ? 'y' : 'ies'} &rsaquo;</b></button>`)
      return a.length ? `<div class="home-alerts">${a.join('')}</div>` : ''
    },
    plan: () => `<button class="card home-plan" data-goto="budget">
      <span class="small muted">Ready to Assign</span>
      <b class="num rta-amt home-rta-${rtaK}">${money(roll.rta)}</b>
      <span class="small muted">${overspent ? `${overspent} overspent` : 'Nothing overspent'} &middot; ${liveCats().length} categor${liveCats().length === 1 ? 'y' : 'ies'}</span>
    </button>`,
    // Net worth: current value + change since last month; taps through to the
    // Reflect view. Hidden entirely until an account has a balance (nw.rows empty).
    networth: () => {
      if (!nw.rows.length) return ''
      const d = nw.net - netWorthAt(state.accounts, state.snapshots, prevMs).net
      return `<button class="card home-plan" data-goto="reflect">
        <span class="small muted">Net worth</span>
        <b class="num rta-amt ${nw.net < 0 ? 'home-rta-over' : 'home-rta-ok'}">${money(nw.net)}</b>
        <span class="small muted">${d === 0 ? 'No change this month' : `${money(Math.abs(d))} ${d > 0 ? 'up' : 'down'} this month`} &middot; ${nw.rows.length} account${nw.rows.length === 1 ? '' : 's'}</span>
      </button>`
    },
    spending: () => {
      const d = totalSpent - lastSpent
      return `<div class="card">
        <div class="summary-line"><span>Spent this month</span><span class="num">${money(totalSpent)}</span></div>
        <div class="summary-line"><span>Spent last month</span><span class="num muted">${money(lastSpent)}</span></div>
        <div class="home-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''} num">${d === 0 ? 'Same as last month' : `${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than last month`}</div>
      </div>`
    },
    upcoming: () => upcoming.length ? `<div class="card">
      <div class="home-head">Next 7 days</div>
      ${upcoming.map(({ rule: r, date }) => `<button class="home-row" data-goto="accounts">
        <span class="home-row-main">${esc(r.description) || '<span class="muted">Recurring</span>'}</span>
        <span class="home-row-sub">${date}</span>
        <span class="txn-amt num${r.kind === 'income' ? ' txn-in' : ''}">${r.kind === 'income' ? '+' : '&minus;'}${money(cents(r.amount))}</span>
      </button>`).join('')}
    </div>` : '',
    recent: () => recent.length ? `<div class="card">
      <div class="home-head">Recent</div>
      ${recent.map(t => `<button class="home-row" data-goto="accounts">
        <span class="home-row-main">${esc(t.description) || '<span class="muted">No description</span>'}</span>
        <span class="home-row-sub">${t.occurred_on} &middot; ${parentIds.has(t.id) ? 'Split' : esc(catName(t.category_id))}</span>
        <span class="txn-amt num${t.kind === 'income' ? ' txn-in' : ''}">${t.kind === 'income' ? '+' : '&minus;'}${money(cents(t.amount))}</span>
      </button>`).join('')}
    </div>` : ''
  }
  const homeHtml = homeConfig().filter(c => homeCards[c.id] && !c.hidden).map(c => homeCards[c.id]()).filter(Boolean)
  $('home-cards').innerHTML = homeHtml.length
    ? homeHtml.join('')
    : '<div class="empty">Nothing to show yet. Log a transaction, or open the Budget tab.</div>'

  renderSettings()
}

async function refresh() {
  await loadMonth()
  if (await maybeAutoApply()) await loadMonth()  // reload so the fresh rows show
  render()
  maybeIntro()
}

// ---- ?vp — viewport diagnostic (2026-07-21)
//
// The dock sat above the bottom of the screen on a real iPhone and nowhere else:
// not in desktop responsive mode, not in the headless browser. Rather than guess a
// third time, this prints the numbers that actually decide where the bottom of the
// page is, on the device showing the problem. Load /?vp and screenshot it.
//
// The question it answers: is the gap OUR layout (the shell is shorter than the
// visible area) or the BROWSER's chrome (Safari's bottom toolbar, which a page
// cannot draw under)? `dockGapToViewport` near 0 with `innerH` well under
// `screenH` means the shell is doing its job and the space belongs to Safari.
if (new URLSearchParams(location.search).has('vp')) {
  const probe = unit => {
    const el = document.createElement('div')
    el.style.cssText = `position:fixed;top:0;left:0;width:1px;height:100${unit};visibility:hidden;pointer-events:none`
    document.body.appendChild(el)
    const h = el.getBoundingClientRect().height
    el.remove()
    return Math.round(h)
  }
  const envPx = side => {
    const el = document.createElement('div')
    el.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;height:env(safe-area-inset-${side})`
    document.body.appendChild(el)
    const h = el.getBoundingClientRect().height
    el.remove()
    return Math.round(h)
  }
  const show = () => {
    const bar = document.querySelector('.tabbar')
    const r = bar ? bar.getBoundingClientRect() : null
    const vv = window.visualViewport
    const rows = {
      'screen.height': screen.height,
      'window.innerHeight': innerHeight,
      'visualViewport.height': vv ? Math.round(vv.height) : 'n/a',
      'visualViewport.offsetTop': vv ? Math.round(vv.offsetTop) : 'n/a',
      '100vh': probe('vh'), '100svh': probe('svh'),
      '100lvh': probe('lvh'), '100dvh': probe('dvh'),
      'safe-area-bottom': envPx('bottom'),
      'safe-area-top': envPx('top'),
      '#app height': Math.round($('app').getBoundingClientRect().height),
      'dock height': r ? Math.round(r.height) : 'n/a',
      'dock padBottom': bar ? getComputedStyle(bar).paddingBottom : 'n/a',
      // If the icons sit far above the bar's own bottom edge, the safe-area
      // allowance is being added while Safari's toolbar already occupies that
      // space — that would read as "the dock is above the bottom" even though the
      // bar itself is flush.
      'icons→barBottom': (() => {
        const icon = bar?.querySelector('.tab')
        return icon && r ? Math.round(r.bottom - icon.getBoundingClientRect().bottom) : 'n/a'
      })(),
      'dock bottom': r ? Math.round(r.bottom) : 'no dock',
      'dockGapToViewport': r ? Math.round(innerHeight - r.bottom) : 'n/a',
      'dockGapToVisualVP': r && vv ? Math.round(vv.height - r.bottom) : 'n/a',
      'standalone PWA': (matchMedia('(display-mode: standalone)').matches || navigator.standalone) ? 'YES' : 'no',
      'docScrolls': document.documentElement.scrollHeight > document.documentElement.clientHeight
    }
    let box = $('vp-box')
    if (!box) {
      box = document.createElement('pre')
      box.id = 'vp-box'
      box.style.cssText = 'position:fixed;inset:0;z-index:9999;margin:0;padding:16px;' +
        'background:#101617;color:#D8F3F0;font:12px/1.7 ui-monospace,Menlo,monospace;' +
        'white-space:pre-wrap;overflow:auto'
      document.body.appendChild(box)
    }
    box.textContent = 'VIEWPORT DIAGNOSTIC — screenshot this\n\n' +
      Object.entries(rows).map(([k, v]) => k.padEnd(24) + v).join('\n') +
      '\n\nIf dockGapToViewport is ~0, the shell is correct and the empty space\n' +
      'below is Safari\'s own toolbar — a page cannot draw under it.\n' +
      'If it is a large number, the bug is ours.\n\nTap to refresh.'
  }
  addEventListener('load', show)
  addEventListener('resize', show)
  visualViewport?.addEventListener('resize', show)
  addEventListener('click', show)
  setTimeout(show, 300)
}

// ---- first-run explainer (Phase 7). The envelope model is the thing people
// bounce off, so say it once before the empty plan rather than letting someone
// guess what Ready to Assign wants from them. Fires only on a budget with no
// categories yet — an existing budget means you already know — and remembers the
// dismissal per device. Re-openable from the overflow menu.
const INTRO_KEY = 'budget.seen-intro'
function maybeIntro() {
  if (localStorage.getItem(INTRO_KEY)) return
  if (!state.budgetId || state.cats.length) return
  if (document.querySelector('dialog[open]')) return
  $('intro-dialog').showModal()
}
$('intro-done').onclick = () => { localStorage.setItem(INTRO_KEY, '1'); $('intro-dialog').close() }
$('show-intro').onclick = () => $('intro-dialog').showModal()

// ---------------------------------------------------------------- auth

$('signin').onclick = async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  })
  if (error) { $('login-err').textContent = error.message; $('login-err').hidden = false }
}
$('signout').onclick = () => sb.auth.signOut()

// Supabase reports OAuth failures by redirecting back here with the reason in
// the query string and the hash. Without this the page just re-renders the login
// screen and the failure looks like a no-op. Query first: the hash copy is
// double-encoded.
{
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.slice(1))
  const err = q.get('error_description') ?? h.get('error_description')
  if (err) {
    $('login-err').textContent = err
    $('login-err').hidden = false
    history.replaceState(null, '', location.pathname)  // don't re-show on reload
  }
}

sb.auth.onAuthStateChange(async (_e, session) => {
  const on = !!session
  $('login').hidden = on
  $('app').hidden = !on
  $('add-btn').hidden = !on
  if (!on) { if (PREVIEW) previewSeed(); return }
  await loadBudgets()
  await refresh()
})

// ---------------------------------------------------------------- tabs

// Five screens, one visible. Switching is pure show/hide -- render() already
// filled every container, so tabs never refetch. The hash keeps the tab
// across reloads (matters for Add to Home Screen).
// OPUS: a new tab = its name here, a .tab button in the tabbar, and a
// <section class="screen" id="screen-NAME"> -- that is the whole wiring.
const SCREENS = ['home', 'budget', 'accounts', 'reflect', 'settings']
function switchTab(tab) {
  if (!SCREENS.includes(tab)) tab = 'budget'
  state.tab = tab
  document.body.dataset.tab = tab   // §4 CSS keys per-tab chrome off this
  for (const s of SCREENS) {
    const el = $('screen-' + s)
    if (el) el.hidden = s !== tab
  }
  for (const b of document.querySelectorAll('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
  // Start each section at the top. Screens are wildly different lengths, so
  // carrying the previous tab's scroll offset lands you mid-list in the new one —
  // and on iOS a retained offset also decides whether the URL bar is collapsed,
  // which is half of why the dock looked like it moved between tabs.
  // `main` is the scroller on phones; the document is on desktop. Reset both
  // rather than branch on a breakpoint.
  $('budget-view')?.scrollTo({ top: 0 })
  scrollTo({ top: 0 })
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab)
}
document.querySelector('.tabbar').onclick = e => {
  const b = e.target.closest('[data-tab]')
  if (b) switchTab(b.dataset.tab)
}
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)))

// ---- keyboard shortcuts (Phase 7). Desktop convenience; nothing here is the only
// way to reach a feature, so a keyboard that never fires costs nothing.
//
// Single letters, no modifiers, which is only safe because we bail on anything
// that means "the user is typing": a focused field, an open sheet (dialogs own the
// keyboard and close on Escape natively), or any modifier combination, so browser
// and OS shortcuts are never shadowed. `[` and `]` step months rather than the
// arrow keys, which belong to scrolling and to the focused control.
const SHORTCUTS = [
  ['n', 'New transaction'], ['/', 'Search transactions'], ['[', 'Previous month'],
  [']', 'Next month'], ['a', 'Auto-assign'], ['u', 'Undo last assignment'], ['?', 'This list']
]
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if ($('app').hidden) return                                   // logged out
  if (document.querySelector('dialog[open]')) return            // the sheet owns the keys
  const t = e.target
  if (t.matches?.('input, textarea, select') || t.isContentEditable) return

  const act = {
    n: () => openTxn(null),
    '/': () => { switchTab('accounts'); $('txn-search').focus() },
    '[': () => goMonth(-1),
    ']': () => goMonth(1),
    a: () => liveCats().length && openAutoAssign(),
    u: () => takeUndo(),
    '?': () => $('keys-dialog').showModal()
  }[e.key]
  if (!act) return
  e.preventDefault()
  act()
})
$('keys-list').innerHTML = SHORTCUTS.map(([k, label]) =>
  `<div class="keys-row"><kbd>${esc(k)}</kbd><span class="small">${esc(label)}</span></div>`).join('')
$('keys-done').onclick = () => $('keys-dialog').close()
$('show-keys').onclick = () => $('keys-dialog').showModal()

// ---- home dashboard: card taps and the Customize sheet.
// A card tap routes to its screen; an alert may also set a focused view first so
// the Budget screen opens already filtered (e.g. "overspending" -> over view).
$('home-cards').onclick = e => {
  const b = e.target.closest('[data-goto]')
  if (!b) return
  if (b.dataset.view) { state.view = b.dataset.view; localStorage.setItem('budget.view', state.view); render() }
  switchTab(b.dataset.goto)
}
function renderHomeCust() {
  const cfg = homeConfig()
  $('home-cust-list').innerHTML = cfg.map((c, i) => `
    <div class="cust-row">
      <label class="cust-name"><input type="checkbox" data-hide="${c.id}"${c.hidden ? '' : ' checked'}> ${HOME_CARD_LABELS[c.id]}</label>
      <span class="cust-move">
        <button class="btn-quiet" data-up="${c.id}"${i === 0 ? ' disabled' : ''} aria-label="Move ${HOME_CARD_LABELS[c.id]} up">&uarr;</button>
        <button class="btn-quiet" data-down="${c.id}"${i === cfg.length - 1 ? ' disabled' : ''} aria-label="Move ${HOME_CARD_LABELS[c.id]} down">&darr;</button>
      </span>
    </div>`).join('')
}
$('home-customize').onclick = () => { renderHomeCust(); $('home-cust').showModal() }
$('home-cust-done').onclick = () => $('home-cust').close()
$('home-cust').onclick = e => { if (e.target === $('home-cust')) $('home-cust').close() }  // backdrop tap
$('home-cust-list').onclick = e => {
  const up = e.target.closest('[data-up]'), down = e.target.closest('[data-down]')
  if (!up && !down) return
  const cfg = homeConfig()
  const id = (up || down).dataset[up ? 'up' : 'down']
  const i = cfg.findIndex(c => c.id === id), j = i + (up ? -1 : 1)
  if (j < 0 || j >= cfg.length) return
  ;[cfg[i], cfg[j]] = [cfg[j], cfg[i]]
  saveHomeConfig(cfg); renderHomeCust(); render()
}
$('home-cust-list').onchange = e => {
  const cb = e.target.closest('[data-hide]')
  if (!cb) return
  const cfg = homeConfig(), c = cfg.find(x => x.id === cb.dataset.hide)
  if (c) c.hidden = !cb.checked
  saveHomeConfig(cfg); render()
}
switchTab(location.hash.slice(1) || 'budget')

// Collapse memory for category groups: <details> does the collapsing, this
// remembers it, because render() rebuilds the DOM on every refresh. Click, not
// the toggle event: toggle is queued async and can fire after a re-render has
// already detached the element, losing the change. Click is synchronous and
// runs before the default action flips `open`, so the new state is !open.
$('categories').addEventListener('click', e => {
  const mv = e.target.closest('[data-move]')
  if (mv) return openMove(mv.dataset.move)
  const s = e.target.closest('summary.group-head')
  if (!s) return
  const d = s.parentElement
  if (d.open) state.closedGroups.add(d.dataset.group)
  else state.closedGroups.delete(d.dataset.group)
})

// Focused views: pick a filter over the plan; remember it across reloads. Only a
// re-render is needed — the filter is a view over data already loaded.
$('view-bar').onclick = e => {
  const b = e.target.closest('[data-view]')
  if (!b) return
  state.view = b.dataset.view
  localStorage.setItem('budget.view', state.view)
  render()
}

// Accounts screen: tapping another pot switches to it -- same data path as the
// header switcher, kept in sync.
$('accounts').onclick = async e => {
  const b = e.target.closest('[data-acct]')
  if (!b || b.dataset.acct === state.budgetId) return
  state.selMode = false; state.sel.clear(); state.txnFilter = null; state.txnSearch = ''; state.undo = null
  state.budgetId = b.dataset.acct
  await refresh()   // re-renders the switcher label; no <select>.value to sync now
}

// ---------------------------------------------------------------- events

// Leaving the month clears any selection: its ids belong to the month you left.
// state.undo is dropped on a month change: the banner offers to put figures back
// into a month you can no longer see, which is worse than not offering at all.
const goMonth = delta => { if (state.selMode) { state.selMode = false; state.sel.clear() } state.txnFilter = null; state.txnSearch = ''; state.undo = null; state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1); refresh() }
$('prev').onclick = () => goMonth(-1)
$('next').onclick = () => goMonth(1)

// Two people, one budget: re-fetch when the tab comes back into view so a
// partner's changes show up. ponytail: focus refresh, not a Supabase Realtime
// channel -- no per-table replication to enable, and nobody watches the other's
// cursor live. Add a channel if live-while-both-looking ever matters.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.budgetId) refresh()
})

// Hide-amounts: glance privacy on a shared phone. A body class blurs every money
// value; localStorage keeps the choice across reloads. ponytail: privacy from a
// glance, not from a reader -- the numbers are still in the DOM.
const HIDE_KEY = 'budget.hideAmounts'
function applyHide(on) {
  document.body.classList.toggle('amounts-hidden', on)
  const b = $('hide-amounts')
  b.setAttribute('aria-pressed', String(on))   // §3 swaps eye ⇄ eye-off off this
  b.title = on ? 'Show amounts' : 'Hide amounts'
  b.setAttribute('aria-label', b.title)
}
$('hide-amounts').onclick = () => {
  const on = !document.body.classList.contains('amounts-hidden')
  localStorage.setItem(HIDE_KEY, on ? '1' : '')
  applyHide(on)
}
applyHide(localStorage.getItem(HIDE_KEY) === '1')

// Header overflow (⋯): rename / new / sign out live in a menu sheet now, off the
// bar. Open on tap; light-dismiss on the backdrop or after any item is chosen.
// The item's own handler (below) runs first as the click bubbles, then this
// closes the sheet. Esc-to-close comes free from <dialog>.
$('menu-btn').onclick = () => $('menu-dialog').showModal()
$('menu-dialog').onclick = e => {
  if (e.target === e.currentTarget || e.target.closest('.menu-item')) $('menu-dialog').close()
}

// ---- settings screen (2026-07-21)
//
// Two currency knobs with deliberately different scopes: the budget's currency is
// shared data (it changes what the stored numbers mean, for both people), while
// "show amounts in" is this device's reading preference and writes nothing to the
// server. Changing the base is therefore confirmed and the display is not.
function renderSettings() {
  const { base, display, rate, at, stale, failed } = state.fx
  $('set-base').value = base
  $('set-display').value = display
  const el = $('set-fx')
  if (failed) {
    el.textContent = `Couldn't fetch an exchange rate, so amounts are shown in ${base} as stored. Check your connection and reopen Settings.`
  } else if (rate === 1) {
    el.textContent = `Amounts are shown exactly as stored. Pick a different display currency to convert them.`
  } else {
    el.textContent = `1 ${base} = ${rate.toFixed(4)} ${display} · rate from ${at}${stale ? " (couldn't refresh today, using the last one)" : ''}. Converted figures are marked “≈” — they're today's rate applied to past amounts, so they shift a little day to day. Everything is still stored and added up in ${base}.`
  }
}

// Display currency: this device only, so no confirm and no server write.
$('set-display').onchange = async e => {
  localStorage.setItem(FX_KEY, e.target.value)
  await refreshFx()
  renderSettings()
  render()
}

// Base currency: shared, and it reinterprets every existing amount rather than
// converting them, so it is confirmed in those words.
$('set-base').onchange = async e => {
  const next = e.target.value
  const prev = state.fx.base
  if (next === prev) return
  const ok = confirm(
    `Keep this budget in ${next}?\n\nThis does NOT convert anything. Every amount already recorded stays the same number and is simply read as ${next} from now on — for both of you. Only do this if the budget was really in ${next} all along.`)
  if (!ok) { e.target.value = prev; return }
  const { error } = await sb.from('budgets').update({ currency: next }).eq('id', state.budgetId)
  if (error) { e.target.value = prev; return fail(error) }
  await loadBudgets()
  renderSettings()
  render()
}

// The rest of Settings just routes to sheets that already exist.
$('set-rename').onclick = () => $('rename-budget').click()
$('set-intro').onclick = () => $('intro-dialog').showModal()
$('set-changelog').onclick = () => { renderChangelog(); $('changelog-dialog').showModal() }
$('set-signout').onclick = () => $('signout').click()

// ---- sheet dismissal, for every dialog at once.
//
// This is a phone app, and most sheets only closed via their Done button — so the
// two gestures people actually try, tapping the dimmed backdrop and dragging the
// sheet down, did nothing. `.sheet::before` even draws an iOS grabber, promising a
// drag the app never implemented. Wire both once over every <dialog> rather than
// per sheet, so a new sheet inherits the behaviour by existing.
//
// The backdrop is the <dialog> itself (the .sheet child covers everything else),
// so `e.target === dlg` means the tap missed the sheet. The drag transforms
// `.sheet`, never the <dialog>: the dialog owns the open/close slide animation and
// reduced-motion pins its transform with !important, which would fight an inline
// style. `.sheet` is also the scroller, so a drag only starts at scrollTop 0 —
// otherwise flicking a long list (Categories, the register) would dismiss instead
// of scroll.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close() })

  const sheet = dlg.querySelector('.sheet')
  if (!sheet) continue
  const DISMISS_PX = 90            // past this, let go and it closes
  let startY = null, dy = 0
  const settle = () => { sheet.style.transition = ''; sheet.style.transform = '' }

  sheet.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || sheet.scrollTop > 0) return
    startY = e.touches[0].clientY
    dy = 0
    sheet.style.transition = 'none'
  }, { passive: true })

  sheet.addEventListener('touchmove', e => {
    if (startY == null) return
    dy = e.touches[0].clientY - startY
    // Downward only, and with resistance, so the sheet feels attached to the
    // finger rather than thrown.
    sheet.style.transform = dy > 0 ? `translateY(${dy * 0.9}px)` : ''
  }, { passive: true })

  sheet.addEventListener('touchend', () => {
    if (startY == null) return
    const dismissed = dy > DISMISS_PX
    startY = null; dy = 0
    if (dismissed) { settle(); dlg.close(); return }
    sheet.style.transition = 'transform 160ms var(--ease-out)'
    sheet.style.transform = ''
    sheet.addEventListener('transitionend', settle, { once: true })
  })
  sheet.addEventListener('touchcancel', () => { startY = null; dy = 0; settle() })
}

// Sheets that used to reload on their Done button now reload on *any* close, so a
// backdrop tap or a swipe leaves the same state behind as pressing Done.
for (const id of ['cat-dialog', 'rec-dialog', 'rules-dialog', 'cal-dialog', 'balances-dialog']) {
  $(id).addEventListener('close', () => refresh())
}

// ---- changelog: a static, user-facing list of what shipped, newest first.
// ponytail: a hardcoded array, not a table or a fetched file — it only changes
// when we ship, which is when this file changes anyway. Add a "new since you last
// looked" dot (localStorage last-seen date) if discoverability ever needs it.
const CHANGELOG = [
  ['2026-07-21', 'Phone fixes, and currencies', [
    'Fixed the bottom bar drifting on the Reflect tab — a too-wide control was pushing the page sideways.',
    'Fixed the budget rows on narrow phones: the Available pill no longer collides with Assigned and Activity.',
    'Every sheet now closes by tapping outside it or swiping it down, not just by pressing Done.',
    'A real Settings tab, with a currency chooser. Pick CAD or USD and amounts convert for you — your partner keeps reading in whatever they chose. Converted figures are marked “≈”, and everything is still stored in the budget’s own currency.'
  ]],
  ['2026-07-21', 'Install it, and undo things', [
    'Add Budget to your home screen — it opens without browser chrome, like an app. (It still needs a connection: your money should never be a stale cached number.)',
    'Changed an assignment by mistake? An Undo appears above the plan. If the other person has touched that category since, it tells you instead of overwriting them.',
    'Keyboard shortcuts on a computer — press ? to see them.',
    'A short “how this works” explainer for the envelope method, in the menu any time.'
  ]],
  ['2026-07-21', 'Tidying your categories', [
    'Put categories in the order you want them with the arrows in Categories.',
    'Archive a category you’re done with: it leaves the plan and the pickers, but its past spending stays in your history and your reports. Deleting still doesn’t — archive is the safe way to retire one.',
    'Give a category a note — why it exists, what it’s for. It shows when you tap its Available.'
  ]],
  ['2026-07-20', 'Net worth', [
    'Track accounts — what you own and what you owe — and type in their balances month by month.',
    'A net worth card on Reflect: total, per-account breakdown and a trend over 6, 12 or 24 months.',
    'A matching card on Home showing this month’s change.'
  ]],
  ['2026-07-20', 'Rules & recurring calendar', [
    'Rules auto-fill a category (and flag) from what a transaction’s description contains.',
    'Payee memory: a new transaction reuses the last category you gave that payee.',
    'A month calendar of recurring bills — see what’s added, tap a day to add what’s due.'
  ]],
  ['2026-07-20', 'Home dashboard', [
    'A new Home tab: money to assign, overspending, this month vs last, upcoming bills and recent activity.',
    'Show, hide and reorder the cards from Customize.'
  ]],
  ['2026-07-20', 'Envelope finishers', [
    'Split one transaction across several categories.',
    'Tap an Available amount to move money or cover overspending.',
    'Filter the plan, snooze a target for the month, and track your Age of Money.',
    'Type quick math like “12.50/2” in any amount field.'
  ]],
  ['2026-07-17', 'Reports & search', [
    'The Reflect tab: spending breakdown and income vs expense.',
    'Search the transactions register.'
  ]],
  ['2026-07-16', 'A fresh look', [
    'The new five-tab layout and design.',
    'Category targets, recurring rules, a Money Moves history and bulk editing.'
  ]],
  ['2026-07-15', 'Hello, budget', [
    'Shared envelope budgeting for two, with Google sign-in.'
  ]]
]

function renderChangelog() {
  $('changelog-list').innerHTML = CHANGELOG.map(([date, title, items]) => `
    <div class="cl-entry">
      <div class="cl-head"><span class="cl-title">${esc(title)}</span><span class="small muted">${esc(date)}</span></div>
      <ul class="cl-items">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
    </div>`).join('')
}
$('show-changelog').onclick = () => { renderChangelog(); $('changelog-dialog').showModal() }
$('changelog-done').onclick = () => $('changelog-dialog').close()
$('changelog-dialog').onclick = e => { if (e.target === $('changelog-dialog')) $('changelog-dialog').close() }  // backdrop tap

// Budget picker: the switcher button opens a sheet listing every budget (active
// one checked) plus a New-budget row. Replaces the native <select> dropdown.
function renderBudgetList() {
  $('budget-list').innerHTML = state.budgets.map(b => `
    <button class="menu-item budget-opt${b.id === state.budgetId ? ' is-active' : ''}" data-pick="${b.id}">
      <svg class="opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-11"/></svg>
      <span>${esc(b.name)}</span>
    </button>`).join('')
}
async function switchTo(id) {
  if (id === state.budgetId) return
  state.selMode = false; state.sel.clear(); state.txnFilter = null; state.txnSearch = ''; state.undo = null
  state.budgetId = id
  await refresh()
}
$('budget-switch').onclick = () => { renderBudgetList(); $('switch-dialog').showModal() }
$('switch-dialog').onclick = e => {
  if (e.target === e.currentTarget) return $('switch-dialog').close()   // backdrop
  const opt = e.target.closest('[data-pick]')
  if (opt) { $('switch-dialog').close(); switchTo(opt.dataset.pick); return }
  if (e.target.closest('#add-budget')) { $('switch-dialog').close(); newBudget() }
}

// openPrompt — the on-system replacement for window.prompt(). Resolves to the
// entered string, or null if dismissed (Cancel / Esc / backdrop). One reusable
// #prompt-dialog: title + label + cta; `confirmText` gates the CTA until the
// input matches it (delete), `danger` paints the CTA red. A `done` latch makes
// the first outcome win, so a submit value beats the close→null that follows it.
function openPrompt({ title, label, message = '', value = '', cta = 'Save', danger = false, confirmText = null }) {
  const dlg = $('prompt-dialog'), input = $('prompt-input'), ok = $('prompt-ok'), msg = $('prompt-msg')
  $('prompt-title').textContent = title
  $('prompt-label').textContent = label
  msg.textContent = message; msg.hidden = !message
  input.value = value
  ok.textContent = cta
  ok.classList.toggle('danger', danger)
  const gate = () => { if (confirmText !== null) ok.disabled = input.value.trim() !== confirmText }
  gate()
  return new Promise(resolve => {
    let done = false
    const finish = val => {
      if (done) return
      done = true
      input.oninput = null; ok.disabled = false
      dlg.removeEventListener('close', onClose)
      resolve(val)
    }
    const onClose = () => finish(null)   // Esc, Cancel, or backdrop all close the dialog
    input.oninput = gate
    dlg.addEventListener('close', onClose)
    $('prompt-cancel').onclick = () => dlg.close()
    dlg.onclick = e => { if (e.target === dlg) dlg.close() }   // backdrop tap
    $('prompt-form').onsubmit = e => {
      e.preventDefault()
      if (confirmText !== null && input.value.trim() !== confirmText) return   // gated: ignore
      finish(input.value)
      dlg.close()
    }
    dlg.showModal()
    // focus once the sheet is up; preselect existing text so a rename is one keystroke
    requestAnimationFrame(() => { input.focus(); if (confirmText === null) input.select() })
  })
}

async function newBudget() {
  const name = await openPrompt({ title: 'New budget', label: 'Budget name', cta: 'Create' })
  if (!name?.trim()) return
  const { error } = await sb.from('budgets').insert({ name: name.trim() })
  if (error) return fail(error)
  await loadBudgets()   // a trigger makes the creator a member, so it comes back
  await refresh()
}

$('new-budget').onclick = newBudget
$('first-budget').onclick = newBudget

// Rename the selected budget. Done rarely (two people). Also the fix for two
// budgets sharing a name: rename one so the switcher can tell them apart. The
// 1-60 length rule lives on the column, so a bad length surfaces through fail().
$('rename-budget').onclick = async () => {
  const b = state.budgets.find(x => x.id === state.budgetId)
  if (!b) return
  const name = await openPrompt({ title: 'Rename budget', label: 'Budget name', value: b.name, cta: 'Save' })
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed || trimmed === b.name) return
  const { error } = await sb.from('budgets').update({ name: trimmed }).eq('id', b.id)
  if (error) return fail(error)
  await loadBudgets(); render()
}

$('del-budget').onclick = async () => {
  const b = state.budgets.find(x => x.id === state.budgetId)
  if (!b) return
  // Type-the-name, not confirm(): this cascades to every category, transaction,
  // assignment and rule, and a confirm() is one thumb-slip on a phone from wiping
  // a year of data. openPrompt's confirmText gates the Delete button until the
  // name matches, so a mismatch can't even submit -- no post-hoc alert needed.
  const typed = await openPrompt({
    title: `Delete "${b.name}"?`,
    message: 'Removes its categories, transactions and recurring rules for good. This cannot be undone.',
    label: 'Type the budget name to confirm',
    cta: 'Delete', danger: true, confirmText: b.name
  })
  if (typed === null) return
  const { error } = await sb.from('budgets').delete().eq('id', b.id)
  if (error) return fail(error)
  state.budgetId = null   // loadBudgets falls back to whatever is left
  state.txnFilter = null; state.txnSearch = ''
  await loadBudgets()
  await refresh()
}

$('add-btn').onclick = () => openTxn(null)
$('txn-cancel').onclick = () => $('txn-dialog').close()

// Export the month on screen to CSV. ponytail: state.txns is the current month's
// list, so this exports what you see -- no separate "all transactions" fetch.
$('export-csv').onclick = () => {
  if (!state.txns.length) return
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const catName = id => state.cats.find(c => c.id === id)?.name ?? ''
  const head = ['date', 'description', 'category', 'type', 'amount', 'flag', 'memo']
  const body = state.txns.map(t =>
    [t.occurred_on, t.description, catName(t.category_id), t.kind, Number(t.amount).toFixed(2), t.flag ?? '', t.memo ?? ''].map(cell).join(','))
  const csv = [head.join(','), ...body].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = `budget-${monthKey(state.month)}.csv`; a.click()
  URL.revokeObjectURL(url)
}

$('transactions').onclick = async e => {
  const pick = e.target.closest('[data-sel]')
  if (pick) {
    const id = pick.dataset.sel
    state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id)
    return render()
  }
  const del = e.target.closest('[data-del]')
  if (del) {
    if (!confirm('Delete this transaction?')) return
    const { error } = await sb.from('transactions').delete().eq('id', del.dataset.del)
    if (error) return fail(error)
    return refresh()
  }
  const edit = e.target.closest('[data-edit]')
  if (edit) openTxn(state.txns.find(t => t.id === edit.dataset.edit))
}

// Reflect drill-through: tap a breakdown category to see just its transactions.
// Sets the register filter (a view over the loaded month), renders it, then jumps
// to the Accounts tab where the register lives.
$('reflect-report').onclick = e => {
  const b = e.target.closest('[data-bd]')
  if (!b) return
  state.txnFilter = b.dataset.bd
  if (state.selMode) { state.selMode = false; state.sel.clear() }  // a stale selection isn't this view's
  render()
  switchTab('accounts')
}
$('txn-filter').onclick = e => {
  if (!e.target.closest('[data-clearfilter]')) return
  state.txnFilter = null
  render()
}

// Register search: type to filter the visible rows. render() rebuilds the rows
// but not the (static) input, so focus and the caret survive each keystroke.
$('txn-search').oninput = e => { state.txnSearch = e.target.value; render() }

// Export the month's spending breakdown (category, spent, share) to CSV. Distinct
// from the register Export, which dumps raw rows — this is the report summary.
// Same client-side Blob download, so nothing leaves the browser.
$('reflect-export').onclick = () => {
  const bd = spendingBreakdown(state.txns, state.cats)
  if (!bd.total) return
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const body = bd.rows.map(r =>
    [r.name, (r.amount / 100).toFixed(2), Math.round(r.amount / bd.total * 100) + '%'].map(cell).join(','))
  body.push(['Total', (bd.total / 100).toFixed(2), '100%'].map(cell).join(','))
  const csv = [['category', 'spent', 'share'].join(','), ...body].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = `budget-${monthKey(state.month)}-spending.csv`; a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------- assigning

// Upsert, not update: the row for (category, month) doesn't exist until someone
// assigns something, and "assigned nothing" and "never assigned" spend the same.
// `undoable: false` stops an undo from stacking its own undo, which would turn the
// banner into a permanent toggle. One level, this session only — see takeUndo().
async function assign(rows, { undoable = true } = {}) {
  if (!rows.length) return
  // Money Moves: record from -> to for every row that actually changes, reading
  // the "from" out of the assignments already in state. ponytail: state can be a
  // beat stale under two editors, so a move's from-amount is best-effort, not a
  // ledger you'd audit -- it's a trail of what changed, not double-entry.
  const currentAssigned = (catId, month) =>
    state.assigns.find(a => a.category_id === catId && a.month === month)?.amount ?? 0
  const moves = rows
    .map(r => ({ budget_id: r.budget_id, category_id: r.category_id, month: r.month,
                 from_amount: Number(currentAssigned(r.category_id, r.month)), to_amount: Number(r.amount) }))
    .filter(m => m.from_amount !== m.to_amount)

  const { error } = await sb.from('assignments').upsert(rows, { onConflict: 'category_id,month' })
  if (error) return fail(error)
  if (moves.length) await sb.from('money_moves').insert(moves)  // trail, not a gate
  // The inverse of what just happened, plus what we expect to find still there.
  // Auto-assign and a move both come through here, so one Undo covers a whole
  // batch of rows, not just a single typed figure.
  if (undoable && moves.length) {
    state.undo = {
      rows: moves.map(m => ({ budget_id: m.budget_id, category_id: m.category_id, month: m.month, amount: m.from_amount })),
      expect: moves.map(m => [m.category_id, m.month, m.to_amount]),
      month: moves[0].month,
      n: moves.length
    }
  }
  refresh()
}

// Undo the last assignment change. Deliberately NOT a general undo stack: one
// level, this session only, assignments only. Transaction edits and deletes are
// out — undoing those needs soft-delete, which means a schema change and a
// deleted-row filter on every read, for an action that already has a confirm.
//
// Two people share a budget, so before putting the old figures back we check the
// new ones are still there. If the other person has touched the same envelope
// since, undoing would silently stomp them; refuse and say so instead.
async function takeUndo() {
  const u = state.undo
  if (!u) return
  const stomped = undoStomped(u.expect, state.assigns)
  if (stomped.length) {
    state.undo = null
    render()
    return alert(`Can't undo — ${stomped.length === u.expect.length ? 'that assignment has' : 'one of those assignments has'} changed since. Nothing was touched.`)
  }
  state.undo = null
  await assign(u.rows, { undoable: false })
}

$('categories').onchange = e => {
  const id = e.target.dataset.assign
  if (!id) return
  // Validate at the boundary: a non-numeric entry is rejected (and the field put
  // back) rather than silently emptying the envelope. A bare number or a little
  // sum ("40+5") both work via the calculator.
  const v = evalAmount(e.target.value)
  const roll = rollNow()
  if (v == null) { e.target.value = ((roll.cats.get(id)?.assigned ?? 0) / 100).toFixed(2); return }
  assign([{ budget_id: state.budgetId, category_id: id, month: monthStart(state.month), amount: v }])
}

// ---------------------------------------------------------------- move / cover

// The quick-move / cover sheet — the highest-value envelope interaction. Tapping
// a category's Available opens it; an overspent one prefills covering the
// shortfall from Ready to Assign. A move is just two assignment writes (minus the
// source, plus the destination); Ready to Assign is derived, so an RTA endpoint
// writes nothing. assign() already logs the Money Move and refreshes.
function openMove(catId) {
  const c = state.cats.find(x => x.id === catId)
  const e = rollNow().cats.get(catId)
  if (!c || !e) return
  state.moveCat = catId
  const over = e.available < 0
  const opts = sel => `<option value="__rta__"${sel === '__rta__' ? ' selected' : ''}>Ready to Assign</option>` +
    liveCats().map(x => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')
  $('move-from').innerHTML = opts(over ? '__rta__' : catId)   // cover: pull IN from RTA; else move OUT to RTA
  $('move-to').innerHTML   = opts(over ? catId : '__rta__')
  const prefill = over ? -e.available : (e.available > 0 ? e.available : 0)
  $('move-amount').value = prefill ? (prefill / 100).toFixed(2) : ''
  $('move-title').textContent = c.name
  $('move-avail').className = `avail s-${e.status}`
  $('move-avail').innerHTML = `<b class="num">${money(e.available)}</b><i>${
    over ? 'Overspent' : e.status === 'under' ? `Needs ${money(e.needed)}` : e.status === 'ok' ? 'Available' : 'Empty'}</i>`
  // The note lives here rather than on the plan row: this sheet is where you're
  // deciding about the envelope, so "why does this exist" belongs where the
  // decision is. Empty note, no element.
  $('move-note').textContent = c.notes ?? ''
  $('move-note').hidden = !c.notes
  $('move-snooze-wrap').hidden = !c.target_kind
  $('move-snooze').checked = state.snoozed.has(catId)
  $('move-err').hidden = true
  $('move-dialog').showModal()
}

const moveErr = m => { $('move-err').textContent = m; $('move-err').hidden = false }

async function applyMove() {
  const from = $('move-from').value, to = $('move-to').value
  const ms = monthStart(state.month)
  if (from === to) return moveErr('Choose two different places.')
  const amt = evalAmount($('move-amount').value)
  if (amt == null || amt <= 0) return moveErr('Enter an amount greater than zero.')
  const amtC = cents(amt)
  const cur = id => cents(state.assigns.find(a => a.category_id === id && a.month === ms)?.amount ?? 0)
  const rows = []
  if (from !== '__rta__') rows.push({ budget_id: state.budgetId, category_id: from, month: ms, amount: (cur(from) - amtC) / 100 })
  if (to   !== '__rta__') rows.push({ budget_id: state.budgetId, category_id: to,   month: ms, amount: (cur(to)   + amtC) / 100 })
  $('move-dialog').close()
  if (rows.length) assign(rows)
}
$('move-apply').onclick = applyMove
$('move-cancel').onclick = () => $('move-dialog').close()

// Snooze this category's target for the month on screen: shared budget data, so
// it writes to Supabase (both partners see it). Toggled live from the move sheet.
$('move-snooze').onchange = async e => {
  const catId = state.moveCat, ms = monthStart(state.month)
  if (e.target.checked) {
    const { error } = await sb.from('target_snoozes').insert({ budget_id: state.budgetId, category_id: catId, month: ms })
    if (error) { e.target.checked = false; return fail(error) }
    state.snoozed.add(catId)
  } else {
    const { error } = await sb.from('target_snoozes').delete().eq('category_id', catId).eq('month', ms)
    if (error) { e.target.checked = true; return fail(error) }
    state.snoozed.delete(catId)
  }
  render()
}

// The RTA banner's Auto-assign button opens the modes sheet. The rollup is
// rebuilt per action rather than closed over, because the banner is re-rendered
// on every refresh and a captured rollup would be stale.
$('rta-banner').onclick = e => {
  if (e.target.closest('#auto-assign')) openAutoAssign()
}

// Expected-income edits persist and re-render the covered/short verdict. Only a
// re-render (not a full refresh) is needed -- no budget data changed.
$('summary').onchange = e => {
  if (e.target.id !== 'ctbm-income') return
  const v = Number(e.target.value) || 0
  if (v > 0) localStorage.setItem(ctbmKey(), String(v))
  else localStorage.removeItem(ctbmKey())
  render()
}

// Open the modes sheet: refresh the group-scope picker from the current groups
// first (it's a per-run choice, defaulting to all categories).
function openAutoAssign() {
  const groups = [...new Set(liveCats().map(c => c.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  $('aa-scope').innerHTML = `<option value="">All categories</option>` +
    groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
  $('aa-dialog').showModal()
}
$('aa-dialog').onclick = e => {
  const btn = e.target.closest('[data-aa]')
  if (!btn) return
  if (btn.dataset.aa === 'cancel') return $('aa-dialog').close()
  const scope = $('aa-scope').value || null
  const rows = autoAssignRows(btn.dataset.aa, rollNow(), scope)
  $('aa-dialog').close()
  if (rows.length) assign(rows)
}

// Archived categories drop out of the picker, except the one this row is already
// in — otherwise opening an old transaction would quietly re-point it at
// Uncategorized the moment you saved.
const catOptions = (selected, blank = 'Uncategorized') =>
  `<option value="">${blank}</option>` +
  state.cats.filter(c => !c.archived || c.id === selected)
    .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}${c.archived ? ' (archived)' : ''}</option>`).join('')

function openTxn(t) {
  state.editing = t?.id ?? null
  $('txn-title').textContent = t?.id ? 'Edit transaction' : 'Add transaction'
  $('t-kind').value = t?.kind ?? 'expense'
  $('t-amount').value = t?.amount != null ? t.amount : ''
  $('t-desc').value = t?.description ?? ''
  $('t-date').value = t?.occurred_on ?? today()
  $('t-cat').innerHTML = catOptions(t?.category_id)
  $('t-flag').value = t?.flag ?? ''
  $('t-memo').value = t?.memo ?? ''
  // Payees: distinct past descriptions feed the datalist. ponytail: descriptions
  // already are payees, so no payees table -- just autocomplete from history.
  $('payee-list').innerHTML = [...new Set(state.history.map(x => x.description).filter(Boolean))]
    .slice(0, 50).map(d => `<option value="${esc(d)}">`).join('')
  // Editing an existing split parent? Load its children as split rows.
  const kids = t?.id ? state.txns.filter(x => x.parent_id === t.id) : []
  state.splitRows = kids.length ? kids.map(ch => ({ category_id: ch.category_id ?? '', amount: String(ch.amount) })) : null
  setSplitUI(!!state.splitRows)
  // Duplicate / make-recurring only make sense on an existing row.
  $('txn-extra').hidden = !t?.id
  $('txn-err').hidden = true
  $('txn-dialog').showModal()
}

// Split UI: when on, the single Category field yields to the split list and the
// amount field becomes the split TOTAL. state.splitRows is the source of truth;
// renderSplits paints it, and the "remaining" figure keeps the parts honest.
function setSplitUI(on) {
  if (on && !state.splitRows) state.splitRows = [{ category_id: '', amount: '' }, { category_id: '', amount: '' }]
  if (!on) state.splitRows = null
  $('t-cat-field').hidden = on
  $('split-section').hidden = !on
  $('split-toggle').textContent = on ? 'Remove split' : 'Split across categories'
  if (on) renderSplits()
}

function renderSplits() {
  const rows = state.splitRows || []
  $('split-list').innerHTML = rows.map((r, i) => `
    <div class="split-row">
      <select data-splitcat="${i}" aria-label="Split category">${catOptions(r.category_id)}</select>
      <input class="num" type="text" inputmode="decimal" data-splitamt="${i}" value="${esc(r.amount)}" placeholder="0.00" aria-label="Split amount">
      <button type="button" class="row-del" data-splitdel="${i}" aria-label="Remove split row">&times;</button>
    </div>`).join('')
  // Remaining = total − entered parts (blanks count as zero). Green when it
  // reconciles, amber otherwise; the distribute button spreads it over blanks.
  const totalC = cents(evalAmount($('t-amount').value) ?? 0)
  const enteredC = rows.reduce((s, r) => s + cents(evalAmount(r.amount) ?? 0), 0)
  const remainC = totalC - enteredC
  $('split-remain').className = `split-remain ${remainC === 0 ? 'ok' : 'off'} num`
  $('split-remain').textContent = remainC === 0 ? 'Splits add up' : `${money(remainC)} left to assign`
}

const txnErr = m => { $('txn-err').textContent = m; $('txn-err').hidden = false }

$('txn-form').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const amount = evalAmount($('t-amount').value)
  if (amount == null || amount <= 0) return txnErr('Amount must be more than zero.')
  const base = {
    budget_id:   state.budgetId,
    kind:        $('t-kind').value,
    amount,
    description: $('t-desc').value.trim(),
    occurred_on: $('t-date').value,
    flag:        $('t-flag').value || null,
    memo:        $('t-memo').value.trim() || null
  }

  if (state.splitRows) {
    // A split: the parent carries the total and no category; children carry the
    // categories and their shares. Blanks auto-distribute the remainder.
    const raw = state.splitRows.map(r => ({ category_id: r.category_id || null, c: cents(evalAmount(r.amount) ?? 0) }))
    const dist = distributeSplit(cents(amount), raw.map(r => r.c))
    raw.forEach((r, i) => { r.c = dist[i] })
    const kids = raw.filter(r => r.c !== 0)
    if (kids.length < 2) return txnErr('A split needs at least two categories with amounts.')
    if (kids.some(k => k.c < 0)) return txnErr('The splits add up to more than the total.')
    if (kids.reduce((s, k) => s + k.c, 0) !== cents(amount)) return txnErr("The splits don't add up to the total.")
    const err = await saveSplit({ ...base, category_id: null }, kids)
    if (err) return txnErr(err)
  } else {
    const row = { ...base, category_id: $('t-cat').value || null }
    // Editing a row that used to be a split: drop the now-orphaned children.
    if (state.editing) await sb.from('transactions').delete().eq('parent_id', state.editing)
    const { error } = state.editing
      ? await sb.from('transactions').update({ ...row, parent_id: null }).eq('id', state.editing)
      : await sb.from('transactions').insert(row)
    if (error) return txnErr(error.message)
  }
  $('txn-dialog').close()
  refresh()
}

// Write a split parent + its children. On edit: update the parent, then replace
// its children (delete then re-insert — simplest correct, and a split is never
// large). On create: insert the parent, then children pointing at its new id.
async function saveSplit(parent, kids) {
  let parentId = state.editing
  if (parentId) {
    const { error } = await sb.from('transactions').update({ ...parent, parent_id: null }).eq('id', parentId)
    if (error) return error.message
    const { error: dErr } = await sb.from('transactions').delete().eq('parent_id', parentId)
    if (dErr) return dErr.message
  } else {
    const { data, error } = await sb.from('transactions').insert(parent).select('id').single()
    if (error) return error.message
    parentId = data.id
  }
  const childRows = kids.map(k => ({
    budget_id: parent.budget_id, kind: parent.kind, amount: k.c / 100,
    description: parent.description, category_id: k.category_id || null,
    occurred_on: parent.occurred_on, parent_id: parentId
  }))
  const { error } = await sb.from('transactions').insert(childRows)
  return error ? error.message : null
}

// Split controls: toggle, add a row, edit a row, remove a row, and the
// auto-distribute of the remainder over blank rows. state.splitRows is the model;
// renderSplits repaints. Amount fields accept the calculator ("12.50/2").
$('split-toggle').onclick = () => setSplitUI(!state.splitRows)
$('split-add').onclick = () => { state.splitRows.push({ category_id: '', amount: '' }); renderSplits() }
$('split-distribute').onclick = () => {
  const totalC = cents(evalAmount($('t-amount').value) ?? 0)
  const dist = distributeSplit(totalC, state.splitRows.map(r => cents(evalAmount(r.amount) ?? 0)))
  state.splitRows.forEach((r, i) => { r.amount = (dist[i] / 100).toFixed(2) })
  renderSplits()
}
$('split-list').onchange = e => {
  const ci = e.target.dataset.splitcat, ai = e.target.dataset.splitamt
  if (ci != null) state.splitRows[ci].category_id = e.target.value
  else if (ai != null) { state.splitRows[ai].amount = e.target.value; renderSplits() }  // repaint the remaining figure
}
$('split-list').onclick = e => {
  const del = e.target.closest('[data-splitdel]')
  if (!del) return
  if (state.splitRows.length <= 2) return   // a split is at least two rows
  state.splitRows.splice(Number(del.dataset.splitdel), 1)
  renderSplits()
}
// Amount field is the split total when splitting — recompute "remaining" as it
// changes. Also runs the calculator so "5+3" resolves in place.
$('t-amount').onchange = e => { const v = evalAmount(e.target.value); if (v != null) e.target.value = v; if (state.splitRows) renderSplits() }

// Phase 3 pre-fill: when the description (payee) changes, a matching rule sets the
// category and flag; with no rule, payee memory fills the category from the last
// time this exact payee was used. Only fills BLANKS — never stomps a pick the user
// already made, and splits manage their own categories. Fires on blur / datalist
// pick (change), so typing mid-word doesn't thrash the select.
$('t-desc').onchange = () => {
  if (state.splitRows) return
  const desc = $('t-desc').value
  const r = matchRule(desc, state.rules)
  if (r) {
    if (r.category_id && !$('t-cat').value) $('t-cat').value = r.category_id
    if (r.flag && !$('t-flag').value) $('t-flag').value = r.flag
    return
  }
  const last = lastCategoryFor(desc, state.history)
  if (last && !$('t-cat').value) $('t-cat').value = last
}

// Duplicate: reopen the current field values as a fresh draft dated today. Reads
// the form (so in-progress edits carry), and drops split mode — a plain copy.
$('txn-duplicate').onclick = () => {
  openTxn({
    kind: $('t-kind').value, amount: evalAmount($('t-amount').value) ?? undefined,
    description: $('t-desc').value, category_id: $('t-cat').value || null,
    flag: $('t-flag').value || null, memo: $('t-memo').value || null, occurred_on: today()
  })
}

// Convert to recurring: seed a monthly rule from this transaction (day taken from
// its date). The rule shows up under Recurring; nothing is auto-added.
$('txn-recur').onclick = async () => {
  const amount = evalAmount($('t-amount').value)
  if (amount == null || amount <= 0) return txnErr('Amount must be more than zero.')
  const date = $('t-date').value || today()
  const { error } = await sb.from('recurring').insert({
    budget_id: state.budgetId, kind: $('t-kind').value, amount,
    description: $('t-desc').value.trim(), category_id: $('t-cat').value || null,
    cadence: 'monthly', day_of_month: Number(date.slice(8, 10)) || 1, interval_months: 1, auto_apply: false
  })
  if (error) return txnErr(error.message)
  $('txn-dialog').close()
  await loadMonth(); render()
  alert('Saved a monthly recurring rule. Find it under Recurring on the Accounts tab.')
}

// ---------------------------------------------------------------- categories

$('manage-cats').onclick = () => { renderCats(); $('cat-dialog').showModal() }
// Done only closes; the dialog's `close` listener does the reload, so a backdrop
// tap and a swipe-down land in exactly the same state. Same for the four below.
$('cat-done').onclick = () => $('cat-dialog').close()

function renderCats() {
  const kindOpts = k => [['', 'No target'], ['monthly', 'Monthly refill'], ['by_date', 'By date']]
    .map(([v, l]) => `<option value="${v}" ${(k ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')
  // Live rows carry the full editor and the reorder arrows; archived rows collapse
  // to a name and a way back, because an archived category is not something you
  // tune, it's something you either restore or delete.
  const live = liveCats(), archived = state.cats.filter(c => c.archived)
  $('cat-list').innerHTML = live.map((c, i) => `
    <div class="cat-edit">
      <div class="cat-move">
        <button type="button" class="btn-quiet" data-catup="${c.id}"${i === 0 ? ' disabled' : ''} aria-label="Move ${esc(c.name)} up">&uarr;</button>
        <button type="button" class="btn-quiet" data-catdown="${c.id}"${i === live.length - 1 ? ' disabled' : ''} aria-label="Move ${esc(c.name)} down">&darr;</button>
      </div>
      <input type="text" value="${esc(c.name)}" maxlength="40" data-name="${c.id}" aria-label="Name">
      <input type="number" value="${c.monthly_limit}" step="0.01" min="0" inputmode="decimal" data-limit="${c.id}" aria-label="Target amount">
      <button class="row-del" data-delcat="${c.id}" aria-label="Delete category">&times;</button>
      <select class="cat-kind" data-kind="${c.id}" aria-label="Target kind">${kindOpts(c.target_kind)}</select>
      <input type="date" class="cat-due" value="${c.target_due ?? ''}" data-due="${c.id}" aria-label="Target date"${c.target_kind === 'by_date' ? '' : ' hidden'}>
      <input type="text" class="cat-group" value="${esc(c.group_name ?? '')}" maxlength="40" list="group-list" placeholder="Group (optional)" data-group="${c.id}" aria-label="Group">
      <input type="text" class="cat-note" value="${esc(c.notes ?? '')}" maxlength="280" placeholder="Note — why this envelope exists (optional)" data-note="${c.id}" aria-label="Note">
      <button type="button" class="btn-quiet cat-arch" data-arch="${c.id}">Archive</button>
    </div>`).join('') + (archived.length ? `
    <div class="cat-arch-head small muted">Archived &middot; ${archived.length}. Still counted in past months and reports.</div>` +
    archived.map(c => `
    <div class="cat-edit is-archived">
      <span class="cat-arch-name">${esc(c.name)}</span>
      <button type="button" class="btn-quiet" data-arch="${c.id}">Unarchive</button>
      <button class="row-del" data-delcat="${c.id}" aria-label="Delete category">&times;</button>
    </div>`).join('') : '')
  $('group-list').innerHTML = [...new Set(liveCats().map(c => c.group_name).filter(Boolean))]
    .map(g => `<option value="${esc(g)}">`).join('')
}

$('cat-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const limit = Number($('c-limit').value) || 0
  const { error } = await sb.from('categories').insert({
    budget_id: state.budgetId,
    name: $('c-name').value.trim(),
    monthly_limit: limit,
    // An amount typed here is a monthly refill target by default (same rule the
    // migration used to seed existing rows); change the kind in the row below.
    target_kind: limit > 0 ? 'monthly' : null,
    group_name: $('c-group').value.trim() || null   // kept between adds, so several go to one group
  })
  if (error) return fail(error)
  $('c-name').value = ''; $('c-limit').value = ''
  await loadMonth(); renderCats(); render()
}

// Save each field as it changes. ponytail: no dirty tracking, no save button.
$('cat-list').onchange = async e => {
  const d = e.target.dataset
  const id = d.name ?? d.limit ?? d.kind ?? d.due ?? d.group ?? d.note
  if (!id) return
  let patch
  if (d.note) patch = { notes: e.target.value.trim() || null }
  else if (d.name) { patch = { name: e.target.value.trim() }; if (patch.name === '') return }
  else if (d.limit) patch = { monthly_limit: Number(e.target.value) || 0 }
  // Changing the kind clears a stale due date when it's no longer a by-date goal,
  // so an old date can't quietly drive the by-date math after a switch away.
  else if (d.kind) patch = { target_kind: e.target.value || null, ...(e.target.value === 'by_date' ? {} : { target_due: null }) }
  else if (d.due) patch = { target_due: e.target.value || null }
  else patch = { group_name: e.target.value.trim() || null }
  const { error } = await sb.from('categories').update(patch).eq('id', id)
  if (error) return fail(error)
  await loadMonth(); renderCats(); render()
}

$('cat-list').onclick = async e => {
  // Reorder. `categories.sort` has existed since v1 and sat at 0 on every row, so
  // re-pack the whole live list to its array index rather than swapping two values
  // — same trick the rules list uses, and it heals the all-zeros legacy state on
  // the first press. Archived rows keep whatever sort they had; unarchiving puts
  // them at the bottom.
  const up = e.target.closest('[data-catup]'), down = e.target.closest('[data-catdown]')
  if (up || down) {
    const id = (up || down).dataset[up ? 'catup' : 'catdown']
    const arr = liveCats()
    const i = arr.findIndex(c => c.id === id), j = i + (up ? -1 : 1)
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    const errs = await Promise.all(arr.map((c, k) => c.sort === k ? null : sb.from('categories').update({ sort: k }).eq('id', c.id)).filter(Boolean))
    const bad = errs.find(r => r?.error)
    if (bad) return fail(bad.error)
    await loadMonth(); renderCats(); render()
    return
  }

  // Archive / unarchive. Archiving a category that still holds money would hide
  // that money rather than free it, so refuse and point at the fix; the move sheet
  // empties an envelope in two taps. Zero available is the only safe state.
  const arch = e.target.closest('[data-arch]')
  if (arch) {
    const id = arch.dataset.arch
    const c = state.cats.find(x => x.id === id)
    if (!c) return
    if (!c.archived) {
      const env = rollNow().cats.get(id)
      if (env && env.available !== 0) {
        return alert(`${c.name} still holds ${money(env.available)}. Move that out first — archiving keeps the money but stops showing the category, so the balance would be invisible.`)
      }
    }
    // Coming back from archived, land at the bottom of the list rather than
    // wherever the old sort put you. Archiving leaves sort alone — writing it back
    // would only risk sending undefined at a not-null column.
    const patch = { archived: !c.archived }
    if (c.archived) patch.sort = state.cats.length ? Math.max(...state.cats.map(x => x.sort ?? 0)) + 1 : 0
    const { error } = await sb.from('categories').update(patch).eq('id', id)
    if (error) return fail(error)
    await loadMonth(); renderCats(); render()
    return
  }

  const b = e.target.closest('[data-delcat]')
  if (!b) return
  // Deleting nulls category_id on this category's past transactions, so their
  // spending falls into uncategorized and comes out of Ready to Assign -- which
  // silently changes past months. A truthful confirm is the fix; we don't block
  // deleting a used category.
  // ponytail: count is from history loaded up to the month on screen, so it can
  // under-report when you're viewing an earlier month. Good enough for a warning.
  const n = state.history.filter(t => t.category_id === b.dataset.delcat).length
  const msg = n
    ? `Delete this category? Its ${n} transaction${n === 1 ? '' : 's'} stay but become uncategorized, which moves that spending into Ready to Assign and changes past months.\n\nArchive instead to retire it with history intact.`
    : 'Delete this category? Nothing is logged in it yet.'
  if (!confirm(msg)) return
  const { error } = await sb.from('categories').delete().eq('id', b.dataset.delcat)
  if (error) return fail(error)
  await loadMonth(); renderCats(); render()
}

// ---------------------------------------------------------------- recurring

$('manage-rec').onclick = () => {
  $('r-cat').innerHTML = catOptions(null)
  syncRecCadence()
  renderRec()
  $('rec-dialog').showModal()
}
$('rec-done').onclick = () => $('rec-dialog').close()

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const cadenceLabel = r =>
  r.cadence === 'weekly'  ? `every ${WEEKDAYS[r.day_of_week] ?? '?'}`
  : r.cadence === 'every_n' ? `every ${r.interval_months} month${r.interval_months === 1 ? '' : 's'}, day ${r.day_of_month}`
  : `monthly, day ${r.day_of_month}`

function renderRec() {
  // Rules with an occurrence still due this month get an "Add now" button, so a
  // single rule can be applied without the all-rules "Add them" banner.
  const pendingIds = new Set(pendingRecurring().map(p => p.rule.id))
  $('rec-list').innerHTML = state.recurring.length ? state.recurring.map(r => `
    <div class="rec-edit">
      <div class="body">
        <div class="desc">${esc(r.description)}</div>
        <div class="small muted">${cadenceLabel(r)} &middot; ${r.kind}${r.auto_apply ? ' &middot; auto' : ''}${r.category_id ? ` &middot; ${esc(state.cats.find(c => c.id === r.category_id)?.name ?? '')}` : ''}</div>
      </div>
      <span class="num ${r.kind === 'income' ? 'txn-in' : ''}">${r.kind === 'income' ? '+' : ''}${money(cents(r.amount))}</span>
      ${pendingIds.has(r.id) ? `<button class="btn-quiet rec-now" data-addrec="${r.id}">Add now</button>` : ''}
      <button class="row-del" data-delrec="${r.id}" aria-label="Delete rule">&times;</button>
    </div>`).join('') : '<div class="empty">No rules yet.</div>'
}

// The day-of-month and weekday inputs are mutually exclusive: weekly uses the
// weekday, the others use the day. Toggle which is visible from the cadence.
function syncRecCadence() {
  const c = $('r-cadence').value
  $('r-day-wrap').hidden = c === 'weekly'
  $('r-dow-wrap').hidden = c !== 'weekly'
  $('r-interval-wrap').hidden = c !== 'every_n'
}

$('r-cadence').onchange = syncRecCadence

$('rec-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const cadence = $('r-cadence').value
  const { error } = await sb.from('recurring').insert({
    budget_id:       state.budgetId,
    kind:            $('r-kind').value,
    amount:          Number($('r-amount').value),
    description:     $('r-desc').value.trim(),
    category_id:     $('r-cat').value || null,
    cadence,
    day_of_month:    Number($('r-day').value) || 1,
    day_of_week:     cadence === 'weekly' ? Number($('r-dow').value) : null,
    interval_months: cadence === 'every_n' ? Number($('r-interval').value) || 1 : 1,
    auto_apply:      $('r-auto').checked
  })
  if (error) return fail(error)
  $('r-desc').value = ''; $('r-amount').value = ''; $('r-day').value = '1'
  $('r-interval').value = '2'; $('r-auto').checked = false
  await loadMonth(); renderRec(); render()
}

$('rec-list').onclick = async e => {
  // Add now: apply just this rule's occurrences due in the month on screen. Same
  // idempotent upsert the "Add them" banner uses, so a double-tap can't double-charge.
  const add = e.target.closest('[data-addrec]')
  if (add) {
    const rows = recurringRows(pendingRecurring().filter(p => p.rule.id === add.dataset.addrec))
    if (!rows.length) return
    const { error } = await sb.from('transactions')
      .upsert(rows, { onConflict: 'recurring_id,occurred_on', ignoreDuplicates: true })
    if (error) return fail(error)
    await loadMonth(); renderRec(); render()
    return
  }
  const b = e.target.closest('[data-delrec]')
  if (!b) return
  if (!confirm('Delete this rule? Transactions it already created stay.')) return
  const { error } = await sb.from('recurring').delete().eq('id', b.dataset.delrec)
  if (error) return fail(error)
  await loadMonth(); renderRec(); render()
}

$('undo-assign').onclick = () => takeUndo()

$('apply-rec').onclick = async () => {
  const rows = recurringRows(pendingRecurring())
  if (!rows.length) return
  // ignoreDuplicates leans on the unique index: if we both press this at the same
  // moment, the loser's rows are skipped rather than charging rent twice.
  const { error } = await sb.from('transactions')
    .upsert(rows, { onConflict: 'recurring_id,occurred_on', ignoreDuplicates: true })
  if (error) return fail(error)
  refresh()
}

// ---------------------------------------------------------------- rules (Phase 3)

const catNameOf = id => state.cats.find(c => c.id === id)?.name ?? ''
let retroChanges = []   // the pending retro-apply change set, between preview and commit

$('manage-rules').onclick = () => {
  $('rule-cat').innerHTML = catOptions(null)
  $('rules-preview').hidden = true
  $('rules-main').hidden = false
  renderRules()
  $('rules-dialog').showModal()
}
$('rules-done').onclick = () => $('rules-dialog').close()

function renderRules() {
  $('rules-list').innerHTML = state.rules.length ? state.rules.map((r, i) => `
    <div class="rec-edit">
      <div class="body">
        <div class="desc">&ldquo;${esc(r.match)}&rdquo;</div>
        <div class="small muted">${r.category_id ? esc(catNameOf(r.category_id)) : 'flag only'}${r.flag ? ` &middot; <span class="flag-dot" style="background:var(--flag-${r.flag})"></span> ${esc(r.flag)}` : ''}</div>
      </div>
      <span class="rule-move">
        <button class="btn-quiet" data-ruleup="${r.id}"${i === 0 ? ' disabled' : ''} aria-label="Raise priority">&uarr;</button>
        <button class="btn-quiet" data-ruledown="${r.id}"${i === state.rules.length - 1 ? ' disabled' : ''} aria-label="Lower priority">&darr;</button>
      </span>
      <button class="row-del" data-delrule="${r.id}" aria-label="Delete rule">&times;</button>
    </div>`).join('') : '<div class="empty">No rules yet. Add one above.</div>'
}

$('rules-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return
  const match = $('r-match').value.trim()
  if (!match) return
  // New rules go to the bottom (lowest priority): max sort + 1.
  const sort = state.rules.length ? Math.max(...state.rules.map(r => r.sort ?? 0)) + 1 : 0
  const { error } = await sb.from('rules').insert({
    budget_id: state.budgetId, match,
    category_id: $('rule-cat').value || null, flag: $('rule-flag').value || null, sort
  })
  if (error) return fail(error)
  $('r-match').value = ''; $('rule-flag').value = ''
  await loadMonth(); renderRules()
}

$('rules-list').onclick = async e => {
  const up = e.target.closest('[data-ruleup]'), down = e.target.closest('[data-ruledown]')
  if (up || down) {
    const id = (up || down).dataset[up ? 'ruleup' : 'ruledown']
    const i = state.rules.findIndex(r => r.id === id), j = i + (up ? -1 : 1)
    if (j < 0 || j >= state.rules.length) return
    const arr = [...state.rules]
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    // Re-pack sort to array index so priority is always distinct + contiguous
    // (older rows may share sort=0). ponytail: rewrite the whole small list, not
    // a minimal swap — a budget has a handful of rules.
    await Promise.all(arr.map((r, k) => r.sort === k ? null : sb.from('rules').update({ sort: k }).eq('id', r.id)).filter(Boolean))
    await loadMonth(); renderRules()
    return
  }
  const del = e.target.closest('[data-delrule]')
  if (!del) return
  if (!confirm('Delete this rule? Transactions it already set stay as they are.')) return
  const { error } = await sb.from('rules').delete().eq('id', del.dataset.delrule)
  if (error) return fail(error)
  await loadMonth(); renderRules()
}

// Retro-apply: preview the changes, commit on confirm. The preview panel swaps in
// over the add-form + list so the whole flow lives in one dialog.
$('rules-retro').onclick = () => {
  if (!state.rules.length) { alert('Add a rule first.'); return }
  retroChanges = retroApply(state.history, state.rules)
  $('rules-preview-list').innerHTML = retroChanges.length
    ? retroChanges.map(ch => `<div class="rec-edit"><div class="body">
        <div class="desc">${esc(ch.description) || '<span class="muted">No description</span>'}</div>
        <div class="small muted">&rarr; ${esc(catNameOf(ch.category_id))}${ch.flag ? ` &middot; <span class="flag-dot" style="background:var(--flag-${ch.flag})"></span> ${esc(ch.flag)}` : ''}</div>
      </div></div>`).join('')
    : '<div class="empty">No uncategorized transactions match a rule.</div>'
  $('rules-preview-count').textContent = retroChanges.length
    ? `${retroChanges.length} transaction${retroChanges.length === 1 ? '' : 's'} will be categorized.`
    : ''
  $('rules-commit').hidden = !retroChanges.length
  $('rules-main').hidden = true
  $('rules-preview').hidden = false
}
$('rules-preview-back').onclick = () => { $('rules-preview').hidden = true; $('rules-main').hidden = false }
$('rules-commit').onclick = async () => {
  if (!retroChanges.length) return
  // One update per row; the set is preview-bounded, so a loop is fine (ponytail:
  // a bulk RPC would be premature for an occasional, handful-of-rows action).
  for (const ch of retroChanges) {
    const { error } = await sb.from('transactions').update({ category_id: ch.category_id, flag: ch.flag }).eq('id', ch.id)
    if (error) return fail(error)
  }
  const n = retroChanges.length
  retroChanges = []
  $('rules-preview').hidden = true; $('rules-main').hidden = false
  await loadMonth(); renderRules(); render()
  alert(`Categorized ${n} transaction${n === 1 ? '' : 's'}.`)
}

// ---------------------------------------------------------------- recurring calendar (Phase 3)

const WEEKDAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
$('manage-cal').onclick = () => { renderCalendar(); $('cal-dialog').showModal() }
$('cal-done').onclick = () => $('cal-dialog').close()

// Month grid of recurring occurrences with paid/pending state. paid = a txn for
// that rule+date already exists this month; pending days are tappable to add-now.
function renderCalendar() {
  const ms = monthStart(state.month)
  const [y, m] = ms.split('-').map(Number)   // m is 1-12
  $('cal-sub').textContent = monthLabel(state.month)
  const paidSet = new Set(state.txns.filter(t => t.recurring_id).map(t => `${t.recurring_id}|${t.occurred_on}`))
  const byDay = new Map()
  for (const r of state.recurring) {
    if (r.active === false) continue
    for (const date of recurringOccurrences(r, ms)) {
      const day = Number(date.slice(8, 10))
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({ paid: paidSet.has(`${r.id}|${date}`) })
    }
  }
  const firstDow = new Date(y, m - 1, 1).getDay()
  const days = new Date(y, m, 0).getDate()
  let cells = WEEKDAY_ABBR.map(d => `<div class="cal-dow">${d}</div>`).join('')
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell is-empty"></div>'
  for (let d = 1; d <= days; d++) {
    const occ = byDay.get(d) || []
    const pending = occ.filter(o => !o.paid).length
    const cls = occ.length ? (pending ? 'has pending' : 'has paid') : ''
    cells += `<button class="cal-cell ${cls}"${pending ? ` data-calday="${d}"` : ' disabled'} aria-label="Day ${d}${occ.length ? `, ${occ.length} recurring${pending ? `, ${pending} to add` : ' (added)'}` : ''}">
      <span class="cal-n">${d}</span>
      ${occ.length ? `<span class="cal-dots">${occ.map(o => `<i class="cal-dot ${o.paid ? 'paid' : 'pending'}"></i>`).join('')}</span>` : ''}
    </button>`
  }
  $('cal-grid').innerHTML = cells
  const totalPending = [...byDay.values()].flat().filter(o => !o.paid).length
  $('cal-foot').textContent = totalPending
    ? `${totalPending} recurring ${totalPending === 1 ? 'item' : 'items'} still to add. Tap a highlighted day to add it.`
    : state.recurring.length ? 'Everything recurring is added for this month.' : 'No recurring rules yet.'
}

$('cal-grid').onclick = async e => {
  const b = e.target.closest('[data-calday]')
  if (!b) return
  const ms = monthStart(state.month)
  const dateStr = `${ms.slice(0, 8)}${String(b.dataset.calday).padStart(2, '0')}`
  const rows = recurringRows(pendingRecurring().filter(p => p.date === dateStr))
  if (!rows.length) return
  const { error } = await sb.from('transactions').upsert(rows, { onConflict: 'recurring_id,occurred_on', ignoreDuplicates: true })
  if (error) return fail(error)
  await loadMonth(); renderCalendar(); render()
}

// ---------------------------------------------------------------- net worth (Phase 4)

const NW_RANGE_KEY = 'budget.nwrange'
const nwRange = () => Number(localStorage.getItem(NW_RANGE_KEY)) || 6

// The N month-starts ending at `ms` (inclusive), oldest first — the trend window.
function monthsBack(ms, n) {
  const out = []
  let m = ms
  for (let i = 0; i < n; i++) { out.unshift(m); m = prevMonthStart(m) }
  return out
}

// The Reflect net worth card: total, assets/liabilities, a per-account breakdown,
// a trend over the chosen range, and an Update-balances entry. Empty-states into an
// "add accounts" prompt until the first account exists.
function renderNetWorth(nw, ms) {
  const el = $('reflect-networth')
  if (!el) return
  if (!state.accounts.length) {
    el.innerHTML = `<div class="card nw-card">
      <div class="nw-head"><span class="small muted-strong">Net worth</span></div>
      <p class="small muted" style="margin:6px 0 12px">Track what you own minus what you owe — type in balances by hand, no bank connection.</p>
      <button class="btn-quiet" id="nw-balances">Add accounts</button>
    </div>`
    return
  }
  const netK = nw.net > 0 ? 'home-rta-ok' : nw.net < 0 ? 'home-rta-over' : ''
  const n = nwRange()
  const series = netWorthSeries(state.accounts, state.snapshots, monthsBack(ms, n))
  const maxAbs = Math.max(1, ...series.map(p => Math.abs(p.net)))
  const bars = series.map(p => `<div class="nw-bar${p.month === ms ? ' is-current' : ''}" title="${esc(monthLabel(new Date(p.month + 'T00:00')))}: ${money(p.net)}">
      <i class="${p.net < 0 ? 'neg' : ''}" style="height:${Math.round(Math.abs(p.net) / maxAbs * 100)}%"></i>
    </div>`).join('')
  const rows = nw.rows.map(r => `<div class="nw-row">
      <span class="nw-name">${esc(r.name)}${r.stale ? ' <span class="nw-stale">stale</span>' : ''}</span>
      <span class="nw-kind ${r.kind}">${r.kind}</span>
      <span class="num${r.kind === 'liability' ? ' nw-neg' : ''}">${r.kind === 'liability' ? '&minus;' : ''}${money(r.balance)}</span>
    </div>`).join('')
  el.innerHTML = `<div class="card nw-card">
    <div class="nw-head">
      <span class="small muted-strong">Net worth &middot; ${esc(monthLabel(state.month))}</span>
      <select id="nw-range" class="nw-range" aria-label="Trend range">${[6, 12, 24].map(v => `<option value="${v}"${v === n ? ' selected' : ''}>${v}m</option>`).join('')}</select>
    </div>
    <b class="nw-total num ${netK}">${money(nw.net)}</b>
    <div class="small muted" style="margin-bottom:12px">Assets ${money(nw.assets)} &middot; Liabilities ${money(nw.liabilities)}</div>
    <div class="nw-bars">${bars}</div>
    <div class="nw-rows">${rows}</div>
    <button class="btn-quiet" id="nw-balances">Update balances</button>
  </div>`
}

// Card buttons are re-rendered each pass, so delegate off the static container.
$('reflect-networth').onclick = e => { if (e.target.closest('#nw-balances')) openBalances() }
$('reflect-networth').onchange = e => {
  if (e.target.id === 'nw-range') { localStorage.setItem(NW_RANGE_KEY, e.target.value); render() }
}

function openBalances() {
  $('acct-kind').value = 'asset'; $('acct-name').value = ''
  renderBalances()
  $('balances-dialog').showModal()
}
$('bal-done').onclick = () => $('balances-dialog').close()

function renderBalances() {
  const ms = monthStart(state.month)
  $('bal-sub').textContent = `Balances for ${monthLabel(state.month)}`
  const live = state.accounts.filter(a => !a.archived)
  $('bal-list').innerHTML = live.length ? live.map(a => {
    const here = state.snapshots.find(s => s.account_id === a.id && s.month === ms)
    // carried-forward (latest ≤ ms) drives the placeholder so you can see the last
    // known figure without it counting as this month's entry.
    const carried = netWorthAt([a], state.snapshots, ms).rows[0]
    return `<div class="bal-row">
      <span class="bal-name">${esc(a.name)} <span class="nw-kind ${a.kind}">${a.kind}</span></span>
      <input class="num bal-input" type="text" inputmode="decimal" data-bal="${a.id}"
             value="${here ? (here.balance_cents / 100).toFixed(2) : ''}"
             placeholder="${carried ? (carried.balance / 100).toFixed(2) : '0.00'}" aria-label="Balance for ${esc(a.name)}">
      <button class="row-del" data-archive="${a.id}" aria-label="Archive ${esc(a.name)}">&times;</button>
    </div>`
  }).join('') : '<div class="empty">No accounts yet. Add one below.</div>'
}

$('acct-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return
  const name = $('acct-name').value.trim()
  if (!name) return
  const sort = state.accounts.length ? Math.max(...state.accounts.map(a => a.sort ?? 0)) + 1 : 0
  const { error } = await sb.from('accounts').insert({ budget_id: state.budgetId, name, kind: $('acct-kind').value, sort })
  if (error) return fail(error)
  $('acct-name').value = ''
  await loadMonth(); renderBalances()
}

$('bal-save').onclick = async () => {
  const ms = monthStart(state.month)
  const rows = []
  for (const inp of document.querySelectorAll('[data-bal]')) {
    const v = inp.value.trim()
    if (v === '') continue                       // blank = leave the month as-is
    const val = evalAmount(v)
    if (val == null) return alert(`"${inp.value}" isn't a number.`)
    rows.push({ account_id: inp.dataset.bal, budget_id: state.budgetId, month: ms, balance_cents: cents(val) })
  }
  if (rows.length) {
    const { error } = await sb.from('balance_snapshots').upsert(rows, { onConflict: 'account_id,month' })
    if (error) return fail(error)
  }
  await loadMonth(); renderBalances(); render()
}

$('bal-list').onclick = async e => {
  const b = e.target.closest('[data-archive]')
  if (!b) return
  if (!confirm('Archive this account? Its balance history is kept, but it drops out of net worth.')) return
  const { error } = await sb.from('accounts').update({ archived: true }).eq('id', b.dataset.archive)
  if (error) return fail(error)
  await loadMonth(); renderBalances(); render()
}

// ---------------------------------------------------------------- money moves

// The assignment trail, loaded lazily when opened rather than on every month load
// -- it's history you go looking for, not something the budget view needs. Newest
// first, capped: a read-only record, no editing, matching the append-only table.
$('manage-moves').onclick = async () => {
  const { data, error } = await sb.from('money_moves').select('*')
    .eq('budget_id', state.budgetId).order('moved_at', { ascending: false }).limit(100)
  if (error) return fail(error)
  renderMoves(data ?? [])
  $('moves-dialog').showModal()
}
$('moves-done').onclick = () => $('moves-dialog').close()

function renderMoves(moves) {
  const dir = (from, to) => Number(to) >= Number(from) ? 'move-up' : 'move-down'
  $('moves-list').innerHTML = moves.length ? moves.map(m => `
    <div class="rec-edit">
      <div class="body">
        <div class="desc">${esc(state.cats.find(c => c.id === m.category_id)?.name ?? 'Uncategorized')}</div>
        <div class="small muted">${monthLabel(new Date(m.month + 'T00:00'))} &middot; ${new Date(m.moved_at).toLocaleDateString('en-CA')}</div>
      </div>
      <span class="num small ${dir(m.from_amount, m.to_amount)}">${money(cents(m.from_amount))} &rarr; ${money(cents(m.to_amount))}</span>
    </div>`).join('') : '<div class="empty">No assignment changes logged yet.</div>'
}

// ---------------------------------------------------------------- bulk actions

// Multi-select over the month's transactions, then categorize / flag / delete the
// lot in one round-trip. Selection lives in state.sel; render() draws the check
// column and the bar from it. Leaving select mode always clears the selection so
// a stale pick can't act on the next month.
function setSelMode(on) {
  state.selMode = on
  state.sel.clear()
  render()
}
$('sel-toggle').onclick = () => setSelMode(!state.selMode)

$('bulk-bar').onclick = e => {
  const act = e.target.closest('[data-bulk]')?.dataset.bulk
  if (!act) return
  if (act === 'cancel') return setSelMode(false)
  if (!state.sel.size) return
  if (act === 'delete') return bulkDelete()
  // categorize / flag both collect a value in the one bulk sheet.
  $('bulk-title').textContent = act === 'cat' ? 'Categorize selected' : 'Flag selected'
  $('bulk-cat-field').hidden = act !== 'cat'
  $('bulk-flag-field').hidden = act !== 'flag'
  if (act === 'cat') $('bulk-cat').innerHTML = catOptions(null)
  $('bulk-dialog').dataset.act = act
  $('bulk-dialog').showModal()
}

async function bulkDelete() {
  const ids = [...state.sel]
  if (!confirm(`Delete ${ids.length} transaction${ids.length === 1 ? '' : 's'}? This can't be undone.`)) return
  const { error } = await sb.from('transactions').delete().in('id', ids)
  if (error) return fail(error)
  setSelMode(false); refresh()
}

$('bulk-apply').onclick = async () => {
  const act = $('bulk-dialog').dataset.act
  const ids = [...state.sel]
  const patch = act === 'cat'
    ? { category_id: $('bulk-cat').value || null }
    : { flag: $('bulk-flag').value || null }
  const { error } = await sb.from('transactions').update(patch).in('id', ids)
  if (error) return fail(error)
  $('bulk-dialog').close(); setSelMode(false); refresh()
}
$('bulk-cancel').onclick = () => $('bulk-dialog').close()

// ---------------------------------------------------------------- preview

// ?preview — a dev harness like ?selftest, for working on the UI logged out.
// It pushes fixture rows through the REAL pipeline (state -> rollup() ->
// render()), one of each Available state, so every kit component can be seen
// without touching live data. Look, don't touch: writes still go to Supabase
// and will fail without a session. Never linked from the UI.
// ponytail: fixtures are relative to the current month so the screen is never
// stale; ids are pv-* so a stray write cannot collide with real rows.
const PREVIEW = new URLSearchParams(location.search).has('preview')
function previewSeed() {
  const ms = monthStart(state.month)
  const d = n => `${ms.slice(0, 8)}${String(n).padStart(2, '0')}`
  const plus2 = new Date(state.month.getFullYear(), state.month.getMonth() + 2, 1)
  const due = `${monthKey(plus2)}-15`
  state.budgets = [{ id: 'pv-ours', name: 'Ours' }, { id: 'pv-mine', name: 'Mine' }]
  state.budgetId = 'pv-ours'
  state.cats = [
    { id: 'pv-rent', name: 'Rent',       group_name: 'Fixed',    monthly_limit: 1800, target_kind: 'monthly' },
    { id: 'pv-hyd',  name: 'Hydro',      group_name: 'Fixed',    monthly_limit: 90,   target_kind: 'monthly' },
    { id: 'pv-groc', name: 'Groceries',  group_name: 'Everyday', monthly_limit: 0,    target_kind: null },
    { id: 'pv-dine', name: 'Dining out', group_name: 'Everyday', monthly_limit: 0,    target_kind: null },
    { id: 'pv-fun',  name: 'Fun money',  group_name: 'Everyday', monthly_limit: 0,    target_kind: null },
    { id: 'pv-trip', name: 'Road trip',  group_name: 'Savings',  monthly_limit: 1200, target_kind: 'by_date', target_due: due, notes: 'East coast, two weeks in September.' },
    // Phase 6: an archived category that still owns a past transaction. It must
    // stay out of the plan and the pickers while its spending stays inside the
    // reports and out of Ready to Assign.
    { id: 'pv-gym',  name: 'Old gym',    group_name: 'Everyday', monthly_limit: 0,    target_kind: null, archived: true }
  ]
  state.assigns = [
    { category_id: 'pv-rent', month: ms, amount: 1800 },
    { category_id: 'pv-hyd',  month: ms, amount: 90 },
    { category_id: 'pv-groc', month: ms, amount: 400 },
    { category_id: 'pv-dine', month: ms, amount: 60 },
    { category_id: 'pv-trip', month: ms, amount: 200 },
    { category_id: 'pv-gym',  month: ms, amount: 45 }   // archived, and emptied by its own spending
  ]
  state.snoozed = new Set(['pv-trip'])   // a snoozed by-date target: amber → Snoozed
  state.history = [
    { id: 'pv-t1', category_id: null,      kind: 'income',  amount: 3200,  description: 'Paycheque',      occurred_on: d(1) },
    { id: 'pv-t2', category_id: 'pv-rent', kind: 'expense', amount: 1800,  description: 'Rent',           occurred_on: d(1), recurring_id: 'pv-r1' },
    { id: 'pv-t3', category_id: 'pv-groc', kind: 'expense', amount: 92.4,  description: 'Metro',          occurred_on: d(3), flag: 'green', memo: 'weekly shop' },
    { id: 'pv-t0', category_id: 'pv-gym',  kind: 'expense', amount: 45,    description: 'Gym (cancelled)', occurred_on: d(2) },
    { id: 'pv-t4', category_id: 'pv-dine', kind: 'expense', amount: 45.25, description: 'Ramen night',    occurred_on: d(6) },
    { id: 'pv-t5', category_id: 'pv-groc', kind: 'expense', amount: 78.1,  description: 'Costco run',     occurred_on: d(9) },
    { id: 'pv-t6', category_id: 'pv-dine', kind: 'expense', amount: 52,    description: 'Pizza',          occurred_on: d(11), flag: 'red' },
    // A split: parent (no category) + two children carrying the categories.
    { id: 'pv-t7', category_id: null,      kind: 'expense', amount: 60,    description: 'Pharmacy + snacks', occurred_on: d(12) },
    { id: 'pv-t7a', parent_id: 'pv-t7', category_id: 'pv-groc', kind: 'expense', amount: 38, description: 'Pharmacy + snacks', occurred_on: d(12) },
    { id: 'pv-t7b', parent_id: 'pv-t7', category_id: 'pv-fun',  kind: 'expense', amount: 22, description: 'Pharmacy + snacks', occurred_on: d(12) },
    // An uncategorized expense a rule ("amazon") will catch on retro-apply.
    { id: 'pv-t8', category_id: null,   kind: 'expense', amount: 24.99, description: 'Amazon order',   occurred_on: d(14) }
  ].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))
  state.txns = state.history.filter(t => t.occurred_on >= ms)
  state.recurring = [{ id: 'pv-r1', description: 'Rent', amount: 1800, kind: 'expense', cadence: 'monthly',
                       day_of_month: 1, category_id: 'pv-rent', active: true, auto_apply: false },
                     { id: 'pv-r2', description: 'Internet', amount: 65, kind: 'expense', cadence: 'monthly',
                       day_of_month: 20, category_id: 'pv-hyd', active: true, auto_apply: false }]
  state.rules = [
    { id: 'pv-rule1', match: 'metro',  category_id: 'pv-groc', flag: 'green', sort: 0 },
    { id: 'pv-rule2', match: 'amazon', category_id: 'pv-fun',  flag: null,    sort: 1 }
  ]
  // Net worth fixtures: two assets + a liability, a few months of snapshots. Visa
  // has no entry this month, so it carries forward and reads stale.
  const pm = prevMonthStart(ms), pm2 = prevMonthStart(pm)
  state.accounts = [
    { id: 'pv-chk',  name: 'Checking', kind: 'asset',     sort: 0, archived: false },
    { id: 'pv-sav',  name: 'Savings',  kind: 'asset',     sort: 1, archived: false },
    { id: 'pv-visa', name: 'Visa',     kind: 'liability', sort: 2, archived: false }
  ]
  state.snapshots = [
    { account_id: 'pv-chk',  month: pm2, balance_cents: 300000 },
    { account_id: 'pv-chk',  month: pm,  balance_cents: 320000 },
    { account_id: 'pv-chk',  month: ms,  balance_cents: 350000 },
    { account_id: 'pv-sav',  month: pm2, balance_cents: 800000 },
    { account_id: 'pv-sav',  month: ms,  balance_cents: 850000 },
    { account_id: 'pv-visa', month: pm,  balance_cents: 120000 }
  ]
  $('login').hidden = true
  $('app').hidden = false
  $('add-btn').hidden = false
  render()
}
