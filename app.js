import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import {
  cents, money, monthKey, monthStart, monthEnd, monthLabel, today,
  prevMonthStart, sumSpentInRange, rollup, recurringOccurrences
} from './core.js'

// Safe to commit and ship to the browser: the publishable key is public by
// design and RLS is what protects the data. The sb_secret_ key never goes here.
const SUPABASE_URL = 'https://aeqydektxshybtyjkekp.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable__AX_N4UOwp4mBBXIe_ynRQ_D616UKp6'

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ---------------------------------------------------------------- state

// txns is the month on screen (the list). history is everything up to the end of
// it (the rollup) -- two views of one fetch, because Available rolls forward.
const state = { budgets: [], budgetId: null, month: new Date(), cats: [], txns: [], history: [], assigns: [], recurring: [], editing: null, selMode: false, sel: new Set() }
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

// ---------------------------------------------------------------- render

const sumKind = k => state.txns.filter(t => t.kind === k).reduce((s, t) => s + cents(t.amount), 0)

// Expected-income for Cost to Be Me. Per budget, in localStorage: it's a personal
// what-if, not budget data, so it never touches Supabase or RLS.
const ctbmKey = () => `ctbm-income-${state.budgetId}`
const ctbmIncome = () => Number(localStorage.getItem(ctbmKey())) || 0

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
    // Fund every target to what it needs this month, topping up whatever is
    // already assigned. 'target' above is the special case of this that only
    // touches empty envelopes; 'fund' also tops up the partly-assigned ones.
    // assign() replaces the month's amount, so the new amount is this month's
    // assignment plus the remaining shortfall.
    case 'fund':   return state.cats.map(c => { const e = roll.cats.get(c.id); return e && e.needed > 0 ? row(c, (e.assigned + e.needed) / 100) : null }).filter(Boolean)
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

  // Cost to Be Me: the sum of every target's needed-this-month -- what it costs
  // to keep every goal on track this month. Compared against an expected-income
  // figure the user types (kept per budget in localStorage; it isn't budget data,
  // it's a personal what-if), it answers "does my income cover my plan".
  const costToBeMe = state.cats.reduce((s, c) => s + (roll.cats.get(c.id)?.needed ?? 0), 0)
  const hasTargets = state.cats.some(c => c.target_kind)
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
    </div>${ctbm}`

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
    // The target affordance: only categories with a target say anything. Amber
    // ones name the shortfall (with the due date for by-date goals), funded ones
    // just confirm it. ponytail: text, not the ring -- the progress ring is the
    // design-engineer piece and does not gate the money logic.
    const tgt = c.target_kind
      ? `<div class="tgt small ${e.needed > 0 ? 'muted' : 'tgt-met'} num">${
          e.needed > 0
            ? `${money(e.needed)} to fund${c.target_kind === 'by_date' && c.target_due ? ` by ${c.target_due}` : ''}`
            : 'Target funded'}</div>`
      : ''
    return `<div class="row">
      <div class="cat-top">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="pill s-${e.status}">${e.available < 0 ? `${money(-e.available)} over` : `${money(e.available)} left`}</span>
      </div>
      <div class="assign-row">
        <label for="a-${c.id}">Assigned</label>
        <input class="assign num" id="a-${c.id}" type="number" step="0.01" inputmode="decimal"
               value="${(e.assigned / 100).toFixed(2)}" data-assign="${c.id}">
        <span class="small muted num">${e.spent ? `${money(e.spent)} spent` : 'nothing spent'}</span>
      </div>
      <div class="bar"><i class="f-neutral" style="width:${e.assigned > 0 ? Math.min(100, e.spent / e.assigned * 100) : 0}%"></i></div>
      ${tgt}
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
  // In select mode the row leads with a checkbox and the body toggles selection
  // instead of opening the editor; the per-row delete gives way to the bulk bar.
  const sel = state.selMode
  $('transactions').innerHTML = state.txns.length ? state.txns.map(t => `
    <div class="row txn${sel && state.sel.has(t.id) ? ' selected' : ''}">
      ${sel ? `<span class="check" aria-hidden="true">${state.sel.has(t.id) ? '&#10003;' : ''}</span>` : ''}
      ${t.flag ? `<span class="flag-dot" style="background:var(--flag-${t.flag})" title="Flag: ${t.flag}"></span>` : ''}
      <div class="body" ${sel ? `data-sel="${t.id}"` : `data-edit="${t.id}"`} style="cursor:pointer">
        <div class="desc">${esc(t.description) || '<span class="muted">No description</span>'}</div>
        <div class="small muted">${t.occurred_on} &middot; ${esc(catName(t.category_id))}${t.recurring_id ? ' &middot; recurring' : ''}</div>
      </div>
      <span class="num ${t.kind === 'income' ? 'income-amt' : ''}">${t.kind === 'income' ? '+' : ''}${money(cents(t.amount))}</span>
      ${sel ? '' : `<button class="del" data-del="${t.id}" aria-label="Delete transaction">&times;</button>`}
    </div>`).join('') : '<div class="empty">Nothing logged this month.</div>'

  // Bulk bar reflects the current selection; the Select toggle flips its label.
  // The bar and the FAB share the bottom-centre slot, so only one shows at a time.
  $('bulk-bar').hidden = !sel
  $('add-btn').hidden = sel
  $('sel-toggle').textContent = sel ? 'Done' : 'Select'
  if (sel) $('bulk-count').textContent = `${state.sel.size} selected`
}

