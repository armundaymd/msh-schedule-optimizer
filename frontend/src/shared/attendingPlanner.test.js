import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PLANNER_INPUTS, diminishingReturns, frontierBudgets, frontierRows, marginalRows, planAndScore, planningFields,
  planningUnits, restorePlannerSettings, runFrontier, serializePlannerSettings,
} from './attendingPlanner'
import { buildScenarioPayload } from './scenarioPayload'
import { AREA_LABEL } from './areas'
import { teamCapacityForTeam } from './capacity'
import { getDemandSeries } from './demandSeries'
import { DEFAULT_OPERATIONAL_COVERAGE, effectiveShifts, eruScenarioConfig } from './operationalCoverage'

const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const DAYS = ['Monday', 'Tuesday']
const flat = v => Array(24).fill(v)
const DEMAND = { Main: { overall: flat(3) }, FastTrack: { overall: flat(1) }, ERU: { overall: flat(0.5) } }
const PATTERNS = [7, 9, 11, 15, 17, 23].flatMap(start => [8, 10, 12].map(length => ({ start, length })))

let seq = 0
const sh = (team, role_type, a, b, extra = {}) => ({
  id: `p${seq++}`, team, role_type, role_detail: role_type, resident_level: role_type === 'Resident' ? 'PGY-2' : null,
  startMins: a * 60, endMins: b * 60, start_time: `${String(a % 24).padStart(2, '0')}:00`, end_time: `${String(b % 24).padStart(2, '0')}:00`, ...extra,
})
const SCHEDULE = [
  sh('Green', 'Attending', 7, 15), sh('Green', 'Resident', 7, 19), sh('Red', 'Attending', 23, 31),
  sh('FastTrack', 'Attending', 9, 17), sh('FastTrack', 'PA', 9, 21),
  sh('FastTrack', 'Resident', 23, 31, { role_detail: 'EM3/4-Green', resident_level: 'PGY-3' }),
  sh('ERU', 'Attending', 9, 17), sh('ERU', 'Attending', 17, 25), sh('ERU', 'Resident', 9, 21),
]
const shiftsForDay = day => SCHEDULE.map(s => ({ ...s, day }))

// Mock solver: returns the given attending shifts (no Python needed).
const fixedSolve = shifts => instance => {
  const hours = shifts.reduce((t, s) => t + s.length, 0)
  return {
    status: 'optimal', message: '', stats: { objectiveValue: 1, relativeGap: 0 },
    hours: { budget: instance.budgetHours, total: hours, locked: 0, optimized: hours, unallocated: null },
    shifts: shifts.map(s => ({ flex: false, ...s })),
  }
}
const PLANNED = DAYS.flatMap(day => [
  { area: 'main', slot: 'Green', day, start: 7, length: 8 }, { area: 'main', slot: 'Red', day, start: 15, length: 8 },
  { area: 'main', slot: 'Blue', day, start: 23, length: 8 },
  { area: 'fasttrack', slot: 'FastTrack', day, start: 9, length: 12 },
  { area: 'eru', slot: 'ERU', day, start: 9, length: 8 }, { area: 'eru', slot: 'ERU', day, start: 17, length: 8 },
])
const coverage = eruScenarioConfig(DEFAULT_OPERATIONAL_COVERAGE, 'current')
const base = {
  days: DAYS, shiftsForDay, customTeams: [], pph: PPH, demand: DEMAND, target: 'mean', scope: 'wholeEd', patterns: PATTERNS, coverage,
}

describe('planningFields', () => {
  it('maps each planning mode to solver fields', () => {
    expect(planningFields({ planningMode: 'budget' })).toEqual({ mode: 'budget' })
    expect(planningFields({ planningMode: 'target', targetCoveragePct: 92.5, areaTargets: { main: 95, fasttrack: '', eru: null } }))
      .toEqual({ mode: 'target', targetCoverage: 0.925, areaTargetCoverage: { main: 0.95 } })
    expect(planningFields({ planningMode: 'maxUnmet', maxUnmetPph: 80, areaTargets: {} })).toEqual({ mode: 'target', maxUnmetPph: 80, areaTargetCoverage: {} })
    expect(planningFields({ planningMode: 'minPractical', practicalTolerancePct: 0.25 })).toEqual({ mode: 'min_practical', practicalTolerancePct: 0.25 })
    // The frontier is a series of fixed-budget solves.
    expect(planningFields({ planningMode: 'frontier' })).toEqual({ mode: 'budget' })
  })
})

