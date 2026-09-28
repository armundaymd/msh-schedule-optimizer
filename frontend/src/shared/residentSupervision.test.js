import { describe, it, expect } from 'vitest'
import { buildPlanInstance } from './staffingPlan'
import { DEFAULT_OPERATIONAL_COVERAGE, cloneCoverageConfig, effectiveShifts } from './operationalCoverage'
import { teamCapacity } from './capacity'

// Resident supervision (confirmed, hard) as the planner hands it to the
// solver: each existing team slot's minAttendings[d][h] = 1 whenever a
// resident OPERATES on that team (after staff routing), except in hours the
// area is explicitly cross-covered, where the covering area must have an
// attending instead. The solver side is tested in tests/test_resident_supervision.py.

const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const flat = v => Array(24).fill(v)
const demand = { Main: { overall: flat(4) }, FastTrack: { overall: flat(2) }, ERU: { overall: flat(1) } }
const PATTERNS = [{ start: 7, length: 8 }, { start: 15, length: 8 }, { start: 23, length: 8 }]
const DAY = 'Monday'

let seq = 0
function sh(team, role_type, startH, endH, extra = {}) {
  return { id: `s${seq++}`, day: DAY, team, role_type, role_detail: role_type, resident_level: role_type === 'Resident' ? 'PGY-2' : null,
    startMins: startH * 60, endMins: endH * 60, start_time: '', end_time: '', ...extra }
}
const hours = (a, b) => Array.from({ length: 24 }, (_, h) => h).filter(h => (a <= b ? h >= a && h < b : h >= a || h < b))

function build(schedule, { scope = 'wholeEd', coverage = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE) } = {}) {
  return buildPlanInstance({
    days: [DAY], shiftsForDay: () => schedule, customTeams: [], pph: PPH, demand, scope,
    patterns: PATTERNS, weeklyBudgetHours: 200, coverage,
  }).instance
}
const slotOf = (inst, area, id) => inst.areas.find(a => a.key === area).slots.find(s => s.id === id)
const minRow = (inst, area, id) => slotOf(inst, area, id).minAttendings[0]

describe('resident supervision → minAttendings', () => {
  it('a resident on a team requires that team to have an attending while the resident works', () => {
    const inst = build([sh('Green', 'Attending', 7, 15), sh('Green', 'Resident', 7, 19)])
    const row = minRow(inst, 'main', 'Green')
    for (let h = 0; h < 24; h++) expect(row[h]).toBe(hours(7, 19).includes(h) ? 1 : 0)
  })

  it('does not ask another team (or the new-team pool) to supervise it', () => {
    const inst = build([sh('Blue', 'Resident', 9, 17), sh('Green', 'Attending', 7, 19)])
    expect(minRow(inst, 'main', 'Green').every(v => v === 0)).toBe(true)
    expect(minRow(inst, 'main', 'Blue').filter(v => v === 1)).toHaveLength(8)
    const flex = slotOf(inst, 'main', 'main:flex')
    expect(flex.minAttendings).toBeUndefined()
  })

  it('PAs/APPs do not create a supervision requirement (existing APP rules unchanged)', () => {
    const inst = build([sh('Blue', 'PA', 9, 17), sh('FastTrack', 'PA', 9, 21)])
    expect(minRow(inst, 'main', 'Blue').every(v => v === 0)).toBe(true)
    expect(minRow(inst, 'fasttrack', 'FastTrack').every(v => v === 0)).toBe(true)
  })

  it('a routed resident is supervised on its OPERATING team, never its recorded team', () => {
    // FastTrack resident "EM3/4-Green" 23:00–07:00: FastTrack until 01:00, Main Green 01:00–07:00 (confirmed routing).
    const res = sh('FastTrack', 'Resident', 23, 31, { role_detail: 'EM3/4-Green', resident_level: 'PGY-3' })
    const inst = build([res])
    const green = minRow(inst, 'main', 'Green')
    const ft = minRow(inst, 'fasttrack', 'FastTrack')
    for (const h of hours(1, 7)) { expect(green[h]).toBe(1); expect(ft[h]).toBe(0) }
    for (const h of [23, 0]) { expect(ft[h]).toBe(1); expect(green[h]).toBe(0) }
  })

  it('in explicitly cross-covered hours the covering area must have an attending instead', () => {
    // ERU is cross-covered by Main outside Mon 09:00–01:00 in the default config.
    const inst = build([sh('ERU', 'Resident', 1, 9)])
    expect(minRow(inst, 'eru', 'ERU').every(v => v === 0)).toBe(true)
    const main = inst.areas.find(a => a.key === 'main').minCoverage[0]
    for (const h of hours(1, 9)) expect(main[h]).toBeGreaterThanOrEqual(1)
    expect(inst.areas.find(a => a.key === 'main').requirementLabels.some(l => /cross-covering an area whose residents/.test(l))).toBe(true)
  })

  it('an ERU resident in ERU dedicated hours needs an ERU attending', () => {
    const inst = build([sh('ERU', 'Resident', 9, 17)])
    expect(minRow(inst, 'eru', 'ERU').filter(v => v === 1)).toHaveLength(8)
  })

  it('with the coverage rules off there is no routing and no cross-cover exemption', () => {
    const res = sh('FastTrack', 'Resident', 23, 31, { role_detail: 'EM3/4-Green' })
    const inst = build([res, sh('ERU', 'Resident', 1, 9)], { coverage: null })
    expect(minRow(inst, 'main', 'Green').every(v => v === 0)).toBe(true)
    expect(minRow(inst, 'fasttrack', 'FastTrack').filter(v => v === 1)).toHaveLength(8)
    expect(minRow(inst, 'eru', 'ERU').filter(v => v === 1)).toHaveLength(8)
  })

  it('labels the requirement so an infeasible budget can name it', () => {
    const inst = build([sh('Green', 'Resident', 7, 19)])
    expect(inst.areas.find(a => a.key === 'main').requirementLabels)
      .toContain('Resident supervision: Green needs its own attending whenever its residents work (12 team-hours/week)')
  })
})

