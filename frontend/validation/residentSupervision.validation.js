// Resident supervision, end to end with the real CP-SAT solver: the planner
// may never leave a resident on a team with no supervising attending, in any
// planning mode; residents never move; routed residents are supervised on
// their operating team; an impossible budget is reported, not broken.
import { describe, expect, it } from 'vitest'
import { shiftCoversHour, attendingCountForTeam, teamArea } from '../src/shared/capacity'
import { DEFAULT_OPERATIONAL_COVERAGE, attendingsInArea, crossCoverApplies, cloneCoverageConfig, effectiveShifts, resolveCoverage } from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { planAndScore, runFrontier } from '../src/shared/attendingPlanner'
import { planPatterns } from '../src/v3/utils/patterns'
import { solveInstance, solverAvailable } from '../analysis/solver'

const DAYS = ['Monday']
const solver = solverAvailable()
const coverage = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
const patterns = planPatterns('current', [8, 10, 12])

let seq = 0
const sh = (team, role_type, a, b, extra = {}) => ({ id: `v${seq++}`, day: 'Monday', team, role_type, role_detail: role_type,
  resident_level: role_type === 'Resident' ? 'PGY-2' : null, startMins: a * 60, endMins: b * 60, start_time: '', end_time: '', ...extra })

// Residents on every Main team at different times, a FastTrack resident routed
// to Main Green overnight, ERU residents in dedicated and cross-covered hours.
const SCHEDULE = [
  sh('Green', 'Attending', 7, 15), sh('Green', 'Resident', 7, 19), sh('Green', 'Attending', 15, 23),
  sh('Red', 'Attending', 23, 31), sh('Red', 'Resident', 23, 31, { resident_level: 'PGY-4' }),
  sh('Blue', 'Attending', 9, 17), sh('Blue', 'Resident', 11, 23, { resident_level: 'PGY-3' }), sh('Blue', 'Attending', 17, 25),
  sh('Green', 'Attending', 23, 31), sh('FastTrack', 'Resident', 23, 31, { role_detail: 'EM3/4-Green', resident_level: 'PGY-3' }),
  sh('FastTrack', 'Attending', 9, 17), sh('FastTrack', 'PA', 9, 21), sh('FastTrack', 'Attending', 17, 25),
  sh('ERU', 'Attending', 9, 17), sh('ERU', 'Attending', 17, 25), sh('ERU', 'Resident', 9, 17), sh('ERU', 'Resident', 1, 9),
]
const shiftsForDay = () => SCHEDULE
// Evening-heavy Main demand tempts the planner to move Green/Blue coverage away from their residents.
const main = Array.from({ length: 24 }, (_, h) => (h >= 17 && h < 23 ? 9 : h >= 9 && h < 17 ? 4 : 2))
const demand = { Main: { overall: main }, FastTrack: { overall: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 23 ? 3 : 0.3)) }, ERU: { overall: Array(24).fill(1) } }
const today = SCHEDULE.filter(s => s.role_type === 'Attending').reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)

function unsupervisedResidentHours(p) {
  let n = 0
  for (const d of DAYS) {
    const list = p.proposedFor(d)
    for (let h = 0; h < 24; h++) {
      const on = effectiveShifts(list, coverage, d, h)
      for (const team of new Set(on.filter(s => s.role_type === 'Resident' && shiftCoversHour(s, h)).map(s => s.team))) {
        const area = teamArea(team, p.newTeams)
        const rule = resolveCoverage(coverage, area, d, h)
        if (rule && crossCoverApplies(rule, attendingsInArea(on, p.newTeams, area, h))) { if (attendingsInArea(on, p.newTeams, rule.coveredBy, h) < 1) n++; continue }
        if (attendingCountForTeam(on, team, h) < 1) n++
      }
    }
  }
  return n
}
const nonAttending = f => DAYS.flatMap(d => f(d).filter(s => s.role_type !== 'Attending')
  .map(s => `${d}|${s.team}|${s.role_type}|${s.role_detail}|${s.resident_level}|${s.startMins}|${s.endMins}`)).sort()

async function run(inputs, budget = null, hint = []) {
  return planAndScore({
    days: DAYS, shiftsForDay, customTeams: [], pph: DEFAULT_PPH, demand, target: 'mean', scope: 'wholeEd', patterns, coverage,
    effort: 'quick', inputs, weeklyBudgetHours: budget, hint, solve: inst => solveInstance(inst),
  })
}
function checkPlan(p, budget = null) {
  expect(p.ok).toBe(true)
  expect(unsupervisedResidentHours(p)).toBe(0)
  expect(nonAttending(p.proposedFor)).toEqual(nonAttending(shiftsForDay))    // residents never move, vanish or change times
  for (let h = 0; h < 24; h++) {
    expect(p.proposedFor('Monday').filter(s => s.role_type === 'Attending' && teamArea(s.team, p.newTeams) === 'eru' && shiftCoversHour(s, h)).length).toBeLessThanOrEqual(1)
  }
  if (budget != null) expect(p.result.hours.total).toBeLessThanOrEqual(budget + 1e-9)
  expect(p.crossCheck ?? 0).toBeLessThan(0.02)
  // Green supervises the routed FastTrack resident 01:00–07:00.
  for (let h = 1; h < 7; h++) expect(attendingCountForTeam(p.proposedFor('Monday'), 'Green', h)).toBeGreaterThanOrEqual(1)
}

describe.skipIf(!solver.ok)('resident supervision with the real solver', () => {
  it('fixed budget keeps every resident supervised', async () => {
    checkPlan(await run({ planningMode: 'budget' }, today), today)
  })
  it('target coverage, maximum unmet and minimum practical keep it, as minimum-hour plans', async () => {
    for (const inputs of [{ planningMode: 'target', targetCoveragePct: 85 }, { planningMode: 'maxUnmet', maxUnmetPph: 30 }, { planningMode: 'minPractical', practicalTolerancePct: 0.5 }]) {
      const p = await run(inputs)
      checkPlan(p)
      expect(Math.abs(p.result.hours.total - p.result.planning.hoursRequired)).toBeLessThan(1e-6)
    }
  })
  it('every resource-frontier point keeps it, and the frontier never gets worse with more hours', async () => {
    const points = await runFrontier({ budgets: [today - 8, today, today + 16], solveAt: (b, hint) => run({ planningMode: 'budget' }, b, hint) })
    let prev = null
    for (const pt of points) {
      checkPlan(pt.plan, pt.budget)
      if (prev) expect(pt.plan.result.stats.objectiveValue).toBeLessThanOrEqual(prev.plan.result.stats.objectiveValue + 1e-6)
      prev = pt
    }
  })
  it('a budget below what supervision and the hard rules need is reported infeasible, not broken', async () => {
    const p = await run({ planningMode: 'budget' }, 40)
    expect(p.ok).toBe(false)
    expect(p.result.status).toBe('infeasible')
    expect(p.result.message).toMatch(/Resident supervision/)
    expect(p.result.diagnosis.requiredHours).toBeGreaterThan(40)
  })
})
