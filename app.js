import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// Safe to commit and ship to the browser: the publishable key is public by
// design and RLS is what protects the data. The sb_secret_ key never goes here.
const SUPABASE_URL = 'https://aeqydektxshybtyjkekp.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable__AX_N4UOwp4mBBXIe_ynRQ_D616UKp6'

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ---------------------------------------------------------------- money

// Integer cents everywhere. Summing 2dp floats drifts (0.1+0.2 = 0.30000000000000004);
// summing cents doesn't. Only convert back at render.
const cents = n => Math.round(Number(n) * 100)
const money = c => (c / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })

// ---------------------------------------------------------------- dates

const monthKey   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const monthStart = d => `${monthKey(d)}-01`
const monthEnd   = d => `${monthKey(d)}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0')}`
const monthLabel = d => d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
const today      = () => { const d = new Date(); return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}` }

// Where a "31st of the month" rule lands in February. Clamping to the last day
// keeps the date deterministic per rule per month, which is exactly what the
// unique index on (recurring_id, occurred_on) relies on to stop double-charging.
const recurringDate = (d, day) => {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  return `${monthKey(d)}-${String(Math.min(day, last)).padStart(2, '0')}`
}

// Previous month's 1st, for the "last month" auto-assign modes.
const prevMonthStart = ms => { const d = new Date(ms + 'T00:00'); d.setMonth(d.getMonth() - 1); return monthStart(d) }

// A category's expenses within [from, to] inclusive, in cents. The date window is
// the only thing here that can be quietly wrong, so it carries a selftest.
const sumSpentInRange = (history, id, from, to) =>
  history.filter(t => t.category_id === id && t.kind === 'expense' && t.occurred_on >= from && t.occurred_on <= to)
         .reduce((s, t) => s + cents(t.amount), 0)

// ---------------------------------------------------------------- envelope

// YNAB colours Available and nothing else: red means the envelope is in the
// hole, green means it holds money, gray means it has never been touched. Amber
// is the one state we spell differently -- YNAB's means "target not met", ours
// means "funded and spent to exactly zero", because there is no targets engine.
function envStatus(availC, assignedC, activityC) {
  if (availC < 0) return 'over'
  if (availC > 0) return 'ok'
  return assignedC === 0 && activityC === 0 ? 'none' : 'close'
}

// The whole model. A category keeps what it doesn't spend, and that one rule is
// why none of these numbers can be read off a single month: Available is a
// running total from the first transaction up to the month on screen. So
// `history` and `assigns` must arrive already cut off at "on or before this
// month" -- a future transaction leaking in would spend money this month hasn't
// been given yet.
//
//   assigned  = what you gave this category in the month `ms`
//   activity  = what happened to it in `ms` (negative = spent)
//   available = every assignment + every activity, all months, cumulative
//
// Ready to Assign is money that has arrived and hasn't been given a job:
//   income with no category         -- a paycheque is new money
//   minus everything ever assigned  -- money that now has a job
//   minus expenses with no category -- money that left without ever getting one
//
// That last line is ours, not YNAB's: YNAB refuses to let an uncategorized
// expense exist, we allow it, so it has to come out of the pot somewhere or
// Ready to Assign would keep offering money that is already gone. Income filed
// UNDER a category is the mirror image -- a refund, which refills that one
// envelope and never touches Ready to Assign.
//
// ponytail: a negative Available rolls forward as a negative. YNAB instead
// resets the category to zero and docks next month's Ready to Assign. Ours
// leaves the hole visible in the category that dug it, which is one cumulative
// sum instead of a month-by-month walk. Ceiling: if YNAB's exact overspending
// behaviour is ever wanted, this is the function to rewrite.
function rollup(cats, assigns, history, ms) {
  const acc = new Map(cats.map(c => [c.id, { assigned: 0, activity: 0, available: 0, spent: 0 }]))
  let assignedAll = 0
  let incomeAll = 0
  let unassignedSpend = 0

  for (const a of assigns) {
    const e = acc.get(a.category_id)
    if (!e) continue
    const amt = cents(a.amount)
    assignedAll += amt
    e.available += amt
    if (a.month === ms) e.assigned = amt
  }

  for (const t of history) {
    const amt = cents(t.amount)
    if (!t.category_id) {
      if (t.kind === 'income') incomeAll += amt
      else unassignedSpend += amt
      continue
    }
    const e = acc.get(t.category_id)
    if (!e) continue
    const signed = t.kind === 'income' ? amt : -amt
    e.available += signed
    if (t.occurred_on >= ms) {
      e.activity += signed
      if (t.kind === 'expense') e.spent += amt
    }
  }

  return { cats: acc, rta: incomeAll - unassignedSpend - assignedAll }
}

// ---------------------------------------------------------------- self-check
// Load with ?selftest to run. Money and month-end are the only logic here that
// can be quietly wrong, so they're the only things checked.

if (location.search.includes('selftest')) {
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`) }
  eq([0.1, 0.2, 0.3].reduce((s, n) => s + cents(n), 0), 60, 'cents sum exactly')
  eq(cents(19.99), 1999, 'cents rounds')
  eq(monthEnd(new Date(2026, 1, 1)), '2026-02-28', 'february')
  eq(monthEnd(new Date(2024, 1, 1)), '2024-02-29', 'leap february')
  eq(monthStart(new Date(2026, 6, 15)), '2026-07-01', 'month start ignores day')
  eq(recurringDate(new Date(2026, 6, 1), 15), '2026-07-15', 'normal day passes through')
  eq(recurringDate(new Date(2026, 1, 1), 31), '2026-02-28', 'day 31 clamps to Feb 28')
  eq(recurringDate(new Date(2024, 1, 1), 31), '2024-02-29', 'day 31 clamps to leap Feb')
  eq(recurringDate(new Date(2026, 3, 1), 31), '2026-04-30', 'day 31 clamps to Apr 30')

  eq(prevMonthStart('2026-07-01'), '2026-06-01', 'previous month')
  eq(prevMonthStart('2026-01-01'), '2025-12-01', 'previous month crosses the year')
  const SP = [
    { category_id: 'g', kind: 'expense', amount: 10, occurred_on: '2026-06-15' },
    { category_id: 'g', kind: 'expense', amount: 5,  occurred_on: '2026-07-02' },
    { category_id: 'g', kind: 'income',  amount: 3,  occurred_on: '2026-06-20' },
    { category_id: 'f', kind: 'expense', amount: 9,  occurred_on: '2026-06-10' }
  ]
  eq(sumSpentInRange(SP, 'g', '2026-06-01', '2026-06-30'), 1000, 'last-month spend: only that category, that month, expenses only')

  eq(envStatus(-1, 0, 0), 'over', 'a cent in the hole is in the hole')
  eq(envStatus(5000, 30000, -25000), 'ok', 'money left')
  eq(envStatus(0, 30000, -30000), 'close', 'funded and spent to zero')
  eq(envStatus(0, 0, 0), 'none', 'never touched')

  // The envelope rollup gets checked from both ends -- the month the money was
  // assigned, and a later month it has to roll into. Everything below is the
  // same $1000 paycheque and $300 of groceries seen from different months.
  const CATS  = [{ id: 'g' }, { id: 'f' }]
  const JULY  = [
    { category_id: null, kind: 'income',  amount: 1000, occurred_on: '2026-07-01' },
    { category_id: 'g',  kind: 'expense', amount: 250,  occurred_on: '2026-07-06' }
  ]
  const A300  = [{ category_id: 'g', month: '2026-07-01', amount: 300 }]
  const REFUND = [...JULY, { category_id: 'g', kind: 'income', amount: 20, occurred_on: '2026-07-08' }]

  const jul = rollup(CATS, A300, JULY, '2026-07-01')
  eq(jul.rta, 70000, 'ready to assign = income - assigned')
  eq(jul.cats.get('g').assigned, 30000, 'assigned reads the month on screen')
  eq(jul.cats.get('g').activity, -25000, 'spending is negative activity')
  eq(jul.cats.get('g').available, 5000, 'available = assigned - spent')
  eq(jul.cats.get('f').available, 0, 'an untouched category is empty, not broken')

  const aug = rollup(CATS, A300, JULY, '2026-08-01')
  eq(aug.cats.get('g').available, 5000, 'unspent money rolls into next month')
  eq(aug.cats.get('g').assigned, 0, "last month's assignment is not this month's")
  eq(aug.cats.get('g').activity, 0, "last month's spending is not this month's")
  eq(aug.rta, 70000, 'ready to assign carries forward')

  eq(rollup(CATS, A300, REFUND, '2026-07-01').rta, 70000, 'a refund is not new money to assign')
  eq(rollup(CATS, A300, REFUND, '2026-07-01').cats.get('g').available, 7000, 'a refund refills its own envelope')

  eq(rollup(CATS, A300, [...JULY, { category_id: 'g', kind: 'expense', amount: 100, occurred_on: '2026-07-09' }], '2026-07-01')
    .cats.get('g').available, -5000, 'overspending an envelope goes negative')

  eq(rollup(CATS, [], [{ category_id: null, kind: 'income',  amount: 100, occurred_on: '2026-07-01' },
                       { category_id: null, kind: 'expense', amount: 40,  occurred_on: '2026-07-02' }], '2026-07-01')
    .rta, 6000, 'uncategorized spending comes out of ready to assign')

  console.log('selftest ok')
}

