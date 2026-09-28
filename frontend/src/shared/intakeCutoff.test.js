import { describe, it, expect } from 'vitest'
import {
  DEFAULT_OPERATIONAL_COVERAGE, cloneCoverageConfig, fixedIntakeClosed, intakeLookahead, normalizeCoverageConfig,
} from './operationalCoverage'
import { analyzeScope } from './scopeAnalysis'
import { buildPlanInstance, applyPlanResult } from './staffingPlan'

// Intake cutoffs (confirmed): Blue takes no new patients from 20:00, FastTrack
// none from midnight, tool-added teams none in the last 3 h of their coverage
// unless another attending continues it. Staffing plan (operational view) only.

const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const DAY = 'Monday'
const flat = v => Array(24).fill(v)
const demand = { Main: { overall: flat(4) }, FastTrack: { overall: flat(2) }, ERU: { overall: flat(1) } }
const C = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
let seq = 0
const sh = (team, role_type, a, b, extra = {}) => ({ id: `i${seq++}`, day: DAY, team, role_type, role_detail: role_type,
  resident_level: role_type === 'Resident' ? 'PGY-3' : null, startMins: a * 60, endMins: b * 60, start_time: '', end_time: '', ...extra })
const cap = (shifts, area, h, coverage = C, customTeams = []) =>
  analyzeScope({ shifts, demand, pph: PPH, customTeams, scope: 'wholeEd', day: DAY, coverage }).hours[h].byArea[area].capacity

describe('intake cutoff configuration', () => {
  it('ships the confirmed rules', () => {
    expect(C.intakeCutoffs.teams.map(t => [t.team, t.fromHour, t.toHour])).toEqual([['Blue', 20, 7], ['FastTrack', 0, 7]])
    expect(C.intakeCutoffs.extraTeamsHoursBeforeEnd).toBe(3)
    expect(fixedIntakeClosed(C, 'Blue', DAY, 19)).toBe(false)
    expect(fixedIntakeClosed(C, 'Blue', DAY, 20)).toBe(true)
    expect(fixedIntakeClosed(C, 'FastTrack', DAY, 23)).toBe(false)
    expect(fixedIntakeClosed(C, 'FastTrack', DAY, 0)).toBe(true)
    expect(fixedIntakeClosed(C, 'Green', DAY, 22)).toBe(false)
    expect(intakeLookahead(C, 'Green')).toBe(0)
    expect(intakeLookahead(C, 'Blue')).toBe(0)
    expect(intakeLookahead(C, 'Generated Team 1')).toBe(3)
  })

  it('a configuration saved before the rules existed gets the confirmed defaults', () => {
    const old = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    delete old.intakeCutoffs
    expect(normalizeCoverageConfig(old).intakeCutoffs.teams).toHaveLength(2)
    expect(normalizeCoverageConfig({ ...old, intakeCutoffs: { teams: [], extraTeamsHoursBeforeEnd: 0 } }).intakeCutoffs.teams).toHaveLength(0)
  })
})

