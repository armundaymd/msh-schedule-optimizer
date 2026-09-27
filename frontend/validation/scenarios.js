// Synthetic validation scenarios with outcomes known in advance.
//
// Each scenario: input, a plain-language expected behaviour, which engines
// it applies to, and machine checks of that expectation:
//   must(...)   operational/mathematical requirement — failing = FAIL
//   should(...) optimality/quality expectation — failing = SUBOPTIMAL
// Engine applicability:
//   'run'        expectation applies as written
//   'limitation' engine runs, but a documented modelling assumption means
//                it is EXPECTED to diverge; divergence = LIMITATION, while
//                every invariant must still hold
//   'na'         feature not supported by that engine (reported N/A)

import { shiftCoversHour, teamCapacity } from '../src/shared/capacity'
import { DEFAULT_PPH } from '../src/shared/pph'
import { DEFAULT_PATTERNS, anyStartPatterns } from '../src/v3/utils/patterns'
import { measure, totals } from './invariants'

const DAYS = ['Monday']
const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// Attendings working alone deliver exactly their ceiling, so the
// generator's "attending x ceiling" model and the app's capacity agree —
// isolates schedule STRUCTURE from the supervision model.
const SIMPLE_PPH = {
  main: 2, mainOwn: 2, fasttrack: 3, fasttrackOwn: 3, eru: 1, eruOwn: 1,
  pa: 1, fasttrackPa: 0, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const GRID8 = [{ start: 0, length: 8 }, { start: 8, length: 8 }, { start: 16, length: 8 }]
const ANY_8_12 = [...anyStartPatterns(8), ...anyStartPatterns(12)]

function series(value = 0, hours = []) {
  const s = Array(24).fill(0)
  for (const h of hours) s[((h % 24) + 24) % 24] = value
  return s
}
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i) // [a, b)
const add = (...xs) => xs.reduce((acc, s) => acc.map((v, h) => v + s[h]), Array(24).fill(0))

let seq = 0
function sh(team, role_type, startH, endH, resident_level = null) {
  const startMins = startH * 60, endMins = endH * 60
  return { team, role_type, role_detail: resident_level ?? role_type, resident_level, startMins, endMins, start_time: hhmm(startMins), end_time: hhmm(endMins) }
}

export function makeScenario(def) {
  const demandSeries = def.demand
  const demandJson = {
    Main: { overall: demandSeries.main ?? series() },
    FastTrack: { overall: demandSeries.fasttrack ?? series() },
    ERU: { overall: demandSeries.eru ?? series() },
  }
  const current = def.current ?? []
  return {
    days: DAYS, customTeams: [], lockRules: [], minRules: [], budget: null, pph: SIMPLE_PPH,
    ...def,
    demandSeries: { main: demandSeries.main ?? series(), fasttrack: demandSeries.fasttrack ?? series(), eru: demandSeries.eru ?? series() },
    demandJson,
    currentFor: day => current.map((s, i) => ({ ...s, day, id: `cur-${day}-${i}-${seq++}` })),
  }
}

// ── expectation helpers ─────────────────────────────────────────────────────
const must = (name, pass, detail = '') => ({ level: 'must', name, pass: !!pass, detail })
const should = (name, pass, detail = '') => ({ level: 'should', name, pass: !!pass, detail })
const shiftsList = gen => gen.map(s => `${s.team} ${s.start_time}-${s.end_time}`).join(', ') || 'none'
const sig = gen => gen.map(s => `${s.startMins / 60}+${(s.endMins - s.startMins) / 60}`).sort().join(' ')

function exactly(ctx, expected, level = must) {
  const want = expected.map(([st, len]) => `${st}+${len}`).sort().join(' ')
  return level(`Generated shifts are exactly ${expected.map(([st, len]) => `${String(st).padStart(2, '0')}:00+${len}h`).join(', ')}`,
    sig(ctx.gen) === want, `got ${shiftsList(ctx.gen)}`)
}
const noDeficit = (ctx, level = must) => level('No unmet demand in any area-hour', ctx.t.deficit < 1e-9, `unmet ${ctx.t.deficit.toFixed(2)} patient-hours`)
const hoursEq = (ctx, n, level = must) => level(`Total generated hours = ${n}`, Math.abs(ctx.hours - n) < 1e-9, `got ${ctx.hours} h`)
function capAt(ctx, area, h) {
  return teamCapacity(ctx.run.schedule.Monday, ctx.sc.pph, ctx.run.customTeams, area, h)
}
function minimal(ctx, level = should) {
  // Removing any single generated shift must make coverage worse (or break a
  // minimum-coverage rule) — otherwise hours were wasted.
  const wasted = ctx.gen.filter(g => {
    const without = { Monday: ctx.run.schedule.Monday.filter(s => s !== g && s.id !== g.id) }
    const t = totals(measure(ctx.sc, without, ctx.run.customTeams))
    const minBroken = ctx.sc.minRules.some(r => range(0, 24).some(h => without.Monday.filter(s => s.role_type === 'Attending' && ctx.areaOf(s.team) === r.area && shiftCoversHour(s, h)).length < r.min))
    return t.deficit <= ctx.t.deficit + 1e-9 && !minBroken
  })
  return level('No generated shift can be removed without losing coverage (no wasted hours)', wasted.length === 0,
    wasted.length ? `removable: ${shiftsList(wasted)}` : `${ctx.gen.length} shift(s), all needed`)
}