// ---------------------------------------------------------------- state

// txns is the month on screen (the list). history is everything up to the end of
// it (the rollup) -- two views of one fetch, because Available rolls forward.
const state = { budgets: [], budgetId: null, month: new Date(), cats: [], txns: [], history: [], assigns: [], recurring: [], editing: null }
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))

// ---------------------------------------------------------------- data

async function loadBudgets() {
  const { data, error } = await sb.from('budgets').select('id,name').order('name')
  if (error) return fail(error)
  state.budgets = data ?? []
  if (!state.budgets.some(b => b.id === state.budgetId)) state.budgetId = state.budgets[0]?.id ?? null
}

async function loadMonth() {
  if (!state.budgetId) { state.cats = []; state.txns = []; state.history = []; state.assigns = []; state.recurring = []; return }
  const ms = monthStart(state.month)
  const [c, t, r, a] = await Promise.all([
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
      .lte('month', ms)
  ])
  if (c.error) return fail(c.error)
  if (t.error) return fail(t.error)
  if (r.error) return fail(r.error)
  if (a.error) return fail(a.error)
  state.cats = c.data ?? []
  state.history = t.data ?? []
  state.txns = state.history.filter(x => x.occurred_on >= ms)
  state.recurring = r.data ?? []
  state.assigns = a.data ?? []
}

