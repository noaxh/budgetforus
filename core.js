// core.js -- the pure logic: money, dates, the envelope rollup, and its
// self-check. No DOM, no Supabase, no app state; everything here is a pure
// function of its arguments, which is why the whole file is exercised by
// ?selftest at the bottom. app.js imports from here. Phase B's targets math
// belongs here too, next to rollup().

// ---------------------------------------------------------------- money

// Integer cents everywhere. Summing 2dp floats drifts (0.1+0.2 = 0.30000000000000004);
// summing cents doesn't. Only convert back at render.
export const cents = n => Math.round(Number(n) * 100)
export const money = c => (c / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })

// ---------------------------------------------------------------- dates

export const monthKey   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
export const monthStart = d => `${monthKey(d)}-01`
export const monthEnd   = d => `${monthKey(d)}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0')}`
export const monthLabel = d => d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
export const today      = () => { const d = new Date(); return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}` }

// Where a "31st of the month" rule lands in February. Clamping to the last day
// keeps the date deterministic per rule per month, which is exactly what the
// unique index on (recurring_id, occurred_on) relies on to stop double-charging.
export const recurringDate = (d, day) => {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  return `${monthKey(d)}-${String(Math.min(day, last)).padStart(2, '0')}`
}

// Previous month's 1st, for the "last month" auto-assign modes.
export const prevMonthStart = ms => { const d = new Date(ms + 'T00:00'); d.setMonth(d.getMonth() - 1); return monthStart(d) }

// Every date a recurring rule lands on within the month `ms` ('YYYY-MM-01'), as
// 'YYYY-MM-DD' strings. One function drives all three cadences so pending-detect,
// "Add them", and auto-apply all agree on what a rule is due for:
//   monthly  -> the anchor day, once
//   every_n  -> the anchor day, but only on months a whole interval from the
//               rule's creation month (so a quarterly bill skips the between months)
//   weekly   -> every matching weekday in the month (the one cadence that is
//               many-per-month, which is why callers must match on date, not rule)
// ponytail: every_n is anchored on created_at's month, not a user-picked start, so
// "every 2 months" means the odd/even months relative to when the rule was made.
export function recurringOccurrences(rule, ms) {
  const [y, m] = ms.split('-').map(Number)              // m is 1-12
  const first = new Date(y, m - 1, 1)
  switch (rule.cadence || 'monthly') {
    case 'weekly': {
      if (rule.day_of_week == null) return []
      const last = new Date(y, m, 0).getDate()
      const out = []
      for (let d = 1; d <= last; d++) {
        if (new Date(y, m - 1, d).getDay() === rule.day_of_week)
          out.push(`${ms.slice(0, 8)}${String(d).padStart(2, '0')}`)
      }
      return out
    }
    case 'every_n': {
      const n = rule.interval_months || 1
      const anchor = (rule.created_at || ms).slice(0, 7)  // 'YYYY-MM'
      const [ay, am] = anchor.split('-').map(Number)
      const diff = (y - ay) * 12 + (m - am)
      return diff >= 0 && diff % n === 0 ? [recurringDate(first, rule.day_of_month)] : []
    }
    default:
      return [recurringDate(first, rule.day_of_month)]
  }
}

// ---------------------------------------------------------------- rules (Phase 3)

// The first rule whose `match` text is a (case-insensitive) substring of the
// description wins. `rules` is in priority order (the caller sorts by `sort`),
// so "first match wins" is just the first hit. Returns the rule or null. Blank
// match or blank description never matches. Pure + selftested.
export function matchRule(description, rules) {
  const d = (description || '').toLowerCase()
  if (!d) return null
  for (const r of rules || []) {
    const m = (r.match || '').toLowerCase().trim()
    if (m && d.includes(m)) return r
  }
  return null
}

// Payee memory: the category_id most recently used for an EXACT (case-insensitive)
// description, or null. The pre-fill fallback when no rule matches — we already
// hold the history, so no payees table. `history` is newest-first (loadMonth orders
// occurred_on desc), so the first exact match is the most recent. Split parents
// carry no category, so they're skipped. Pure + selftested.
export function lastCategoryFor(description, history) {
  const d = (description || '').trim().toLowerCase()
  if (!d) return null
  for (const t of history || []) {
    if (t.parent_id) continue
    if (t.category_id && (t.description || '').trim().toLowerCase() === d) return t.category_id
  }
  return null
}

// Retro-apply: the change set from running `rules` over every uncategorized,
// non-parent EXPENSE in `txns`. Each change is {id, description, category_id,
// flag} — the preview renders it and the commit writes it. A matched flag only
// fills a blank one (never stomps a flag the user set). Rows a rule leaves without
// a category (flag-only rule) are dropped, since retro-apply is about categorizing.
// Pure + selftested.
export function retroApply(txns, rules) {
  const out = []
  for (const t of txns || []) {
    if (t.parent_id || t.category_id || t.kind !== 'expense') continue
    const r = matchRule(t.description, rules)
    if (r && r.category_id) out.push({ id: t.id, description: t.description, category_id: r.category_id, flag: r.flag || t.flag || null })
  }
  return out
}

// ---------------------------------------------------------------- net worth (Phase 4)

// Net worth as of `month` ('YYYY-MM-01'): for each non-archived account, its most
// recent snapshot on or before that month (CARRY-FORWARD — a month you didn't
// update keeps the last figure), assets added and liabilities subtracted, all in
// cents. Returns { net, assets, liabilities, rows } where each row is
// {id, name, kind, balance, stale} and stale = the balance is carried forward
// (no snapshot exactly this month). An account with no snapshot yet is not counted
// and gets no row. Pure + selftested.
export function netWorthAt(accounts, snapshots, month) {
  let assets = 0, liabilities = 0
  const rows = []
  for (const acc of accounts || []) {
    if (acc.archived) continue
    let latest = null
    for (const s of snapshots || []) {
      if (s.account_id !== acc.id || s.month > month) continue
      if (!latest || s.month > latest.month) latest = s
    }
    if (!latest) continue
    const bal = latest.balance_cents
    if (acc.kind === 'liability') liabilities += bal; else assets += bal
    rows.push({ id: acc.id, name: acc.name, kind: acc.kind, balance: bal, stale: latest.month !== month })
  }
  return { net: assets - liabilities, assets, liabilities, rows }
}

// Net worth at each of `months` (array of 'YYYY-MM-01'), for the trend chart. Pure.
export const netWorthSeries = (accounts, snapshots, months) =>
  months.map(m => ({ month: m, net: netWorthAt(accounts, snapshots, m).net }))

// A category's expenses within [from, to] inclusive, in cents. The date window is
// the only thing here that can be quietly wrong, so it carries a selftest.
export const sumSpentInRange = (history, id, from, to) =>
  history.filter(t => t.category_id === id && t.kind === 'expense' && t.occurred_on >= from && t.occurred_on <= to)
         .reduce((s, t) => s + cents(t.amount), 0)

// ---------------------------------------------------------------- reports

// The Phase D spending breakdown: the expenses in `txns`, grouped by category,
// largest first, with the grand total. Pure so the Reflect report is testable
// like the rest of the money math. Income is ignored (a breakdown is where money
// went), and every uncategorized expense folds into one 'Uncategorized' bucket so
// the parts always sum to the whole. Amounts stay in cents; the caller derives
// each row's share of the total for the bar width.
// ponytail: whatever `txns` it's handed -- the app passes the month on screen, so
// the report follows the month stepper. A multi-month range is the 'spending
// trends' report (Phase D item 2), which is this same function over a wider slice.
export function spendingBreakdown(txns, cats) {
  const name = new Map(cats.map(c => [c.id, c.name]))
  const parents = splitParentIds(txns)
  const byCat = new Map()
  let total = 0
  for (const t of txns) {
    if (t.kind !== 'expense' || parents.has(t.id)) continue
    const c = cents(t.amount)
    total += c
    const key = t.category_id ?? '__uncat__'   // a uuid has no underscores, so this sentinel can't collide
    byCat.set(key, (byCat.get(key) || 0) + c)
  }
  const rows = [...byCat.entries()]
    .map(([key, amount]) => ({
      id: key === '__uncat__' ? null : key,
      name: key === '__uncat__' ? 'Uncategorized' : (name.get(key) ?? 'Uncategorized'),
      amount
    }))
    .sort((a, b) => b.amount - a.amount)
  return { rows, total }
}

// Income vs expense for a set of transactions, in cents. The Phase D cash-flow
// report. Pure + selftested; net is income - expense, so a surplus is positive
// and a deficit negative. Same slice as the breakdown (the month on screen), so
// the two Reflect cards always describe the same window.
export function cashFlow(txns) {
  const parents = splitParentIds(txns)
  let income = 0, expense = 0
  for (const t of txns) {
    if (parents.has(t.id)) continue           // container row; children carry the money
    const c = cents(t.amount)
    if (t.kind === 'income') income += c
    else expense += c
  }
  return { income, expense, net: income - expense }
}

// True if transaction `t` matches the free-text query `q` (already lowercased),
// searched across description, its category's name (via nameOf), flag, amount and
// date. Substring, case-insensitive; an empty query matches everything. Pure so
// the register search is testable and the searched fields live in one place.
// ponytail: one substring over a few joined fields, not per-field operators or an
// exact/phrase mode -- those are the search bar's later enhancements. Amount is
// matched as its raw string ('92.4'), so '92' hits but '92.40' would not.
export function txnMatches(t, q, nameOf) {
  if (!q) return true
  return [t.description, nameOf(t.category_id), t.flag,
          t.amount != null ? String(t.amount) : '', t.occurred_on]
    .join(' ').toLowerCase().includes(q)
}

// ---------------------------------------------------------------- targets

// Whole months from month-start `ms` to a due date, counting both endpoint
// months, floored at 1. A by-date target funds evenly across these months, so a
// due date in the current month is one month, not zero.
// ponytail: whole-month count -- a mid-month due date still funds over the
// remaining whole months, no day-level proration.
export const monthsLeft = (ms, due) => {
  if (!due) return 1
  const [my, mm] = ms.split('-').map(Number)
  const [dy, dm] = due.split('-').map(Number)
  return Math.max(1, (dy - my) * 12 + (dm - mm) + 1)
}

// Cents a category should have added THIS month to stay on track for its target,
// or 0 when it has no supported target or the target is already met. `availableC`
// is the category's cumulative Available; `monthly_limit` is the target amount
// for whichever kind is set.
//   monthly  -> refill Available up to the target
//   by_date  -> save the remaining shortfall evenly over the months left
// ponytail: only 'monthly' and 'by_date' are built. weekly/setaside/balance are
// deferred -- the schema (schema-v5) holds them, they become more switch arms
// here. By-date assumes an even monthly contribution, not front-loading or catch-up.
export function targetNeeded(cat, availableC, ms) {
  const targetC = cents(cat.monthly_limit)
  if (!cat.target_kind || targetC <= 0) return 0
  const remaining = Math.max(0, targetC - availableC)
  switch (cat.target_kind) {
    case 'monthly': return remaining
    case 'by_date': return Math.ceil(remaining / monthsLeft(ms, cat.target_due))
    default:        return 0
  }
}

// ---------------------------------------------------------------- envelope

// YNAB colours Available and nothing else: red means the envelope is in the
// hole, amber means a target is set but not yet funded this month, green means it
// holds money with no shortfall, gray means it has never been touched. `neededC`
// is the category's needed-this-month from targetNeeded (0 when it has no
// target), which is what finally makes YNAB's real yellow expressible.
// `snoozed` suppresses the amber: a category whose target you've skipped this
// month is no longer underfunded, so it drops to green (if it holds money) or
// gray (if empty) instead of nagging.
export function envStatus(availC, neededC, snoozed = false) {
  if (availC < 0) return 'over'
  if (neededC > 0 && !snoozed) return 'under'
  if (availC > 0) return 'ok'
  return 'none'
}

// The ids of split PARENTS in a transaction list: a parent is any row another
// row points to via parent_id. Its amount is the sum of its children, so every
// money pass skips parents and counts the children instead — counting both would
// double the split.
export const splitParentIds = txns => new Set(txns.filter(t => t.parent_id).map(t => t.parent_id))

// Auto-distribute a split. Given the parent total and the child amounts entered
// so far (cents; null/0 = a blank row), return the amounts with the remaining
// balance spread evenly over the blank rows, the rounding penny landing on the
// last blank. If no row is blank the amounts pass through untouched — the user
// set them all, and a total that doesn't reconcile is theirs to see. Pure so the
// split math is selftested.
export function distributeSplit(totalC, partsC) {
  const filled = partsC.map(c => c || 0)
  const blanks = partsC.map((c, i) => (!c ? i : -1)).filter(i => i >= 0)
  if (!blanks.length) return filled
  const remain = totalC - filled.reduce((s, c) => s + c, 0)
  const per = Math.trunc(remain / blanks.length)
  blanks.forEach((idx, k) => { filled[idx] = k === blanks.length - 1 ? remain - per * (blanks.length - 1) : per })
  return filled
}

// Evaluate a small arithmetic expression from a money input ("5+3.50", "12*2",
// "(4+6)/2"), returning a Number, or null if it isn't a valid expression. Only
// digits, . + - * / ( ) and spaces are allowed — anything else returns null, so
// this never runs arbitrary code (no eval). A plain number passes straight
// through. Pure + selftested; the amount fields use it so mental math doesn't
// need a separate calculator.
export function evalAmount(str) {
  const s = String(str ?? '').trim()
  if (!s || !/^[\d.\s+\-*/()]+$/.test(s)) return null
  const toks = s.match(/\d*\.?\d+|[+\-*/()]/g)
  if (!toks) return null
  let i = 0
  const peek = () => toks[i], eat = () => toks[i++]
  const factor = () => {
    if (peek() === '(') { eat(); const v = expr(); if (eat() !== ')') throw 0; return v }
    if (peek() === '-') { eat(); return -factor() }
    const n = Number(eat())
    if (!Number.isFinite(n)) throw 0
    return n
  }
  const term = () => { let v = factor(); while (peek() === '*' || peek() === '/') { const op = eat(); const r = factor(); v = op === '*' ? v * r : v / r } return v }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const op = eat(); const r = term(); v = op === '+' ? v + r : v - r } return v }
  try { const v = expr(); return i === toks.length && Number.isFinite(v) ? v : null }
  catch { return null }
}

// Age of Money (YNAB's metric), in whole days, or null when there isn't enough
// banked income to say. FIFO: income dollars queue oldest-first, each expense
// draws from the front of the queue, and an expense's age is how long those
// specific dollars sat (spend date minus the income date they came from,
// amount-weighted within the expense). AoM is the mean age of the last `sample`
// expenses. Split parents are skipped (their children are the real outflows).
// ponytail: whole-day resolution, weighted within an expense but a plain mean
// across them, and it ignores the portion of an expense not covered by banked
// income rather than inventing an age for it.
export function ageOfMoney(history, sample = 10) {
  const parents = splitParentIds(history)
  const rows = history
    .filter(t => (t.kind === 'income' || t.kind === 'expense') && !parents.has(t.id))
    .slice().sort((a, b) => a.occurred_on < b.occurred_on ? -1 : a.occurred_on > b.occurred_on ? 1 : 0)
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00') - Date.parse(a + 'T00:00')) / 86400000)
  const q = []            // income lots {date, c}, oldest first
  const ages = []
  for (const t of rows) {
    let c = cents(t.amount)
    if (t.kind === 'income') { q.push({ date: t.occurred_on, c }); continue }
    let drawn = 0, weighted = 0
    while (c > 0 && q.length) {
      const lot = q[0], take = Math.min(c, lot.c)
      weighted += take * days(lot.date, t.occurred_on)
      drawn += take; c -= take; lot.c -= take
      if (lot.c === 0) q.shift()
    }
    if (drawn > 0) ages.push(weighted / drawn)
  }
  const last = ages.slice(-sample)
  return last.length ? Math.round(last.reduce((s, a) => s + a, 0) / last.length) : null
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
export function rollup(cats, assigns, history, ms, snoozed = null) {
  const acc = new Map(cats.map(c => [c.id, { assigned: 0, activity: 0, available: 0, spent: 0 }]))
  const parents = splitParentIds(history)
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
    if (parents.has(t.id)) continue           // container row; its children carry the money
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

  // Targets pass: now that every category's cumulative Available is known, give
  // each one its needed-this-month and a verdict. Everything downstream (the pill
  // colour, Cost to Be Me, the fill-to-target auto-assign) reads these instead of
  // recomputing, so there is one place the target math lives.
  for (const c of cats) {
    const e = acc.get(c.id)
    e.needed = targetNeeded(c, e.available, ms)
    e.snoozed = snoozed ? snoozed.has(c.id) : false
    e.status = envStatus(e.available, e.needed, e.snoozed)
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

  const occ = (r, ms) => recurringOccurrences(r, ms).join(',')
  eq(occ({ cadence: 'monthly', day_of_month: 15 }, '2026-07-01'), '2026-07-15', 'monthly lands once on its day')
  eq(occ({ cadence: 'monthly', day_of_month: 31 }, '2026-02-01'), '2026-02-28', 'monthly clamps the day to month end')
  eq(occ({ cadence: 'weekly', day_of_week: 1 }, '2026-07-01'), '2026-07-06,2026-07-13,2026-07-20,2026-07-27', 'weekly hits every matching weekday (Mondays)')
  eq(occ({ cadence: 'weekly', day_of_week: null }, '2026-07-01'), '', 'weekly with no weekday lands nowhere')
  // Anchored on created_at month 2026-07: every 3rd month is Jul, Oct, ...
  eq(occ({ cadence: 'every_n', interval_months: 3, day_of_month: 1, created_at: '2026-07-10' }, '2026-07-01'), '2026-07-01', 'every_n fires on its anchor month')
  eq(occ({ cadence: 'every_n', interval_months: 3, day_of_month: 1, created_at: '2026-07-10' }, '2026-08-01'), '', 'every_n skips a between month')
  eq(occ({ cadence: 'every_n', interval_months: 3, day_of_month: 1, created_at: '2026-07-10' }, '2026-10-01'), '2026-10-01', 'every_n fires again one interval on')
  eq(occ({ cadence: 'every_n', interval_months: 2, day_of_month: 1, created_at: '2026-07-10' }, '2026-06-01'), '', 'every_n never fires before it was created')

  // Rules: case-insensitive substring, first (highest-priority) match wins.
  const RULES = [{ match: 'Amazon Prime', category_id: 'sub' }, { match: 'amazon', category_id: 'shop', flag: 'blue' }, { match: 'metro', category_id: 'grocery' }]
  eq(matchRule('AMAZON PRIME renewal', RULES)?.category_id, 'sub', 'more specific rule wins when it is listed first')
  eq(matchRule('amazon.ca order', RULES)?.category_id, 'shop', 'substring match, case-insensitive')
  eq(matchRule('Metro groceries', RULES)?.flag, undefined, 'matched rule with no flag has no flag')
  eq(matchRule('paycheque', RULES), null, 'no rule matches')
  eq(matchRule('', RULES), null, 'blank description matches nothing')
  eq(matchRule('anything', [{ match: '', category_id: 'x' }]), null, 'a blank match never matches')
  // Payee memory: most-recent exact-description category; history is newest-first.
  const HIST = [
    { description: 'Metro', category_id: 'g2', occurred_on: '2026-07-10' },
    { description: 'metro', category_id: 'g1', occurred_on: '2026-06-10' },
    { description: 'Split total', category_id: null, parent_id: undefined, occurred_on: '2026-07-01' }
  ]
  eq(lastCategoryFor('METRO', HIST), 'g2', 'payee memory returns the most recent exact match, case-insensitive')
  eq(lastCategoryFor('Unknown', HIST), null, 'payee memory: nothing for an unseen payee')
  eq(lastCategoryFor('Metro', [{ description: 'Metro', category_id: null }]), null, 'payee memory skips uncategorized rows')
  // Retro-apply: only uncategorized non-parent expenses, mapped through the rules.
  const RTX = [
    { id: 't1', description: 'Amazon order', category_id: null, kind: 'expense' },
    { id: 't2', description: 'Amazon order', category_id: 'already', kind: 'expense' },
    { id: 't3', description: 'Metro', category_id: null, kind: 'expense', flag: 'red' },
    { id: 't4', description: 'Paycheque', category_id: null, kind: 'income' },
    { id: 't5', description: 'Amazon', category_id: null, kind: 'expense', parent_id: 'p' }
  ]
  const ra = retroApply(RTX, RULES)
  eq(ra.length, 2, 'retro-apply hits only uncategorized non-parent expenses that match a rule')
  eq(ra[0].id, 't1', 'first change is the uncategorized Amazon row')
  eq(ra[0].flag, 'blue', 'rule flag fills a blank flag')
  eq(ra[1].flag, 'red', 'an existing flag is kept, not stomped')

  // Net worth: latest snapshot on/before the month, assets minus liabilities,
  // carry-forward, archived excluded.
  const ACC = [{ id: 'chk', name: 'Checking', kind: 'asset' }, { id: 'card', name: 'Visa', kind: 'liability' }, { id: 'old', name: 'Closed', kind: 'asset', archived: true }]
  const SNAP = [
    { account_id: 'chk',  month: '2026-06-01', balance_cents: 500000 },
    { account_id: 'chk',  month: '2026-07-01', balance_cents: 550000 },
    { account_id: 'card', month: '2026-06-01', balance_cents: 120000 },
    { account_id: 'old',  month: '2026-07-01', balance_cents: 999999 }
  ]
  const nw = netWorthAt(ACC, SNAP, '2026-07-01')
  eq(nw.assets, 550000, 'net worth assets use the latest snapshot on/before the month')
  eq(nw.liabilities, 120000, 'liability carried forward from June (no July entry)')
  eq(nw.net, 430000, 'net = assets − liabilities, archived excluded')
  eq(nw.rows.find(r => r.id === 'card').stale, true, 'a carried-forward account reads stale')
  eq(nw.rows.find(r => r.id === 'chk').stale, false, 'an account updated this month is not stale')
  eq(nw.rows.some(r => r.id === 'old'), false, 'an archived account is excluded')
  eq(netWorthAt(ACC, SNAP, '2026-05-01').net, 0, 'before any snapshot, net worth is zero')
  const nser = netWorthSeries(ACC, SNAP, ['2026-06-01', '2026-07-01'])
  eq(nser[0].net, 380000, 'June net = 500000 − 120000')
  eq(nser[1].net, 430000, 'July net = 550000 − 120000 (checking updated)')

  const SP = [
    { category_id: 'g', kind: 'expense', amount: 10, occurred_on: '2026-06-15' },
    { category_id: 'g', kind: 'expense', amount: 5,  occurred_on: '2026-07-02' },
    { category_id: 'g', kind: 'income',  amount: 3,  occurred_on: '2026-06-20' },
    { category_id: 'f', kind: 'expense', amount: 9,  occurred_on: '2026-06-10' }
  ]
  eq(sumSpentInRange(SP, 'g', '2026-06-01', '2026-06-30'), 1000, 'last-month spend: only that category, that month, expenses only')

  // Spending breakdown: expenses only, grouped, largest first, null folds to one
  // Uncategorized bucket, and income never becomes a row.
  const BD = [
    { category_id: 'g', kind: 'expense', amount: 10,  occurred_on: '2026-07-02' },
    { category_id: 'g', kind: 'expense', amount: 5,   occurred_on: '2026-07-10' },
    { category_id: 'f', kind: 'expense', amount: 20,  occurred_on: '2026-07-11' },
    { category_id: null, kind: 'expense', amount: 3,  occurred_on: '2026-07-12' },
    { category_id: 'g', kind: 'income',  amount: 999, occurred_on: '2026-07-13' }
  ]
  const bd = spendingBreakdown(BD, [{ id: 'g', name: 'Groceries' }, { id: 'f', name: 'Fun' }])
  eq(bd.total, 3800, 'breakdown total is expenses only, in cents')
  eq(bd.rows.length, 3, 'income adds no row')
  eq(bd.rows[0].name, 'Fun', 'largest category first')
  eq(bd.rows[0].amount, 2000, 'fun is the single $20 expense')
  eq(bd.rows[1].name, 'Groceries', 'groceries second')
  eq(bd.rows[1].amount, 1500, 'groceries sums its two expenses')
  eq(bd.rows[2].name, 'Uncategorized', 'the null bucket is labelled Uncategorized')
  eq(bd.rows[2].amount, 300, 'uncategorized is the $3 expense')
  eq(spendingBreakdown([], []).total, 0, 'an empty month breaks down to nothing')

  // Cash flow: income and expense summed apart, net is their difference.
  const cf = cashFlow([
    { kind: 'income',  amount: 3200 },
    { kind: 'expense', amount: 1800 },
    { kind: 'expense', amount: 200 }
  ])
  eq(cf.income, 320000, 'cashflow sums income')
  eq(cf.expense, 200000, 'cashflow sums expense')
  eq(cf.net, 120000, 'net is income minus expense (a surplus)')
  eq(cashFlow([]).net, 0, 'an empty month nets zero')
  eq(cashFlow([{ kind: 'expense', amount: 50 }]).net, -5000, 'expenses with no income is a deficit')

  // Register search: substring across description, category name, flag, amount, date.
  const TM = { description: 'Metro groceries', category_id: 'g', flag: 'green', amount: 92.4, occurred_on: '2026-07-03' }
  const nameOf = id => id === 'g' ? 'Groceries' : 'Uncategorized'
  eq(txnMatches(TM, '', nameOf), true, 'an empty query matches everything')
  eq(txnMatches(TM, 'metro', nameOf), true, 'matches the description')
  eq(txnMatches(TM, 'grocer', nameOf), true, 'matches the category name (not stored on the row)')
  eq(txnMatches(TM, 'green', nameOf), true, 'matches the flag')
  eq(txnMatches(TM, '92', nameOf), true, 'matches an amount substring')
  eq(txnMatches(TM, '07-03', nameOf), true, 'matches the date')
  eq(txnMatches(TM, 'xyz', nameOf), false, 'a miss returns false')
  eq(txnMatches({ description: 'x', category_id: null, amount: 1, occurred_on: '2026-07-01' }, 'uncategorized', nameOf), true, 'an uncategorized row matches its bucket name')

  eq(envStatus(-1, 0), 'over', 'a cent in the hole is in the hole')
  eq(envStatus(5000, 0), 'ok', 'money left, no shortfall')
  eq(envStatus(2000, 1000), 'under', 'a target with a shortfall is underfunded')
  eq(envStatus(0, 0), 'none', 'never touched')
  eq(envStatus(2000, 1000, true), 'ok', 'a snoozed shortfall with money is green, not amber')
  eq(envStatus(0, 1000, true), 'none', 'a snoozed empty target is gray, not amber')
  eq(envStatus(-1, 1000, true), 'over', 'snooze never hides an actual overspend')

  // distributeSplit: blanks share the remainder, penny on the last blank; a fully
  // filled split is returned untouched even if it doesn't reconcile.
  eq(distributeSplit(10000, [3000, 0]).join(','), '3000,7000', 'one blank absorbs the rest')
  eq(distributeSplit(10000, [0, 0]).join(','), '5000,5000', 'two blanks split evenly')
  eq(distributeSplit(10001, [0, 0]).join(','), '5000,5001', 'the rounding penny lands on the last blank')
  eq(distributeSplit(10000, [4000, 6000]).join(','), '4000,6000', 'a full split passes through')
  eq(distributeSplit(10000, [8000, 0, 0]).join(','), '8000,1000,1000', 'remainder spreads over the blanks only')

  // evalAmount: the money-field calculator. Arithmetic in, Number or null out,
  // never eval.
  eq(evalAmount('5+3.50'), 8.5, 'adds')
  eq(evalAmount('12*2'), 24, 'multiplies')
  eq(evalAmount('(4+6)/2'), 5, 'parens and precedence')
  eq(evalAmount('10 - 1.5'), 8.5, 'spaces are fine')
  eq(evalAmount('42'), 42, 'a plain number passes through')
  eq(evalAmount(''), null, 'empty is null')
  eq(evalAmount('5+'), null, 'a dangling operator is null, not a throw')
  eq(evalAmount('alert(1)'), null, 'letters are refused — no code runs')
  eq(evalAmount('1;2'), null, 'a stray token is refused')

  // Splits: a parent (the container) plus children that carry the categories. The
  // parent's amount must never be counted — only the children.
  const SPLIT = [
    { id: 'p', category_id: null, kind: 'expense', amount: 100, occurred_on: '2026-07-05' },
    { id: 'c1', parent_id: 'p', category_id: 'g', kind: 'expense', amount: 70, occurred_on: '2026-07-05' },
    { id: 'c2', parent_id: 'p', category_id: 'f', kind: 'expense', amount: 30, occurred_on: '2026-07-05' },
    { id: 'i',  category_id: null, kind: 'income', amount: 500, occurred_on: '2026-07-01' }
  ]
  const sroll = rollup([{ id: 'g' }, { id: 'f' }], [], SPLIT, '2026-07-01')
  eq(sroll.cats.get('g').available, -7000, 'a split child hits its own category')
  eq(sroll.cats.get('f').available, -3000, 'the other child hits the other category')
  eq(sroll.rta, 50000, 'the split parent is not counted as uncategorized spend')
  const scf = cashFlow(SPLIT)
  eq(scf.expense, 10000, 'cashflow counts the children once, not parent + children')
  const sbd = spendingBreakdown(SPLIT, [{ id: 'g', name: 'Groceries' }, { id: 'f', name: 'Fun' }])
  eq(sbd.total, 10000, 'the breakdown counts the children, not the parent')
  eq(sbd.rows.length, 2, 'the parent adds no Uncategorized bucket')

  // Age of Money: FIFO income-to-expense. $100 banked on the 1st, $40 spent on the
  // 11th -> those dollars sat 10 days.
  eq(ageOfMoney([
    { id: 'a', kind: 'income',  amount: 100, occurred_on: '2026-07-01' },
    { id: 'b', kind: 'expense', amount: 40,  occurred_on: '2026-07-11' }
  ]), 10, 'age is the days money sat before it was spent')
  eq(ageOfMoney([{ id: 'a', kind: 'income', amount: 100, occurred_on: '2026-07-01' }]), null, 'no spending yet is null, not zero')

  eq(monthsLeft('2026-07-01', '2026-07-31'), 1, 'due this month is one month')
  eq(monthsLeft('2026-07-01', '2026-09-15'), 3, 'jul aug sep is three months')
  eq(monthsLeft('2026-07-01', '2026-05-01'), 1, 'a past due date floors at one month')
  eq(monthsLeft('2026-01-01', null), 1, 'no due date is one month')

  const MCAT = { target_kind: 'monthly', monthly_limit: 300 }
  eq(targetNeeded(MCAT, 20000, '2026-07-01'), 10000, 'monthly needs the refill up to target')
  eq(targetNeeded(MCAT, 30000, '2026-07-01'), 0, 'a met monthly target needs nothing')
  const DCAT = { target_kind: 'by_date', monthly_limit: 1200, target_due: '2026-09-15' }
  eq(targetNeeded(DCAT, 0, '2026-07-01'), 40000, 'by-date splits the shortfall over the months left')
  eq(targetNeeded(DCAT, 120000, '2026-07-01'), 0, 'a met by-date target needs nothing')
  eq(targetNeeded({ monthly_limit: 300 }, 0, '2026-07-01'), 0, 'a limit with no target kind is not a target')

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
  eq(jul.cats.get('g').status, 'ok', 'a funded untargeted category is green')
  eq(jul.cats.get('f').status, 'none', 'an untouched untargeted category is gray')

  // Same $300 assigned and $250 spent (Available 50), now with a $500 monthly
  // target: still 450 short, so the envelope is amber, not green.
  const TCATS = [{ id: 'g', target_kind: 'monthly', monthly_limit: 500 }]
  const tgt = rollup(TCATS, A300, JULY, '2026-07-01')
  eq(tgt.cats.get('g').needed, 45000, 'a partly-funded target still needs the rest')
  eq(tgt.cats.get('g').status, 'under', 'a target not yet met is amber')

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
