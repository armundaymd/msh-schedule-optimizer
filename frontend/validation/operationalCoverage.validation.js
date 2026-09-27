// Operational coverage, end to end: config -> buildPlanInstance -> real
// OR-Tools solver (python -m staffing) -> applyPlanResult -> app analysis.
// Checks that the hard rules hold in the returned schedule and that the
// solver's capacity (incl. cross-coverage credit) matches the app's.
//   npm run validate
import { describe, expect, it } from 'vitest'
import { AREAS } from '../src/shared/areas'
import { shiftCoversHour, teamArea } from '../src/shared/capacity'
import {
  COVERAGE_MODE, CROSS_COVER_CREDIT, DEFAULT_OPERATIONAL_COVERAGE, areaMaxAttendings, cloneCoverageConfig, coverageGrid,
  dedicatedWindowFeasibility, eruScenarioConfig, withCrossCoverCredit,
} from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { applyPlanResult, buildPlanInstance, capacityCrossCheck, schedulePlanMetrics } from '../src/shared/staffingPlan'
import { planPatterns } from '../src/v3/utils/patterns'
import { loadCurrentSchedule, loadDemand } from '../analysis/realData'
import { solveInstance, solverAvailable } from '../analysis/solver'

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const solver = solverAvailable()
const PATTERNS = planPatterns('current', [8, 10, 12])

function attendingsOn(shifts, customTeams, area, h) {
  return shifts.filter(s => s.role_type === 'Attending' && teamArea(s.team, customTeams) === area && shiftCoversHour(s, h)).length
}

function run({ scope, coverage, budget, shiftsForDay, demand, lockRules = [], pph = DEFAULT_PPH, days = WEEK }) {
  const { instance, context } = buildPlanInstance({
    days, shiftsForDay, customTeams: [], pph, demand, target: 'mean', scope, patterns: PATTERNS,
    weeklyBudgetHours: budget, lockRules, coverage, effort: 'quick',
  })
  const result = solveInstance(instance)
  if (!result.hours) return { result }
  const { proposedByDay, newTeams } = applyPlanResult(result, context, [])
  const proposedFor = d => proposedByDay[d]
  const metrics = schedulePlanMetrics({ days, shiftsForDay: proposedFor, customTeams: newTeams, demand, pph, scope, target: 'mean', coverage })
  return { result, context, proposedFor, newTeams, metrics, crossCheck: capacityCrossCheck(result, metrics.week) }
}

// Every rule in `coverage` holds in the proposed schedule, for the scope's areas.
function assertRulesHold(r, coverage, scope, days = WEEK) {
  const areas = r.metrics.week.areas
  for (const area of areas) {
    const grid = coverageGrid(coverage, area, days)
    days.forEach((day, di) => {
      const shifts = r.proposedFor(day)
      const planned = shifts.filter(s => String(s.id).startsWith('plan-'))
      for (let h = 0; h < 24; h++) {
        const rule = grid[di][h]
        const n = attendingsOn(shifts, r.newTeams, area, h)
        if (rule.mode === COVERAGE_MODE.REQUIRED_DEDICATED) expect(n, `${scope} ${area} ${day} ${h}:00 required`).toBeGreaterThanOrEqual(rule.minAttendings)
        const max = areaMaxAttendings(coverage)[area]
        if (max != null) expect(n, `${scope} ${area} ${day} ${h}:00 at most ${max} at once`).toBeLessThanOrEqual(max)
        if (rule.mode === COVERAGE_MODE.CLOSED || rule.mode === COVERAGE_MODE.CROSS_COVERED) {
          expect(attendingsOn(planned, r.newTeams, area, h), `${scope} ${area} ${day} ${h}:00 ${rule.mode}`).toBe(0)
        }
      }
    })
  }
}