// Rules with no transaction yet in the month on screen.
const pendingRecurring = () => {
  const applied = new Set(state.txns.map(t => t.recurring_id).filter(Boolean))
  return state.recurring.filter(r => !applied.has(r.id))
}

const fail = e => { console.error(e); alert(e.message ?? String(e)) }

// ---------------------------------------------------------------- render

const sumKind = k => state.txns.filter(t => t.kind === k).reduce((s, t) => s + cents(t.amount), 0)

// Categories still sitting at zero that have a target to fill. Untouched only:
// overwriting a number someone typed on purpose is not a convenience.
const unfilledCats = roll =>
  state.cats.filter(c => cents(c.monthly_limit) > 0 && (roll.cats.get(c.id)?.assigned ?? 0) === 0)

// Auto-assign modes. Amounts stay in cents until the last step to dodge float
// drift, then convert to dollars for assign(). Every mode derives from data we
// already hold: assigns (every month up to this one) and history (every txn up
// to this month's end), so "last month" is always in hand.
function autoAssignRows(mode, roll) {
  const ms = monthStart(state.month)
  const prev = prevMonthStart(ms)
  const prevEnd = monthEnd(new Date(prev + 'T00:00'))
  const row = (c, amount) => ({ budget_id: state.budgetId, category_id: c.id, month: ms, amount })
  const lastAssigned = id =>
    state.assigns.filter(a => a.category_id === id && a.month === prev).reduce((s, a) => s + cents(a.amount), 0) / 100
  switch (mode) {
    case 'target': return unfilledCats(roll).map(c => row(c, c.monthly_limit))
    case 'last':   return state.cats.map(c => row(c, lastAssigned(c.id))).filter(r => r.amount > 0)
    case 'spent':  return state.cats.map(c => row(c, sumSpentInRange(state.history, c.id, prev, prevEnd) / 100)).filter(r => r.amount > 0)
    case 'reset':  return state.cats.map(c => row(c, 0))
    default: return []
  }
}