describe('intake cutoffs in the operational view (Staffing plan)', () => {
  const blue = [sh('Blue', 'Attending', 15, 23), sh('Blue', 'Resident', 15, 23)]

  it('Blue adds nothing against demand from 20:00; the as-scheduled view is unchanged', () => {
    expect(cap(blue, 'main', 19)).toBeCloseTo(2.1, 9)
    for (const h of [20, 21, 22]) expect(cap(blue, 'main', h)).toBe(0)
    for (const h of [20, 21, 22]) expect(cap(blue, 'main', h, null)).toBeCloseTo(2.1, 9)
  })

  it('FastTrack adds nothing from midnight', () => {
    const ft = [sh('FastTrack', 'Attending', 17, 25), sh('FastTrack', 'PA', 19, 23)]
    expect(cap(ft, 'fasttrack', 22)).toBeGreaterThan(0)
    expect(cap(ft, 'fasttrack', 0)).toBe(0)
    expect(cap(ft, 'fasttrack', 0, null)).toBeCloseTo(2.2, 9)
  })

  it('a tool-added team stops taking new patients 3 h before its coverage ends', () => {
    const teams = [{ name: 'Generated Team 1', area: 'Main', color: '#000' }]
    const g = [sh('Generated Team 1', 'Attending', 9, 17)]
    expect(cap(g, 'main', 13, C, teams)).toBeCloseTo(1.3, 9)
    for (const h of [14, 15, 16]) expect(cap(g, 'main', h, C, teams)).toBe(0)
  })

  it('…unless another attending continues that team', () => {
    const teams = [{ name: 'Generated Team 1', area: 'Main', color: '#000' }]
    const g = [sh('Generated Team 1', 'Attending', 9, 17), sh('Generated Team 1', 'Attending', 17, 25)]
    for (const h of [14, 15, 16, 20, 21]) expect(cap(g, 'main', h, C, teams)).toBeCloseTo(1.3, 9)
    for (const h of [22, 23, 0]) expect(cap(g, 'main', h, C, teams)).toBe(0)
  })

  it("the Staffing plan's new teams are scored as one pool (another new-team attending continues it)", () => {
    const pool = [{ name: 'Plan Main 1', area: 'Main', color: '#000', plannerPool: true }, { name: 'Plan Main 2', area: 'Main', color: '#111', plannerPool: true }]
    const shifts = [sh('Plan Main 1', 'Attending', 9, 17), sh('Plan Main 2', 'Attending', 17, 25)]
    for (const h of [14, 15, 16]) expect(cap(shifts, 'main', h, C, pool)).toBeCloseTo(1.3, 9)
    // Same shifts, not pooled: each team stops 3 h before its own end.
    const plain = pool.map(t => ({ ...t, plannerPool: undefined }))
    for (const h of [14, 15, 16]) expect(cap(shifts, 'main', h, C, plain)).toBe(0)
  })

  it('residents still need their attending while the team is closed to intake (supervision is unchanged)', () => {
    const { instance } = buildPlanInstance({ days: [DAY], shiftsForDay: () => blue, customTeams: [], pph: PPH, demand, scope: 'wholeEd',
      patterns: [{ start: 7, length: 8 }, { start: 15, length: 8 }, { start: 23, length: 8 }], weeklyBudgetHours: 200, coverage: C })
    const b = instance.areas.find(a => a.key === 'main').slots.find(s => s.id === 'Blue')
    for (const h of [20, 21, 22]) expect(b.minAttendings[0][h]).toBe(1)
  })
})

describe('intake cutoffs in the solver instance', () => {
  const PATTERNS = [{ start: 7, length: 8 }, { start: 15, length: 8 }, { start: 23, length: 8 }]
  const build = (shifts, customTeams = [], coverage = C) => buildPlanInstance({ days: [DAY], shiftsForDay: () => shifts, customTeams, pph: PPH, demand,
    scope: 'wholeEd', patterns: PATTERNS, weeklyBudgetHours: 200, coverage }).instance
  const slot = (inst, area, id) => inst.areas.find(a => a.key === area).slots.find(s => s.id === id)

  it('fixed windows are zero capacity rows; other hours are untouched', () => {
    const inst = build([sh('Blue', 'Resident', 15, 23)])
    const blue = slot(inst, 'main', 'Blue').capacity[0]
    expect(blue[19].some(v => v > 0)).toBe(true)
    for (const h of [20, 21, 22, 23, 0, 6]) expect(blue[h].every(v => v === 0)).toBe(true)
    const ft = slot(inst, 'fasttrack', 'FastTrack').capacity[0]
    expect(ft[23].some(v => v > 0)).toBe(true)
    expect(ft[0].every(v => v === 0)).toBe(true)
  })

  it('new-team pools and tool-added teams get the 3 h look-ahead; base teams do not', () => {
    const inst = build([sh('Optimized Team 1', 'Attending', 9, 17)], [{ name: 'Optimized Team 1', area: 'Main', color: '#000' }])
    expect(slot(inst, 'main', 'main:flex').intakeLookahead).toBe(3)
    expect(slot(inst, 'main', 'Optimized Team 1').intakeLookahead).toBe(3)
    expect(slot(inst, 'main', 'Green').intakeLookahead).toBeUndefined()
  })

  it('with the coverage rules off there are no cutoffs', () => {
    const inst = build([sh('Blue', 'Attending', 15, 23)], [], null)
    expect(slot(inst, 'main', 'Blue').capacity[0][21].some(v => v > 0)).toBe(true)
    expect(slot(inst, 'main', 'main:flex').intakeLookahead).toBeUndefined()
  })

  it("the plan's new teams are marked for pooled scoring", () => {
    const { context } = buildPlanInstance({ days: [DAY], shiftsForDay: () => [], customTeams: [], pph: PPH, demand, scope: 'main',
      patterns: PATTERNS, weeklyBudgetHours: 200, coverage: C })
    const { newTeams } = applyPlanResult({ shifts: [{ area: 'main', slot: 'main:flex', day: DAY, start: 7, length: 8 }] }, context, [])
    expect(newTeams[0].plannerPool).toBe(true)
  })
})