describe.skipIf(!solver.ok)('operational coverage — real data, end to end', () => {
  const demand = loadDemand()
  const current = loadCurrentSchedule()
  const currentFor = d => current.filter(s => s.day === d)
  const C = DEFAULT_OPERATIONAL_COVERAGE

  const RATIO = withCrossCoverCredit(C, { mode: CROSS_COVER_CREDIT.CURRENT_RATIO })
  const CUSTOM = withCrossCoverCredit(C, { mode: CROSS_COVER_CREDIT.CUSTOM, residentCreditFraction: 0.5, headroomFactor: 0.2 })
  it.each([
    ['main', 416, 'conservative', C], ['eru', 96, 'conservative', C], ['fasttrack', 112, 'conservative', C],
    ['mainEru', 512, 'conservative', C], ['wholeEd', 624, 'conservative', C],
    ['eru', 96, 'ratio', RATIO], ['wholeEd', 624, 'ratio', RATIO], ['wholeEd', 624, 'custom', CUSTOM],
  ])('12/13. %s at today\'s %i h, %s credit: every rule holds, budget respected, solver = app capacity', (scope, budget, _m, cov) => {
    const r = run({ scope, coverage: cov, budget, shiftsForDay: currentFor, demand })
    expect(['optimal', 'feasible']).toContain(r.result.status)
    expect(r.result.hours.total).toBeLessThanOrEqual(budget + 1e-9)
    assertRulesHold(r, cov, scope)
    expect(r.crossCheck).toBeLessThan(0.02)
  }, 120_000)

  it('ERU flexible 24/7 with a large budget: still never two ERU attendings at once', () => {
    const flex = cloneCoverageConfig(C)
    flex.areas.eru.default = { mode: COVERAGE_MODE.FLEXIBLE }
    flex.areas.eru.rules = []
    const r = run({ scope: 'eru', coverage: flex, budget: 400, shiftsForDay: currentFor, demand })
    assertRulesHold(r, flex, 'eru')
    for (const d of WEEK) for (let h = 0; h < 24; h++) expect(attendingsOn(r.proposedFor(d), r.newTeams, 'eru', h)).toBeLessThanOrEqual(1)
  }, 120_000)

  // ERU dedicated-coverage scenarios, Whole ED at 624 h.
  const nonAttending = f => WEEK.flatMap(d => f(d).filter(s => s.role_type !== 'Attending')
    .map(s => `${d}|${s.team}|${s.role_type}|${s.role_detail}|${s.startMins}|${s.endMins}`)).sort()
  it.each(['current', 'coreDaytime', 'allDay'])('ERU scenario %s: rules hold, ERU ≤ 1, budget kept, residents fixed, solver = app', key => {
    const cov = eruScenarioConfig(C, key)
    expect(dedicatedWindowFeasibility(cov, 'eru', WEEK, PATTERNS).feasible).toBe(true)
    const r = run({ scope: 'wholeEd', coverage: cov, budget: 624, shiftsForDay: currentFor, demand })
    expect(['optimal', 'feasible']).toContain(r.result.status)
    expect(r.result.hours.total).toBeLessThanOrEqual(624 + 1e-9)
    assertRulesHold(r, cov, 'wholeEd')
    expect(nonAttending(r.proposedFor)).toEqual(nonAttending(currentFor))
    expect(r.crossCheck).toBeLessThan(0.02)
    if (key === 'allDay') expect(r.metrics.operational.eru.hoursDedicated).toBe(168)
  }, 180_000)

  it('ERU scenario extendedEvening (09–23 weekdays): refused, never silently violated', () => {
    const cov = eruScenarioConfig(C, 'extendedEvening')
    expect(dedicatedWindowFeasibility(cov, 'eru', WEEK, PATTERNS).feasible).toBe(false)
    const r = run({ scope: 'wholeEd', coverage: cov, budget: 624, shiftsForDay: currentFor, demand })
    expect(r.result.status).toBe('infeasible')
    expect(r.result.shifts ?? []).toEqual([])
  }, 180_000)

  it('10. a budget below the required coverage is refused with the numbers', () => {
    const r = run({ scope: 'wholeEd', coverage: C, budget: 200, shiftsForDay: currentFor, demand })
    expect(r.result.status).toBe('infeasible')
    expect(r.result.diagnosis.requiredHours).toBeGreaterThan(200)
    expect(r.result.diagnosis.availableHours).toBe(200)
    expect(Object.keys(r.result.diagnosis.byArea).sort()).toEqual(['eru', 'main'])
    expect(r.result.message).toMatch(/Current ERU dedicated coverage/)
  }, 120_000)

  it('11. locked shifts are kept and still count, with coverage rules on', () => {
    const lockRules = [{ area: 'eru', fromHour: 17, toHour: 18 }]
    const r = run({ scope: 'wholeEd', coverage: C, budget: 624, shiftsForDay: currentFor, demand, lockRules })
    expect(r.result.hours.locked).toBe(5 * 8)    // the five weekday 17:00–01:00 ERU shifts
    for (const d of WEEK.slice(0, 5)) {
      expect(r.proposedFor(d).some(s => s.team === 'ERU' && s.role_type === 'Attending' && s.startMins === 17 * 60)).toBe(true)
    }
    assertRulesHold(r, C, 'wholeEd')
  }, 120_000)
})