function render() {
  $('month-label').textContent = monthLabel(state.month)

  // No "New budget…" option in here. With zero budgets it would be the only
  // option and therefore already selected, so picking it fires no change event
  // and nothing happens -- broken in exactly the case you need it. Creating is
  // a button.
  $('budget-switch').innerHTML = state.budgets
    .map(b => `<option value="${b.id}" ${b.id === state.budgetId ? 'selected' : ''}>${esc(b.name)}</option>`)
    .join('')

  const has = !!state.budgetId
  $('no-budget').hidden = has
  $('budget-view').hidden = !has
  $('budget-switch').hidden = !has
  $('rename-budget').hidden = !has
  $('add-btn').hidden = !has
  if (!has) return

  const roll = rollup(state.cats, state.assigns, state.history, monthStart(state.month))
  const totalSpent = sumKind('expense')
  const assignedNow = state.cats.reduce((s, c) => s + (roll.cats.get(c.id)?.assigned ?? 0), 0)
  const rtaK = roll.rta < 0 ? 'over' : roll.rta > 0 ? 'ok' : 'none'

  // Ready to Assign is the hero, because counting it down to zero is the whole
  // method. Spent used to lead here; spent is a fact about the past, and this
  // number is a decision waiting to be made.
  $('summary').innerHTML = `
    <div class="rta">
      <div>
        <div class="small muted">Ready to Assign</div>
        <div class="amt num rta-${rtaK}">${money(roll.rta)}</div>
        <div class="small muted">${
          roll.rta < 0 ? 'More assigned than you have. Take some back.'
          : roll.rta > 0 ? 'Give every dollar a job.'
          : 'Every dollar has a job.'}</div>
      </div>
      ${state.cats.length ? '<button class="btn-quiet" id="auto-assign">Auto-assign</button>' : ''}
    </div>
    <div class="net">
      <span class="num">Assigned ${money(assignedNow)}</span>
      <span class="num">Spent ${money(totalSpent)}</span>
    </div>`

  const pend = pendingRecurring()
  $('rec-banner').hidden = !pend.length
  if (pend.length) {
    $('rec-banner-text').textContent =
      `${pend.length} recurring ${pend.length === 1 ? 'item' : 'items'} not added for ${monthLabel(state.month)}.`
  }

  $('cat-count').textContent = state.cats.length ? `${state.cats.length}` : ''
  // The pill is Available (this month plus everything that rolled in) and carries
  // the colour. The bar is only this month's pace -- spent against what you
  // assigned this month -- so it stays neutral on purpose: an envelope can be
  // over its monthly assignment and still green because last month covered it,
  // and a red bar next to a green pill reads as a bug.
  const catRow = c => {
    const e = roll.cats.get(c.id)
    const k = envStatus(e.available, e.assigned, e.activity)
    return `<div class="row">
      <div class="cat-top">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="pill s-${k}">${e.available < 0 ? `${money(-e.available)} over` : `${money(e.available)} left`}</span>
      </div>
      <div class="assign-row">
        <label for="a-${c.id}">Assigned</label>
        <input class="assign num" id="a-${c.id}" type="number" step="0.01" inputmode="decimal"
               value="${(e.assigned / 100).toFixed(2)}" data-assign="${c.id}">
        <span class="small muted num">${e.spent ? `${money(e.spent)} spent` : 'nothing spent'}</span>
      </div>
      <div class="bar"><i class="f-neutral" style="width:${e.assigned > 0 ? Math.min(100, e.spent / e.assigned * 100) : 0}%"></i></div>
    </div>`
  }
  // Group by group_name. Ungrouped ('') renders first with no header; named
  // groups follow alphabetically, each with a header carrying the group's total
  // Available. ponytail: a group is just the label string (schema-v4), so this is
  // presentation only -- rollup() never sees a group.
  const groups = new Map()
  for (const c of state.cats) {
    const g = c.group_name || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(c)
  }
  const order = [...groups.keys()].sort((a, b) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))
  $('categories').innerHTML = state.cats.length
    ? order.map(g => {
        const cats = groups.get(g)
        const head = g
          ? `<div class="group-head"><span>${esc(g)}</span><span class="num small">${money(cats.reduce((s, c) => s + (roll.cats.get(c.id)?.available ?? 0), 0))}</span></div>`
          : ''
        return head + cats.map(catRow).join('')
      }).join('')
    : '<div class="empty">No categories yet. Add some, then give each one a job.</div>'

  $('txn-count').textContent = state.txns.length ? `${state.txns.length}` : ''
  const catName = id => state.cats.find(c => c.id === id)?.name ?? 'Uncategorized'
  $('transactions').innerHTML = state.txns.length ? state.txns.map(t => `
    <div class="row txn">
      ${t.flag ? `<span class="flag-dot" style="background:var(--flag-${t.flag})" title="Flag: ${t.flag}"></span>` : ''}
      <div class="body" data-edit="${t.id}" style="cursor:pointer">
        <div class="desc">${esc(t.description) || '<span class="muted">No description</span>'}</div>
        <div class="small muted">${t.occurred_on} &middot; ${esc(catName(t.category_id))}${t.recurring_id ? ' &middot; recurring' : ''}</div>
      </div>
      <span class="num ${t.kind === 'income' ? 'income-amt' : ''}">${t.kind === 'income' ? '+' : ''}${money(cents(t.amount))}</span>
      <button class="del" data-del="${t.id}" aria-label="Delete transaction">&times;</button>
    </div>`).join('') : '<div class="empty">Nothing logged this month.</div>'
}

