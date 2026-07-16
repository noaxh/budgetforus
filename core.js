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

// A category's expenses within [from, to] inclusive, in cents. The date window is
// the only thing here that can be quietly wrong, so it carries a selftest.
export const sumSpentInRange = (history, id, from, to) =>
  history.filter(t => t.category_id === id && t.kind === 'expense' && t.occurred_on >= from && t.occurred_on <= to)
         .reduce((s, t) => s + cents(t.amount), 0)

// ---------------------------------------------------------------- envelope

// YNAB colours Available and nothing else: red means the envelope is in the
// hole, green means it holds money, gray means it has never been touched. Amber
// is the one state we spell differently -- YNAB's means "target not met", ours
// means "funded and spent to exactly zero", because there is no targets engine.
export function envStatus(availC, assignedC, activityC) {
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
export function rollup(cats, assigns, history, ms) {
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