export const SCENARIOS = [
  makeScenario({
    id: 'S01', title: 'Constant demand needing one attending for exactly one allowed shift',
    scope: 'main', demand: { main: series(2, range(8, 16)) }, patterns: GRID8,
    expected: 'Main demand is 2.0/hr from 08:00-16:00 and one attending covers exactly 2.0/hr. Exactly one 08:00-16:00 shift: 8 h, no deficit, no excess.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [exactly(ctx, [[8, 8]]), hoursEq(ctx, 8), noDeficit(ctx), must('No excess capacity', ctx.t.surplus < 1e-9, `surplus ${ctx.t.surplus.toFixed(2)}`)],
  }),
  makeScenario({
    id: 'S02', title: 'Constant demand needing two simultaneous attendings',
    scope: 'main', demand: { main: series(4, range(8, 16)) }, patterns: GRID8,
    expected: 'Demand 4.0/hr from 08:00-16:00 = two attendings at once. Two 08:00-16:00 shifts on different teams: 16 h, no deficit, no excess.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [exactly(ctx, [[8, 8], [8, 8]]), hoursEq(ctx, 16), noDeficit(ctx),
      must('The two attendings are on different teams', new Set(ctx.gen.map(s => s.team)).size === 2, shiftsList(ctx.gen))],
  }),
  makeScenario({
    id: 'S03', title: 'Demand increasing partway through the day',
    scope: 'main', demand: { main: add(series(2, range(8, 16)), series(4, range(16, 24))) }, patterns: GRID8,
    expected: '2.0/hr from 08:00-16:00, then 4.0/hr from 16:00-24:00. One 08-16 shift and two 16-24 shifts: 24 h, no deficit, no excess.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [exactly(ctx, [[8, 8], [16, 8], [16, 8]]), hoursEq(ctx, 24), noDeficit(ctx)],
  }),
  makeScenario({
    id: 'S04', title: 'Demand decreasing partway through the day',
    scope: 'main', demand: { main: add(series(4, range(8, 16)), series(2, range(16, 24))) }, patterns: GRID8,
    expected: '4.0/hr from 08:00-16:00, then 2.0/hr from 16:00-24:00. Two 08-16 shifts and one 16-24 shift: 24 h, no deficit.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [exactly(ctx, [[8, 8], [8, 8], [16, 8]]), hoursEq(ctx, 24), noDeficit(ctx)],
  }),
  makeScenario({
    id: 'S05', title: 'Overnight demand crossing midnight',
    scope: 'main', demand: { main: series(2, [22, 23, 0, 1, 2, 3, 4, 5]) },
    patterns: [{ start: 6, length: 8 }, { start: 14, length: 8 }, { start: 22, length: 8 }],
    expected: 'Demand 2.0/hr from 22:00-06:00 only. One 22:00-06:00 shift (end past midnight, stored as 30:00), covering 22-23 AND 00-05; no deficit.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [exactly(ctx, [[22, 8]]), noDeficit(ctx),
      must('Shift is stored as crossing midnight (end 30:00) and covers 00:00-05:59', ctx.gen.length === 1 && ctx.gen[0].endMins === 30 * 60
        && [22, 23, 0, 5].every(h => shiftCoversHour(ctx.gen[0], h)) && !shiftCoversHour(ctx.gen[0], 6), shiftsList(ctx.gen))],
  }),
  makeScenario({
    id: 'S06', title: 'Demand concentrated in a short peak',
    scope: 'main', demand: { main: series(6, [12, 13]) }, patterns: ANY_8_12,
    expected: 'Demand 6.0/hr for 12:00-14:00 only. Three attendings must be on at the peak (3 x 2.0). Excess is unavoidable around it; shifts should be the shortest allowed (8 h), each covering the peak.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [noDeficit(ctx),
      must('Every generated shift covers the whole peak (12:00-13:59)', ctx.gen.every(s => shiftCoversHour(s, 12) && shiftCoversHour(s, 13)), shiftsList(ctx.gen)),
      should('Exactly 3 shifts, all 8 h (least unavoidable excess)', ctx.gen.length === 3 && ctx.hours === 24, `${ctx.gen.length} shifts, ${ctx.hours} h`)],
  }),
  makeScenario({
    id: 'S07', title: 'Resident contribution with attending supervision',
    scope: 'main', pph: DEFAULT_PPH, demand: { main: series(2.1, range(8, 16)) }, patterns: GRID8,
    current: [sh('Green', 'Resident', 8, 16, 'PGY-2')],
    expected: 'Green has a PGY-2 (0.8/hr) from 08:00-16:00 and Main demand is 2.1/hr. Alone the resident counts for nothing (no supervisor). One Green attending gives min(2.1 ceiling, 1.3 own + 0.8) = 2.1 = demand: one 08-16 attending ON GREEN, no deficit.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [
      must('Before planning, the unsupervised resident contributes 0', teamCapacity(ctx.sc.currentFor('Monday'), ctx.sc.pph, [], 'main', 10) === 0),
      exactly(ctx, [[8, 8]]), noDeficit(ctx),
      must('The attending is placed with the resident (Green)', ctx.gen.every(s => s.team === 'Green'), shiftsList(ctx.gen)),
      must('Capacity at 10:00 is exactly the 2.1 ceiling', Math.abs(capAt(ctx, 'main', 10) - 2.1) < 1e-9, `cap ${capAt(ctx, 'main', 10).toFixed(2)}`)],
  }),
  makeScenario({
    id: 'S08', title: 'Multiple residents reaching the supervision limit',
    scope: 'main', pph: DEFAULT_PPH, demand: { main: series(4.2, range(8, 16)) }, patterns: GRID8,
    current: [sh('Green', 'Resident', 8, 16, 'PGY-4'), sh('Green', 'Resident', 8, 16, 'PGY-4'), sh('Green', 'Resident', 8, 16, 'PGY-4')],
    expected: 'Green has three PGY-4s (4.2/hr of resident capacity) against 4.2/hr demand. One attending can only be responsible for 2.1/hr, so Green is capped at 2.1 however many residents it has. More attendings are needed on other teams (1.3/hr each working alone): 2.1 + 1.3 + 1.3 = 4.7 >= 4.2, so 3 attendings, 24 h, no deficit.',
    engines: { generator: { mode: 'limitation', reason: 'Documented ceiling assumption: the generator sizes every attending at the 2.1 ceiling (2 x 2.1 = 4.2 "covered") without looking at which team it lands on. Its second attending goes to Red, which has no residents, so it delivers 1.3/hr alone.' }, allocator: 'run' },
    expect: ctx => [noDeficit(ctx),
      must('Green (3 residents) is capped at the 2.1 supervision ceiling', Math.abs(
        teamCapacity(ctx.run.schedule.Monday.filter(s => s.team === 'Green'), ctx.sc.pph, [], 'main', 10) - 2.1) < 1e-9),
      must('At least 3 attendings on at 10:00', ctx.run.schedule.Monday.filter(s => s.role_type === 'Attending' && shiftCoversHour(s, 10)).length >= 3),
      should('Exactly 24 h (3 attendings x 8 h)', ctx.hours === 24, `${ctx.hours} h`)],
  }),
  makeScenario({
    id: 'S09', title: 'Fast Track extender (solo PA) behaviour',
    scope: 'fasttrack', pph: { ...DEFAULT_PPH, fasttrackPa: 1.5, fasttrackPaWithAttending: 0 },
    demand: { fasttrack: add(series(3.7, range(8, 16)), series(1.5, range(16, 20))) }, patterns: GRID8,
    current: [sh('FastTrack', 'PA', 8, 20)],
    expected: 'A FastTrack PA works 08:00-20:00 and sees 1.5/hr solo, with or without an attending. Demand is 3.7/hr 08-16 and 1.5/hr 16-20. The PA alone covers 16-20; 08-16 needs one attending (1.5 + 2.2 own = 3.7). Exactly one 08-16 attending, no deficit.',
    engines: { generator: { mode: 'limitation', reason: 'Documented assumption: the generator does not model FastTrack solo-PA capacity, so it staffs 16:00-20:00 with an attending even though the PA already covers that demand (valid, but more hours than needed).' }, allocator: 'run' },
    expect: ctx => [exactly(ctx, [[8, 8]]), noDeficit(ctx),
      should('The attending joins the existing FastTrack team (no new team when one would do)', ctx.gen.every(s => s.team === 'FastTrack'), shiftsList(ctx.gen)),
      must('At 18:00 the PA\'s solo 1.5/hr is counted (exactly 1.5 if no attending is on)', (() => {
        const on = ctx.run.schedule.Monday.some(s => s.role_type === 'Attending' && ctx.areaOf(s.team) === 'fasttrack' && shiftCoversHour(s, 18))
        const cap = capAt(ctx, 'fasttrack', 18)
        return on ? cap >= 1.5 + 2.2 - 1e-9 : Math.abs(cap - 1.5) < 1e-9
      })(), `cap ${capAt(ctx, 'fasttrack', 18).toFixed(2)}`)],
  }),
  makeScenario({
    id: 'S10', title: 'Locked/fixed shifts',
    scope: 'main', demand: { main: series(2, range(0, 24)) }, patterns: GRID8, budget: 24,
    current: [sh('Green', 'Attending', 0, 8), sh('Red', 'Attending', 8, 16)],
    lockRules: [{ area: 'main', fromHour: 22, toHour: 6 }],
    expected: 'Budget 24 h/week; Green\'s 00:00-08:00 attending is locked (starts in the 22:00-06:00 lock window); Red\'s 08:00 shift is not locked and may be re-planned. Result: the locked shift unchanged, plus 16 h covering 08-24; 24 h total, no deficit.',
    engines: { generator: { mode: 'na', reason: 'The generator has no locking; it replaces every attending shift in the area.' }, allocator: 'run' },
    expect: ctx => [
      must('Locked Green 00:00-08:00 is present unchanged', ctx.run.schedule.Monday.some(s => s.team === 'Green' && s.startMins === 0 && s.endMins === 480 && s.role_type === 'Attending')),
      must('Locked hours reported = 8', ctx.run.reported.lockedHours === 8, `${ctx.run.reported.lockedHours}`),
      must('Locked + planned = 24 h (the whole budget)', ctx.hours + 8 === 24, `${ctx.hours} planned + 8 locked`), noDeficit(ctx)],
  }),
  makeScenario({
    id: 'S10b', title: 'Locked shifts exceeding the budget',
    scope: 'main', demand: { main: series(2, range(0, 24)) }, patterns: GRID8, budget: 12,
    current: [sh('Green', 'Attending', 0, 8), sh('Red', 'Attending', 8, 16)],
    lockRules: [{ area: 'main', fromHour: 0, toHour: 0 }],
    expectStatus: 'infeasible',
    expected: 'Both current Main shifts are locked (16 h) but the budget is 12 h. No schedule can respect both, so the engine must refuse with a clear message instead of silently overspending.',
    engines: { generator: { mode: 'na', reason: 'No locking in the generator.' }, allocator: 'run' },
    expect: ctx => [must('Status is infeasible with an explanation mentioning the overrun', ctx.run.status === 'infeasible' && /exceeds/.test(ctx.run.message ?? ''), ctx.run.message)],
  }),
  makeScenario({
    id: 'S11', title: 'Insufficient staffing resources',
    scope: 'main', demand: { main: series(2, range(0, 24)) }, patterns: ANY_8_12, budget: 16,
    generator: { hourBudget: 16 },
    expected: 'Demand 2.0/hr around the clock needs 24 h, but only 16 h are available. At most 16 h may be used; the remaining 8 hours are uncovered, so unmet demand = 8 x 2.0 = 16 patient-hours (no better split exists).',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [
      must('Hours used never exceed the 16 h budget', ctx.hours <= 16 + 1e-9, `${ctx.hours} h`),
      should('Unmet demand is the unavoidable minimum, 16 patient-hours', Math.abs(ctx.t.deficit - 16) < 1e-6, `${ctx.t.deficit.toFixed(2)}`)],
  }),
  makeScenario({
    id: 'S12', title: 'Excess staffing resources',
    scope: 'main', demand: { main: series(2, range(0, 24)) }, patterns: GRID8, budget: 100,
    generator: { hourBudget: 100 },
    expected: '100 h available but demand only needs 24 h. Exactly 24 h should be used (3 x 8 h), no deficit, and the other 76 h left unallocated. No shift should be removable without losing coverage.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [noDeficit(ctx), must('Uses no more than needed (24 h)', ctx.hours <= 24, `${ctx.hours} h`), minimal(ctx, must),
      ...(ctx.run.engine === 'allocator' ? [must('Reports 76 h unallocated', Math.abs(ctx.run.result.hours.unallocated - 76) < 1e-9, `${ctx.run.result.hours.unallocated}`)] : [])],
  }),
  makeScenario({
    id: 'S13', title: 'Combined Main + ERU (ERU surplus must not hide a Main deficit)',
    scope: 'mainEru', pph: { ...SIMPLE_PPH, eru: 4, eruOwn: 4 },
    demand: { main: series(2, range(8, 16)), eru: series(0) }, patterns: GRID8, budget: 16,
    current: [sh('ERU', 'Attending', 8, 16)], lockRules: [{ area: 'eru', fromHour: 0, toHour: 0 }],
    expected: 'ERU has a locked attending giving 4.0/hr against zero demand; Main needs 2.0/hr 08-16 and has nobody. Pooled Main + ERU looks covered (4 >= 2), but Main alone is not. Main must get an 08-16 attending, with no Main deficit.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [
      must('A Main attending covers 08:00-16:00', ctx.gen.some(s => ctx.areaOf(s.team) === 'main' && range(8, 16).every(h => shiftCoversHour(s, h))), shiftsList(ctx.gen)),
      must('Main has no unmet demand', ctx.m.main[0].every(x => x.deficit < 1e-9)), noDeficit(ctx)],
  }),
  makeScenario({
    id: 'S14', title: 'Whole ED',
    scope: 'wholeEd',
    demand: { main: series(2, range(0, 24)), fasttrack: series(3, range(8, 16)), eru: series(1, range(8, 20)) }, patterns: ANY_8_12,
    expected: 'Main 2.0/hr all day; FastTrack 3.0/hr 08-16; ERU 1.0/hr 08-20. Each area is covered by its own attendings: Main 24 h, FastTrack 8 h (one 08-16), ERU 12 h (one 08-20). 44 h total, no deficit in any area.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => {
      const byArea = a => ctx.gen.filter(s => ctx.areaOf(s.team) === a).reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)
      return [noDeficit(ctx),
        should('Hours by area are the minimum: Main 24, FastTrack 8, ERU 12', byArea('main') === 24 && byArea('fasttrack') === 8 && byArea('eru') === 12,
          `Main ${byArea('main')}, FastTrack ${byArea('fasttrack')}, ERU ${byArea('eru')}`)]
    },
  }),
  makeScenario({
    id: 'S15', title: 'Zero demand',
    scope: 'wholeEd', demand: {}, patterns: GRID8,
    expected: 'No demand anywhere and no minimum-staffing rules. No shifts, 0 h, no deficit, no excess.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [must('No shifts generated', ctx.gen.length === 0, shiftsList(ctx.gen)), noDeficit(ctx)],
  }),
  makeScenario({
    id: 'S16', title: 'Very low demand where minimum staffing dominates',
    scope: 'eru', demand: { eru: series(0.2, range(0, 24)) }, patterns: GRID8,
    minRules: [{ area: 'eru', fromHour: 0, toHour: 0, min: 1 }], generator: { minConcurrent: { eru: 1 } },
    expected: 'ERU demand is only 0.2/hr, but the rule says an ERU attending must always be on. Exactly one attending at every hour (3 x 8 h = 24 h), no deficit; the 0.8/hr surplus is within tolerance, so no excess is counted.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [hoursEq(ctx, 24),
      must('Exactly one ERU attending on at every hour', range(0, 24).every(h => ctx.run.schedule.Monday.filter(s => s.role_type === 'Attending' && ctx.areaOf(s.team) === 'eru' && shiftCoversHour(s, h)).length === 1)),
      noDeficit(ctx), must('No excess beyond tolerance', ctx.t.excess < 1e-9, `${ctx.t.excess.toFixed(2)}`)],
  }),
  makeScenario({
    id: 'S17', title: 'Restricted shift menu (today\'s start times only)',
    scope: 'main', demand: { main: series(2, range(8, 16)) }, patterns: DEFAULT_PATTERNS,
    expected: 'Only today\'s patterns are allowed (07/09/11/15/17/23:00 starts, 8 h). No allowed shift matches the 08-16 demand, so the plan must use allowed patterns only (e.g. 07-15 + 09-17, or accept an uncovered edge hour) and never invent an 08:00 start.',
    engines: { generator: 'run', allocator: 'run' },
    expect: ctx => [must('Every shift is one of the allowed patterns', ctx.gen.every(s => DEFAULT_PATTERNS.some(p => p.start * 60 === s.startMins && p.length * 60 === s.endMins - s.startMins)), shiftsList(ctx.gen))],
  }),
]