async function refresh() { await loadMonth(); render() }

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
  if (!on) return
  await loadBudgets()
  await refresh()
})

// ---------------------------------------------------------------- events

$('prev').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); refresh() }
$('next').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); refresh() }

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
  b.setAttribute('aria-pressed', String(on))
  b.textContent = on ? '\u{1F648}' : '\u{1F441}'   // see-no-evil / eye
  b.title = on ? 'Show amounts' : 'Hide amounts'
  b.setAttribute('aria-label', b.title)
}
$('hide-amounts').onclick = () => {
  const on = !document.body.classList.contains('amounts-hidden')
  localStorage.setItem(HIDE_KEY, on ? '1' : '')
  applyHide(on)
}
applyHide(localStorage.getItem(HIDE_KEY) === '1')

$('budget-switch').onchange = async e => {
  state.budgetId = e.target.value
  await refresh()
}

async function newBudget() {
  const name = prompt('Budget name')  // ponytail: native prompt. Run twice, ever.
  if (!name?.trim()) return
  const { error } = await sb.from('budgets').insert({ name: name.trim() })
  if (error) return fail(error)
  await loadBudgets()   // a trigger makes the creator a member, so it comes back
  await refresh()
}

$('new-budget').onclick = newBudget
$('first-budget').onclick = newBudget

// Rename the selected budget. Native prompt, like newBudget -- two people, done
// rarely. This is also the fix for two budgets sharing a name: rename one so the
// switcher can tell them apart. The 1-60 length rule lives on the column, so a
// bad length surfaces through fail() instead of being re-implemented here.
$('rename-budget').onclick = async () => {
  const b = state.budgets.find(x => x.id === state.budgetId)
  if (!b) return
  const name = prompt('Rename budget', b.name)
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
  // Typing the name, not a confirm(). This cascades to every category,
  // transaction, assignment and rule in the budget, and a confirm() is one
  // thumb-slip on a phone away from wiping a year of data with no undo.
  const typed = prompt(`Delete "${b.name}" and everything in it — categories, transactions, recurring rules — permanently?\n\nType the budget name to confirm:`)
  if (typed === null) return
  if (typed.trim() !== b.name) return alert('That name did not match. Nothing was deleted.')
  const { error } = await sb.from('budgets').delete().eq('id', b.id)
  if (error) return fail(error)
  state.budgetId = null   // loadBudgets falls back to whatever is left
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
  const head = ['date', 'description', 'category', 'type', 'amount', 'flag']
  const body = state.txns.map(t =>
    [t.occurred_on, t.description, catName(t.category_id), t.kind, Number(t.amount).toFixed(2), t.flag ?? ''].map(cell).join(','))
  const csv = [head.join(','), ...body].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = `budget-${monthKey(state.month)}.csv`; a.click()
  URL.revokeObjectURL(url)
}