describe('planAndScore — attending-only planning', () => {
  it('7/8/9/10: residents/PAs never move, routing and demand are untouched, no ESI', async () => {
    let seen = null
    const solve = inst => { seen = inst; return fixedSolve(PLANNED)(inst) }
    const plan = await planAndScore({ ...base, inputs: { planningMode: 'target', targetCoveragePct: 90, areaTargets: { main: 95 } }, solve })
    expect(plan.ok).toBe(true)
    // 7: every resident/PA shift is kept exactly (team, times, level).
    const nonAtt = f => DAYS.flatMap(d => f(d).filter(s => s.role_type !== 'Attending').map(s => `${d}|${s.team}|${s.role_detail}|${s.resident_level}|${s.startMins}|${s.endMins}`)).sort()
    expect(nonAtt(plan.proposedFor)).toEqual(nonAtt(shiftsForDay))
    // 8: routed FastTrack "-Green" resident counts on Green at 03:00 (FastTrack closed).
    const green = seen.areas.find(a => a.key === 'main').slots.find(s => s.id === 'Green')
    const routed = effectiveShifts(shiftsForDay('Monday'), coverage, 'Monday', 3).filter(s => s.team === 'Green' && s.role_type !== 'Attending')
    expect(routed.filter(s => s.role_detail === 'EM3/4-Green')).toHaveLength(1)
    const att = { team: 'Green', role_type: 'Attending', startMins: 180, endMins: 240 }
    expect(green.capacity[0][3][1]).toBeCloseTo(teamCapacityForTeam([...routed, att], PPH, 'main', 'Green', 3), 9)
    // 9: each area keeps its own historical demand series.
    for (const a of seen.areas) DAYS.forEach((d, i) => expect(a.demand[i]).toEqual(getDemandSeries(DEMAND, AREA_LABEL[a.key], d, 'mean')))
    // 10: nothing about ESI anywhere in the instance.
    expect(JSON.stringify(seen)).not.toMatch(/\besi\b/i)
    // Target fields reach the solver.
    expect(seen).toMatchObject({ mode: 'target', targetCoverage: 0.9, areaTargetCoverage: { main: 0.95 }, budgetHours: null })
  })

  it('13: ERU max one and the Current ERU windows reach the solver as hard structure', async () => {
    let seen = null
    await planAndScore({ ...base, inputs: { planningMode: 'minPractical', practicalTolerancePct: 0.5 }, solve: i => { seen = i; return fixedSolve(PLANNED)(i) } })
    const eru = seen.areas.find(a => a.key === 'eru')
    expect(eru.maxCoverage.every(row => row.every(v => v === 1))).toBe(true)
    expect(eru.minCoverage[0].slice(9, 24)).toEqual(Array(15).fill(1))   // Mon 09:00–01:00
    expect(eru.minCoverage[0][0]).toBe(1)
    const main = seen.areas.find(a => a.key === 'main')
    expect(main.minCoverage.every(row => row.every(v => v >= 1))).toBe(true)   // 11: Main 24/7
    const ft = seen.areas.find(a => a.key === 'fasttrack')
    expect(ft.slots.every(s => [1, 2, 3, 4, 5, 6].every(h => s.maxAttendings[0][h] === s.locked[0][h]))).toBe(true)   // 12
    expect(seen.practicalTolerancePct).toBe(0.5)
  })

  it('area targets outside the scope are dropped, not sent', async () => {
    let seen = null
    await planAndScore({ ...base, scope: 'main', inputs: { planningMode: 'target', targetCoveragePct: 90, areaTargets: { main: 95, eru: 99 } },
      solve: i => { seen = i; return fixedSolve(PLANNED.filter(s => s.area === 'main'))(i) } })
    expect(seen.areaTargetCoverage).toEqual({ main: 0.95 })
  })

  it('an infeasible result keeps the best-achievable plan for explanation', async () => {
    const solve = () => ({ status: 'infeasible', message: 'TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS: x', planning: { bestAchievablePlan: PLANNED } })
    const plan = await planAndScore({ ...base, inputs: { planningMode: 'target', targetCoveragePct: 99.9 }, solve })
    expect(plan.ok).toBe(false)
    expect(plan.bestAchievable.summary.all.coverage).toBeGreaterThan(0)
    expect(plan.bestAchievable.bottlenecks.total).toBeCloseTo(plan.bestAchievable.summary.all.unmet, 9)
  })
})