async function refresh() {
  await loadMonth()
  if (await maybeAutoApply()) await loadMonth()  // reload so the fresh rows show
  render()
}

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

// Leaving the month clears any selection: its ids belong to the month you left.
const goMonth = delta => { if (state.selMode) { state.selMode = false; state.sel.clear() } state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1); refresh() }
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
  state.selMode = false; state.sel.clear()
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

// ---------------------------------------------------------------- assigning

// Upsert, not update: the row for (category, month) doesn't exist until someone
// assigns something, and "assigned nothing" and "never assigned" spend the same.
async function assign(rows) {
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

// Expected-income edits persist and re-render the covered/short verdict. Only a
// re-render (not a full refresh) is needed -- no budget data changed.
$('summary').onchange = e => {
  if (e.target.id !== 'ctbm-income') return
  const v = Number(e.target.value) || 0
  if (v > 0) localStorage.setItem(ctbmKey(), String(v))
  else localStorage.removeItem(ctbmKey())
  render()
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
  const kindOpts = k => [['', 'No target'], ['monthly', 'Monthly refill'], ['by_date', 'By date']]
    .map(([v, l]) => `<option value="${v}" ${(k ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')
  $('cat-list').innerHTML = state.cats.map(c => `
    <div class="cat-edit">
      <input type="text" value="${esc(c.name)}" maxlength="40" data-name="${c.id}" aria-label="Name">
      <input type="number" value="${c.monthly_limit}" step="0.01" min="0" inputmode="decimal" data-limit="${c.id}" aria-label="Target amount">
      <button class="del" data-delcat="${c.id}" aria-label="Delete category" style="font-size:18px;color:var(--ink-2);padding:4px 8px">&times;</button>
      <select class="cat-kind" data-kind="${c.id}" aria-label="Target kind">${kindOpts(c.target_kind)}</select>
      <input type="date" class="cat-due" value="${c.target_due ?? ''}" data-due="${c.id}" aria-label="Target date"${c.target_kind === 'by_date' ? '' : ' hidden'}>
      <input type="text" class="cat-group" value="${esc(c.group_name ?? '')}" maxlength="40" list="group-list" placeholder="Group (optional)" data-group="${c.id}" aria-label="Group">
    </div>`).join('')
  $('group-list').innerHTML = [...new Set(state.cats.map(c => c.group_name).filter(Boolean))]
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
  const id = d.name ?? d.limit ?? d.kind ?? d.due ?? d.group
  if (!id) return
  let patch
  if (d.name) { patch = { name: e.target.value.trim() }; if (patch.name === '') return }
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
  syncRecCadence()
  renderRec()
  $('rec-dialog').showModal()
}
$('rec-done').onclick = () => { $('rec-dialog').close(); refresh() }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const cadenceLabel = r =>
  r.cadence === 'weekly'  ? `every ${WEEKDAYS[r.day_of_week] ?? '?'}`
  : r.cadence === 'every_n' ? `every ${r.interval_months} month${r.interval_months === 1 ? '' : 's'}, day ${r.day_of_month}`
  : `monthly, day ${r.day_of_month}`

function renderRec() {
  $('rec-list').innerHTML = state.recurring.length ? state.recurring.map(r => `
    <div class="rec-edit">
      <div class="body">
        <div class="desc">${esc(r.description)}</div>
        <div class="small muted">${cadenceLabel(r)} &middot; ${r.kind}${r.auto_apply ? ' &middot; auto' : ''}${r.category_id ? ` &middot; ${esc(state.cats.find(c => c.id === r.category_id)?.name ?? '')}` : ''}</div>
      </div>
      <span class="num ${r.kind === 'income' ? 'income-amt' : ''}">${r.kind === 'income' ? '+' : ''}${money(cents(r.amount))}</span>
      <button class="del" data-delrec="${r.id}" aria-label="Delete rule" style="font-size:18px;color:var(--ink-2);padding:4px 8px">&times;</button>
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
  const b = e.target.closest('[data-delrec]')
  if (!b) return
  if (!confirm('Delete this rule? Transactions it already created stay.')) return
  const { error } = await sb.from('recurring').delete().eq('id', b.dataset.delrec)
  if (error) return fail(error)
  await loadMonth(); renderRec(); render()
}

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