$('transactions').onclick = async e => {
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

// ---------------------------------------------------------------- assigning

// Upsert, not update: the row for (category, month) doesn't exist until someone
// assigns something, and "assigned nothing" and "never assigned" spend the same.
async function assign(rows) {
  if (!rows.length) return
  const { error } = await sb.from('assignments').upsert(rows, { onConflict: 'category_id,month' })
  if (error) return fail(error)
  refresh()
}

$('categories').onchange = e => {
  const id = e.target.dataset.assign
  if (!id) return
  assign([{
    budget_id:   state.budgetId,
    category_id: id,
    month:       monthStart(state.month),
    amount:      Number(e.target.value) || 0
  }])
}

// The summary's Auto-assign button opens the modes sheet. The rollup is rebuilt
// per action rather than closed over, because the summary is re-rendered on every
// refresh and a captured rollup would be stale.
$('summary').onclick = e => {
  if (e.target.closest('#auto-assign')) $('aa-dialog').showModal()
}

$('aa-dialog').onclick = e => {
  const btn = e.target.closest('[data-aa]')
  if (!btn) return
  if (btn.dataset.aa === 'cancel') return $('aa-dialog').close()
  const roll = rollup(state.cats, state.assigns, state.history, monthStart(state.month))
  const rows = autoAssignRows(btn.dataset.aa, roll)
  $('aa-dialog').close()
  if (rows.length) assign(rows)
}

const catOptions = (selected, blank = 'Uncategorized') =>
  `<option value="">${blank}</option>` +
  state.cats.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')

function openTxn(t) {
  state.editing = t?.id ?? null
  $('txn-title').textContent = t ? 'Edit transaction' : 'Add transaction'
  $('t-kind').value = t?.kind ?? 'expense'
  $('t-amount').value = t ? t.amount : ''
  $('t-desc').value = t?.description ?? ''
  $('t-date').value = t?.occurred_on ?? today()
  $('t-cat').innerHTML = catOptions(t?.category_id)
  $('t-flag').value = t?.flag ?? ''
  // Payees: distinct past descriptions feed the datalist. ponytail: descriptions
  // already are payees, so no payees table -- just autocomplete from history.
  $('payee-list').innerHTML = [...new Set(state.history.map(x => x.description).filter(Boolean))]
    .slice(0, 50).map(d => `<option value="${esc(d)}">`).join('')
  $('txn-err').hidden = true
  $('txn-dialog').showModal()
}

$('txn-form').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const row = {
    budget_id:   state.budgetId,
    kind:        $('t-kind').value,
    amount:      Number($('t-amount').value),
    description: $('t-desc').value.trim(),
    category_id: $('t-cat').value || null,
    occurred_on: $('t-date').value,
    flag:        $('t-flag').value || null
  }
  if (!(row.amount > 0)) { $('txn-err').textContent = 'Amount must be more than zero.'; $('txn-err').hidden = false; return }

  const { error } = state.editing
    ? await sb.from('transactions').update(row).eq('id', state.editing)
    : await sb.from('transactions').insert(row)
  if (error) { $('txn-err').textContent = error.message; $('txn-err').hidden = false; return }
  $('txn-dialog').close()
  refresh()
}

// ---------------------------------------------------------------- categories

$('manage-cats').onclick = () => { renderCats(); $('cat-dialog').showModal() }
$('cat-done').onclick = () => { $('cat-dialog').close(); refresh() }

function renderCats() {
  $('cat-list').innerHTML = state.cats.map(c => `
    <div class="cat-edit">
      <input type="text" value="${esc(c.name)}" maxlength="40" data-name="${c.id}" aria-label="Name">
      <input type="number" value="${c.monthly_limit}" step="0.01" min="0" inputmode="decimal" data-limit="${c.id}" aria-label="Monthly target">
      <button class="del" data-delcat="${c.id}" aria-label="Delete category" style="font-size:18px;color:var(--ink-2);padding:4px 8px">&times;</button>
      <input type="text" class="cat-group" value="${esc(c.group_name ?? '')}" maxlength="40" list="group-list" placeholder="Group (optional)" data-group="${c.id}" aria-label="Group">
    </div>`).join('')
  $('group-list').innerHTML = [...new Set(state.cats.map(c => c.group_name).filter(Boolean))]
    .map(g => `<option value="${esc(g)}">`).join('')
}