describe('confirmed FastTrack → Main staff routing', () => {
  const c = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)

  it('is configured as a confirmed operational rule', () => {
    expect(c.staffRouting.map(r => [r.match.roleDetailSuffix, r.to.team, r.confirmed, r.basis])).toEqual([
      ['-Green', 'Green', true, 'confirmed-operational-rule'],
      ['-Red', 'Red', true, 'confirmed-operational-rule'],
    ])
  })

  it('moves the person to the Main team while FastTrack is closed, and only then', () => {
    const pa = sh('FastTrack', 'PA', 19, 31, { role_detail: 'PA-Red' })
    expect(effectiveShifts([pa], c, DAY, 3)[0]).toMatchObject({ team: 'Red', sourceTeam: 'FastTrack' })
    expect(effectiveShifts([pa], c, DAY, 23)[0].team).toBe('FastTrack')
  })

  it('a routed person adds capacity only on the operating team, and demand does not move', () => {
    const att = sh('Red', 'Attending', 23, 31)
    const pa = sh('FastTrack', 'PA', 19, 31, { role_detail: 'PA-Red' })
    const on = effectiveShifts([att, pa], c, DAY, 3)
    expect(teamCapacity(on, PPH, [], 'fasttrack', 3)).toBe(0)
    expect(teamCapacity(on, PPH, [], 'main', 3)).toBeCloseTo(Math.min(2.1, 1.3 + 1.2), 9)
    const inst = build([att, pa])
    expect(inst.areas.find(a => a.key === 'fasttrack').demand[0]).toEqual(flat(2))
    expect(inst.areas.find(a => a.key === 'main').demand[0]).toEqual(flat(4))
  })
})

describe('resident supervision in flexible hours with a covering area', () => {
  it('asks for the team attending OR no attending in the area (cross-covered), not an unconditional one', () => {
    const c = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    c.areas.eru.default = { mode: 'FLEXIBLE', coveredBy: 'main' }
    const inst = buildPlanInstance({ days: [DAY], shiftsForDay: () => [sh('ERU', 'Resident', 1, 9)], customTeams: [], pph: PPH, demand, scope: 'wholeEd',
      patterns: PATTERNS, weeklyBudgetHours: 200, coverage: c }).instance
    const eru = slotOf(inst, 'eru', 'ERU')
    for (let h = 1; h < 9; h++) { expect(eru.minAttendings[0][h]).toBe(0); expect(eru.supervisedUnlessUncovered[0][h]).toBe(1) }
    const main = inst.areas.find(a => a.key === 'main').minCoverage[0]
    for (let h = 1; h < 9; h++) expect(main[h]).toBeGreaterThanOrEqual(1)
  })
})
