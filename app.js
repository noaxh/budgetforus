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

// ponytail: YNAB's four states (red/yellow/green/gray) collapsed to what these two
// numbers can actually tell us. No rollover, no targets, no "ready to assign".
function status(spentC, limitC) {
  if (limitC <= 0)          return 'none'
  if (spentC > limitC)      return 'over'
  if (spentC >= limitC * 0.8) return 'close'
  return 'ok'
}

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

// ---------------------------------------------------------------- self-check
// Load with ?selftest to run. Money and month-end are the only logic here that
// can be quietly wrong, so they're the only things checked.

if (location.search.includes('selftest')) {
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`) }
  eq([0.1, 0.2, 0.3].reduce((s, n) => s + cents(n), 0), 60, 'cents sum exactly')
  eq(cents(19.99), 1999, 'cents rounds')
  eq(status(0, 0), 'none', 'no limit set')
  eq(status(5000, 10000), 'ok', 'under')
  eq(status(8000, 10000), 'close', 'at 80%')
  eq(status(10001, 10000), 'over', 'over by a cent')
  eq(monthEnd(new Date(2026, 1, 1)), '2026-02-28', 'february')
  eq(monthEnd(new Date(2024, 1, 1)), '2024-02-29', 'leap february')
  eq(monthStart(new Date(2026, 6, 15)), '2026-07-01', 'month start ignores day')
  eq(recurringDate(new Date(2026, 6, 1), 15), '2026-07-15', 'normal day passes through')
  eq(recurringDate(new Date(2026, 1, 1), 31), '2026-02-28', 'day 31 clamps to Feb 28')
  eq(recurringDate(new Date(2024, 1, 1), 31), '2024-02-29', 'day 31 clamps to leap Feb')
  eq(recurringDate(new Date(2026, 3, 1), 31), '2026-04-30', 'day 31 clamps to Apr 30')
  console.log('selftest ok')
}

// ---------------------------------------------------------------- state

const state = { budgets: [], budgetId: null, month: new Date(), cats: [], txns: [], recurring: [], editing: null }
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
  if (!state.budgetId) { state.cats = []; state.txns = []; state.recurring = []; return }
  const [c, t, r] = await Promise.all([
    sb.from('categories').select('*').eq('budget_id', state.budgetId).order('sort').order('name'),
    sb.from('transactions').select('*').eq('budget_id', state.budgetId)
      .gte('occurred_on', monthStart(state.month))
      .lte('occurred_on', monthEnd(state.month))
      .order('occurred_on', { ascending: false }),
    sb.from('recurring').select('*').eq('budget_id', state.budgetId)
      .eq('active', true).order('day_of_month')
  ])
  if (c.error) return fail(c.error)
  if (t.error) return fail(t.error)
  if (r.error) return fail(r.error)
  state.cats = c.data ?? []
  state.txns = t.data ?? []
  state.recurring = r.data ?? []
}

// Rules with no transaction yet in the month on screen.
const pendingRecurring = () => {
  const applied = new Set(state.txns.map(t => t.recurring_id).filter(Boolean))
  return state.recurring.filter(r => !applied.has(r.id))
}

const fail = e => { console.error(e); alert(e.message ?? String(e)) }

// ---------------------------------------------------------------- render

// Expenses only. Income filed under a category must not count against its limit,
// or a paycheque tagged "Groceries" would quietly buy back grocery headroom.
function spentByCat() {
  const m = new Map()
  for (const t of state.txns) {
    if (t.kind !== 'expense') continue
    m.set(t.category_id, (m.get(t.category_id) ?? 0) + cents(t.amount))
  }
  return m
}

const sumKind = k => state.txns.filter(t => t.kind === k).reduce((s, t) => s + cents(t.amount), 0)

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
  $('add-btn').hidden = !has
  if (!has) return

  const spent = spentByCat()
  const totalSpent = sumKind('expense')
  const totalIncome = sumKind('income')
  const totalLimit = state.cats.reduce((s, c) => s + cents(c.monthly_limit), 0)
  const st = status(totalSpent, totalLimit)
  const left = totalIncome - totalSpent

  $('summary').innerHTML = `
    <div class="total">
      <span class="amt num">${money(totalSpent)}</span>
      <span class="small muted num">${totalLimit ? `of ${money(totalLimit)}` : 'no limits set'}</span>
    </div>
    <div class="bar"><i class="f-${st}" style="width:${totalLimit ? Math.min(100, totalSpent / totalLimit * 100) : 0}%"></i></div>
    ${totalIncome ? `<div class="net">
      <span class="num">Income ${money(totalIncome)}</span>
      <span class="num left-amt ${left < 0 ? 'neg' : ''}">${money(left)} ${left < 0 ? 'over' : 'left'}</span>
    </div>` : ''}`

  const pend = pendingRecurring()
  $('rec-banner').hidden = !pend.length
  if (pend.length) {
    $('rec-banner-text').textContent =
      `${pend.length} recurring ${pend.length === 1 ? 'item' : 'items'} not added for ${monthLabel(state.month)}.`
  }

  $('cat-count').textContent = state.cats.length ? `${state.cats.length}` : ''
  $('categories').innerHTML = state.cats.length ? state.cats.map(c => {
    const s = spent.get(c.id) ?? 0
    const l = cents(c.monthly_limit)
    const k = status(s, l)
    const left = l - s
    return `<div class="row">
      <div class="cat-top">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="pill s-${k}">${k === 'over' ? `${money(-left)} over` : k === 'none' ? 'no limit' : `${money(left)} left`}</span>
      </div>
      <div class="small muted num">${money(s)}${l ? ` of ${money(l)}` : ''}</div>
      <div class="bar"><i class="f-${k}" style="width:${l ? Math.min(100, s / l * 100) : 0}%"></i></div>
    </div>`
  }).join('') : '<div class="empty">No categories yet. Add some to start tracking limits.</div>'

  $('txn-count').textContent = state.txns.length ? `${state.txns.length}` : ''
  const catName = id => state.cats.find(c => c.id === id)?.name ?? 'Uncategorized'
  $('transactions').innerHTML = state.txns.length ? state.txns.map(t => `
    <div class="row txn">
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

$('add-btn').onclick = () => openTxn(null)
$('txn-cancel').onclick = () => $('txn-dialog').close()

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
    occurred_on: $('t-date').value
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
      <input type="number" value="${c.monthly_limit}" step="0.01" min="0" inputmode="decimal" data-limit="${c.id}" aria-label="Monthly limit">
      <button class="del" data-delcat="${c.id}" aria-label="Delete category" style="font-size:18px;color:var(--ink-2);padding:4px 8px">&times;</button>
    </div>`).join('')
}

$('cat-add').onsubmit = async e => {
  e.preventDefault()
  if (!state.budgetId) return fail(new Error('Create a budget first.'))
  const { error } = await sb.from('categories').insert({
    budget_id: state.budgetId,
    name: $('c-name').value.trim(),
    monthly_limit: Number($('c-limit').value) || 0
  })
  if (error) return fail(error)
  $('c-name').value = ''; $('c-limit').value = ''
  await loadMonth(); renderCats(); render()
}

// Save each field as it changes. ponytail: no dirty tracking, no save button.
$('cat-list').onchange = async e => {
  const id = e.target.dataset.name ?? e.target.dataset.limit
  if (!id) return
  const patch = e.target.dataset.name
    ? { name: e.target.value.trim() }
    : { monthly_limit: Number(e.target.value) || 0 }
  if (patch.name === '') return
  const { error } = await sb.from('categories').update(patch).eq('id', id)
  if (error) return fail(error)
  await loadMonth(); render()
}

$('cat-list').onclick = async e => {
  const b = e.target.closest('[data-delcat]')
  if (!b) return
  if (!confirm('Delete this category? Its transactions stay, but become uncategorized.')) return
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