$('cat-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const { error } = await sb.from('categories').insert({
    budget_id: state.budgetId,
    name: $('c-name').value.trim(),
    monthly_limit: Number($('c-limit').value) || 0,
    group_name: $('c-group').value.trim() || null   // kept between adds, so several go to one group
  })
  if (error) return fail(error)
  $('c-name').value = ''; $('c-limit').value = ''
  await loadMonth(); renderCats(); render()
}

// Save each field as it changes. ponytail: no dirty tracking, no save button.
$('cat-list').onchange = async e => {
  const id = e.target.dataset.name ?? e.target.dataset.limit ?? e.target.dataset.group
  if (!id) return
  let patch
  if (e.target.dataset.name) { patch = { name: e.target.value.trim() }; if (patch.name === '') return }
  else if (e.target.dataset.limit) patch = { monthly_limit: Number(e.target.value) || 0 }
  else patch = { group_name: e.target.value.trim() || null }
  const { error } = await sb.from('categories').update(patch).eq('id', id)
  if (error) return fail(error)
  await loadMonth(); renderCats(); render()
}

$('cat-list').onclick = async e => {
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
    ? `Delete this category? Its ${n} transaction${n === 1 ? '' : 's'} stay but become uncategorized, which moves that spending into Ready to Assign and changes past months.`
    : 'Delete this category? Nothing is logged in it yet.'
  if (!confirm(msg)) return
  const { error } = await sb.from('categories').delete().eq('id', b.dataset.delcat)
  if (error) return fail(error)
  await loadMonth(); renderCats(); render()
}

// ---------------------------------------------------------------- recurring

$('manage-rec').onclick = () => {
  $('r-cat').innerHTML = catOptions(null)
  renderRec()
  $('rec-dialog').showModal()
}
$('rec-done').onclick = () => { $('rec-dialog').close(); refresh() }

function renderRec() {
  $('rec-list').innerHTML = state.recurring.length ? state.recurring.map(r => `
    <div class="rec-edit">
      <div class="body">
        <div class="desc">${esc(r.description)}</div>
        <div class="small muted">day ${r.day_of_month} &middot; ${r.kind}${r.category_id ? ` &middot; ${esc(state.cats.find(c => c.id === r.category_id)?.name ?? '')}` : ''}</div>
      </div>
      <span class="num ${r.kind === 'income' ? 'income-amt' : ''}">${r.kind === 'income' ? '+' : ''}${money(cents(r.amount))}</span>
      <button class="del" data-delrec="${r.id}" aria-label="Delete rule" style="font-size:18px;color:var(--ink-2);padding:4px 8px">&times;</button>
    </div>`).join('') : '<div class="empty">No rules yet.</div>'
}

$('rec-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const { error } = await sb.from('recurring').insert({
    budget_id:    state.budgetId,
    kind:         $('r-kind').value,
    amount:       Number($('r-amount').value),
    description:  $('r-desc').value.trim(),
    category_id:  $('r-cat').value || null,
    day_of_month: Number($('r-day').value)
  })
  if (error) return fail(error)
  $('r-desc').value = ''; $('r-amount').value = ''; $('r-day').value = '1'
  await loadMonth(); renderRec(); render()
}

$('rec-list').onclick = async e => {
  const b = e.target.closest('[data-delrec]')
  if (!b) return
  if (!confirm('Delete this rule? Transactions it already created stay.')) return
  const { error } = await sb.from('recurring').delete().eq('id', b.dataset.delrec)
  if (error) return fail(error)
  await loadMonth(); renderRec(); render()
}

$('apply-rec').onclick = async () => {
  const rows = pendingRecurring().map(r => ({
    budget_id:   state.budgetId,
    kind:        r.kind,
    amount:      r.amount,
    description: r.description,
    category_id: r.category_id,
    occurred_on: recurringDate(state.month, r.day_of_month),
    recurring_id: r.id
  }))
  if (!rows.length) return
  // ignoreDuplicates leans on the unique index: if we both press this at the same
  // moment, the loser's rows are skipped rather than charging rent twice.
  const { error } = await sb.from('transactions')
    .upsert(rows, { onConflict: 'recurring_id,occurred_on', ignoreDuplicates: true })
  if (error) return fail(error)
  refresh()
}