describe('resource frontier', () => {
  it('budgets: range + explicit + include, sorted and de-duplicated', () => {
    expect(frontierBudgets({ min: 600, max: 700, step: 25, explicit: '624, 650 800', include: [624] }))
      .toEqual([600, 624, 625, 650, 675, 700, 800])
    expect(frontierBudgets({ min: 600, max: 500, step: 25, explicit: [] })).toEqual([])
    expect(frontierBudgets({ min: 0, max: 1e6, step: 1 })).toHaveLength(40)
  })

  it('20: warm-starts from the previous point and never gets worse with more hours', async () => {
    const objectives = { 600: 50, 625: 60, 650: 30 }   // 625: search found worse than 600's plan
    const hints = []
    const solveAt = async (budget, hint) => {
      hints.push(hint.length)
      return { ok: true, result: { shifts: Array(budget / 25).fill({}), hours: { total: budget }, stats: { objectiveValue: objectives[budget] }, status: 'feasible' }, summary: null }
    }
    const pts = await runFrontier({ budgets: [650, 600, 625], solveAt })
    expect(pts.map(p => p.budget)).toEqual([600, 625, 650])
    expect(hints).toEqual([0, 24, 24])   // 625 and 650 warm-started from 600's plan
    expect(pts[1]).toMatchObject({ carriedForward: true, carriedFrom: 600, searchObjective: 60 })
    expect(pts[1].plan.result.stats.objectiveValue).toBe(50)
    const obj = pts.map(p => p.plan.result.stats.objectiveValue)
    for (let i = 1; i < obj.length; i++) expect(obj[i]).toBeLessThanOrEqual(obj[i - 1])
  })

  const row = (budget, unmet, main, ft, eru, coverage) => ({
    budget, feasible: true, hours: budget, unmet, coverage, unmetByArea: { main, fasttrack: ft, eru }, coverageByArea: {}, hoursByArea: {},
  })
  const rows = [row(600, 130, 60, 40, 30, 0.91), row(625, 110, 50, 32, 28, 0.924), row(650, 100, 45, 28, 27, 0.931), row(675, 97, 43, 27, 27, 0.933)]

  it('marginal benefit per step and per added attending-hour', () => {
    const m = marginalRows(rows, { noise: 4 })
    expect(m[0]).toMatchObject({ from: 600, to: 625, addedHours: 25, unmetReduction: 20, byArea: { main: 10, fasttrack: 8, eru: 2 } })
    expect(m[0].perHour).toBeCloseTo(0.8, 9)
    expect(m[0].coveragePoints).toBeCloseTo(1.4, 9)
    expect(m[2].withinNoise).toBe(true)
  })

  it('diminishing returns: facts and a descriptive knee, never a recommendation', () => {
    const d = diminishingReturns(rows)
    expect(d.facts[0].text).toBe('Adding 25 h (600 → 625) reduced modeled unmet demand by 20.0 patient-h/week (0.80 per added attending-hour)')
    expect(d.knee.budget).toBe(625)
    expect(d.flattening.at).toBe(625)
  })

  it('frontier rows mark infeasible points without inventing values', () => {
    const r = frontierRows([{ budget: 200, plan: { ok: false, result: { status: 'infeasible', message: 'rules need 264 h' } } }])
    expect(r).toEqual([{ budget: 200, feasible: false, status: 'infeasible', message: 'rules need 264 h' }])
  })
})

describe('21: FTE and cost translation', () => {
  it('uses configured values only', () => {
    expect(planningUnits(624)).toMatchObject({ weekly: 624, annual: 32448, fte: null, cost: null })
    const u = planningUnits(624, { clinicalHoursPerFte: 1600, hourlyRate: 300 })
    expect(u.fte).toBeCloseTo(32448 / 1600, 9)
    expect(u.cost).toBe(32448 * 300)
    expect(planningUnits(100, { clinicalHoursPerFte: '', hourlyRate: 0 })).toMatchObject({ fte: null, cost: null })
    expect(planningUnits(100, { weeksPerYear: 48 }).annual).toBe(4800)
  })
})

describe('23: scenario save / restore keeps the planning mode and inputs', () => {
  const defaults = {
    mode: 'budget', amount: 32448, period: 'annual', scope: 'wholeEd', target: 'mean', startMode: 'current', lengths: [8, 10, 12],
    lockRules: [], minRules: [], effort: 'standard', useCoverage: true, coverage, ...structuredClone(DEFAULT_PLANNER_INPUTS),
  }
  it('round-trips through the scenario payload', () => {
    const settings = {
      ...defaults, planningMode: 'target', targetCoveragePct: 97.5, areaTargets: { main: 95, fasttrack: 92, eru: null },
      frontier: { min: 550, max: 800, step: 50, explicit: '624' }, units: { clinicalHoursPerFte: 1500, hourlyRate: 250 },
      startMode: 'any', practicalTolerancePct: 0.25, eruScenario: { preset: 'allDay' }, ignored: 'x',
    }
    const payload = buildScenarioPayload({ schedState: { getShiftsForDay: () => [] }, pph: PPH, costRates: {}, customTeams: [], target: 'mean' })
    payload.staffingPlan = { settings: serializePlannerSettings(settings) }
    const restored = restorePlannerSettings(JSON.parse(JSON.stringify(payload)).staffingPlan.settings, defaults)
    const { ignored, ...expected } = settings
    expect(ignored).toBe('x')
    expect(restored).toEqual(expected)
  })
  it('older saved settings still open (estimate mode maps to requirement)', () => {
    const r = restorePlannerSettings({ mode: 'requirement', allowedDeficit: 0.5 }, defaults)
    expect(r).toMatchObject({ planningMode: 'requirement', mode: 'requirement', allowedDeficit: 0.5, frontier: DEFAULT_PLANNER_INPUTS.frontier })
    expect(restorePlannerSettings(null, defaults)).toEqual(defaults)
    expect(restorePlannerSettings({ planningMode: 'bogus' }, defaults).planningMode).toBe('budget')
  })
})