describe.skipIf(!solver.ok)('operational coverage — synthetic', () => {
  let seq = 0
  const sh = (team, role_type, a, b) => ({ id: `v${seq++}`, team, role_type, resident_level: role_type === 'Resident' ? 'PGY-2' : null, startMins: a * 60, endMins: b * 60, start_time: '', end_time: '' })
  const flat = v => Array(24).fill(v)
  const days = ['Monday']
  const base = [
    sh('Green', 'Attending', 7, 15), sh('Green', 'Attending', 15, 23), sh('Green', 'Attending', 23, 31),
    sh('Green', 'Resident', 7, 19),
    sh('ERU', 'Attending', 9, 17), sh('ERU', 'Attending', 17, 25),
    sh('ERU', 'Resident', 7, 15), sh('ERU', 'Resident', 15, 23), sh('ERU', 'Resident', 23, 31),
  ]
  const shiftsForDay = () => base.map(s => ({ ...s, day: 'Monday' }))
  // ERU overnight FLEXIBLE with Main fallback: the optimizer decides. Uses
  // the ceiling-ratio credit ASSUMPTION so cross-cover has some value.
  const flexNight = withCrossCoverCredit(DEFAULT_OPERATIONAL_COVERAGE, { mode: CROSS_COVER_CREDIT.CURRENT_RATIO })
  flexNight.areas.eru.default = { mode: COVERAGE_MODE.FLEXIBLE, coveredBy: 'main' }

  function eruNightHours(eruDemand) {
    // Quiet Main (1.0/hr): one Main attending has 1.1 of headroom = 0.42 ERU-patients/hr of cross-cover.
    const demand = { Main: { overall: flat(1) }, FastTrack: { overall: flat(0) }, ERU: { overall: eruDemand } }
    const r = run({ scope: 'mainEru', coverage: flexNight, budget: 64, shiftsForDay, demand, days })
    expect(['optimal', 'feasible']).toContain(r.result.status)
    assertRulesHold(r, flexNight, 'mainEru', days)
    expect(r.crossCheck).toBeLessThan(0.02)
    const shifts = r.proposedFor('Monday')
    // 01:00–06:59 only: at 07–08 an ERU day shift starting early is a tie
    // (the 07:00 resident gives the same 0.8 either way).
    return [1, 2, 3, 4, 5, 6].filter(h => attendingsOn(shifts, r.newTeams, 'eru', h) > 0).length
  }

  it('3. flexible ERU overnight: no dedicated attending when Main cross-cover suffices', () => {
    expect(eruNightHours(flat(0.3))).toBe(0)
  }, 60_000)

  it('3. flexible ERU overnight: a dedicated attending when ERU demand outruns cross-cover', () => {
    // 1.6/hr overnight: cross-cover (0.42) leaves most of it unmet; an ERU attending (0.8) does better.
    const d = flat(0.3).map((v, h) => (h >= 1 && h < 9 ? 1.6 : v))
    expect(eruNightHours(d)).toBeGreaterThan(0)
  }, 60_000)

  it('covers every area key only once in the cross-cover list', () => {
    const { instance } = buildPlanInstance({
      days, shiftsForDay, customTeams: [], pph: DEFAULT_PPH, demand: { Main: { overall: flat(2) } }, scope: 'wholeEd',
      patterns: PATTERNS, weeklyBudgetHours: 64, coverage: flexNight,
    })
    const keys = instance.crossCover.map(c => c.area)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every(k => AREAS.includes(k))).toBe(true)
  })
})
