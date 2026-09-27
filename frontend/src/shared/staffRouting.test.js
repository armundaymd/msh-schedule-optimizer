import { describe, it, expect } from 'vitest'
import {
  COVERAGE_MODE, DEFAULT_OPERATIONAL_COVERAGE, ERU_SCENARIO_PRESETS, WEEK_DAYS, cloneCoverageConfig, coverageGrid,
  dedicatedWindowFeasibility, effectiveShifts, eruScenarioConfig, normalizeCoverageConfig, routedShifts, routingRuleFor,
  unroutedClosedAreaShifts, validateCoverageConfig, withEruDedicatedCoverage,
} from './operationalCoverage'
import { analyzeScope } from './scopeAnalysis'
import { buildPlanInstance } from './staffingPlan'
import { buildScenarioPayload, scenarioOperationalCoverage } from './scenarioPayload'

const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const flat = v => Array(24).fill(v)
const DEMAND = { Main: { overall: flat(3) }, FastTrack: { overall: flat(0.2) }, ERU: { overall: flat(0.5) } }
const PATTERNS = [7, 9, 11, 15, 17, 23].flatMap(start => [8, 10, 12].map(length => ({ start, length })))
const C = DEFAULT_OPERATIONAL_COVERAGE
const { REQUIRED_DEDICATED, CROSS_COVERED, CLOSED } = COVERAGE_MODE

let seq = 0
const sh = (team, role_type, a, b, extra = {}) => ({
  id: `r${seq++}`, team, role_type, role_detail: role_type, resident_level: role_type === 'Resident' ? 'PGY-2' : null,
  startMins: a * 60, endMins: b * 60, start_time: `${String(a % 24).padStart(2, '0')}:00`, end_time: `${String(b % 24).padStart(2, '0')}:00`, ...extra,
})
// One Main attending overnight on Green; FastTrack's "-Green" resident and
// "-Red" PA work 23:00–07:00 / 19:00–07:00 (as in today's schedule).
function schedule(day) {
  return [
    sh('Green', 'Attending', 23, 31), sh('Red', 'Attending', 23, 31),
    sh('FastTrack', 'Attending', 17, 25),
    sh('FastTrack', 'Resident', 23, 31, { role_detail: 'EM3/4-Green', resident_level: 'PGY-3' }),
    sh('FastTrack', 'PA', 19, 31, { role_detail: 'PA-Red' }),
    sh('FastTrack', 'PA', 7, 19, { role_detail: 'PA-Prim' }),
    sh('ERU', 'Attending', 9, 17), sh('ERU', 'Attending', 17, 25), sh('ERU', 'Resident', 23, 31),
  ].map(s => ({ ...s, day }))
}
const at = (config, day, h, scope = 'wholeEd') => analyzeScope({ shifts: schedule(day), demand: DEMAND, pph: PPH, scope, day, coverage: config }).hours[h]
const noRouting = (() => { const c = cloneCoverageConfig(C); delete c.staffRouting; return c })()

describe('staff routing (team identity vs operating area)', () => {
  it('1. FastTrack "-Green"/"-Red" staff route to that Main team while FastTrack is closed', () => {
    const on = effectiveShifts(schedule('Monday'), C, 'Monday', 3)
    const res = on.find(s => s.role_detail === 'EM3/4-Green')
    const pa = on.find(s => s.role_detail === 'PA-Red')
    expect(res).toMatchObject({ team: 'Green', sourceTeam: 'FastTrack', routedArea: 'main' })
    expect(pa).toMatchObject({ team: 'Red', sourceTeam: 'FastTrack' })
    // While FastTrack is open they stay FastTrack.
    expect(effectiveShifts(schedule('Monday'), C, 'Monday', 23).find(s => s.role_detail === 'EM3/4-Green').team).toBe('FastTrack')
  })

  it('2. routing never modifies the underlying shift', () => {
    const shifts = schedule('Monday')
    const snapshot = JSON.parse(JSON.stringify(shifts))
    effectiveShifts(shifts, C, 'Monday', 3)
    analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday', coverage: C })
    expect(shifts).toEqual(snapshot)
    const listed = routedShifts(C, ['Monday'], schedule)
    expect(listed.map(x => [x.shift.role_detail, x.hours])).toEqual([['EM3/4-Green', [1, 2, 3, 4, 5, 6]], ['PA-Red', [1, 2, 3, 4, 5, 6]]])
    expect(listed[0].shift.team).toBe('FastTrack')
  })

  it('3/4. routed staff add capacity to Main only, under Main supervision rules', () => {
    const routed = at(C, 'Monday', 3), plain = at(noRouting, 'Monday', 3)
    // FastTrack loses the solo PA (1.2) and the resident: nothing left.
    expect(plain.byArea.fasttrack.capacity).toBeCloseTo(1.2, 10)
    expect(routed.byArea.fasttrack.capacity).toBe(0)
    // Main: Green = min(1 x 2.1, 1.3 + resident 1.1) = 2.1 (supervision ceiling binds);
    // Red = min(2.1, 1.3 + PA 1.2) = 2.1. Without routing each is 1.3 (own throughput).
    expect(plain.byArea.main.capacity).toBeCloseTo(2.6, 10)
    expect(routed.byArea.main.capacity).toBeCloseTo(4.2, 10)
    // No double counting: routed capacity appears in exactly one area.
    expect(routed.byArea.main.capacity + routed.byArea.fasttrack.capacity).toBeLessThan(plain.byArea.main.capacity + plain.byArea.fasttrack.capacity + 1.1 + 1.2)
    // Reclassified: not reported as unsupervised FastTrack staff any more.
    expect(plain.byArea.fasttrack.coverage.unsupervisedExtender).toBeCloseTo(1.1, 10)
    expect(routed.byArea.fasttrack.coverage.unsupervisedExtender).toBe(0)
  })

  it('5/17/18. routing moves staff, never patients', () => {
    for (let h = 0; h < 24; h++) {
      const a = at(C, 'Monday', h), b = at(noRouting, 'Monday', h), c = at(null, 'Monday', h)
      for (const area of ['main', 'fasttrack', 'eru']) {
        expect(a.byArea[area].demand).toBe(c.byArea[area].demand)
        expect(b.byArea[area].demand).toBe(c.byArea[area].demand)
      }
    }
  })

  it('6. a closed area alone moves nobody: without a rule the staff are listed as needing a decision', () => {
    const r = at(noRouting, 'Monday', 3)
    expect(r.byArea.fasttrack.coverage.mode).toBe(CLOSED)
    const shifts = schedule('Monday')
    expect(effectiveShifts(shifts, noRouting, 'Monday', 3)).toBe(shifts)
    const pending = unroutedClosedAreaShifts(noRouting, ['Monday'], schedule)
    expect(pending.map(x => x.shift.role_detail).sort()).toEqual(['EM3/4-Green', 'PA-Red'])
    expect(unroutedClosedAreaShifts(C, ['Monday'], schedule)).toEqual([])
  })

  it('7. overnight windows wrap midnight', () => {
    const c = cloneCoverageConfig(C)
    c.staffRouting = [{ fromHour: 22, toHour: 2, match: { team: 'FastTrack', roleDetailSuffix: '-Green' }, to: { area: 'main', team: 'Green' } }]
    const res = schedule('Monday').find(s => s.role_detail === 'EM3/4-Green')
    expect([23, 0, 1].map(h => !!routingRuleFor(res, c, 'Monday', h))).toEqual([true, true, true])
    expect([2, 3, 21].map(h => !!routingRuleFor(res, c, 'Monday', h))).toEqual([false, false, false])
  })

  it('8. day-specific rules apply only on their days', () => {
    const c = cloneCoverageConfig(C)
    c.staffRouting = [{ days: ['Tuesday'], fromHour: 1, toHour: 7, match: { team: 'FastTrack' }, to: { area: 'main', team: 'Blue' } }]
    const res = schedule('Tuesday').find(s => s.role_detail === 'EM3/4-Green')
    expect(routingRuleFor(res, c, 'Tuesday', 3)?.to.team).toBe('Blue')
    expect(routingRuleFor(res, c, 'Monday', 3)).toBeNull()
  })

  it('attendings are never routed; role suffix must match', () => {
    const c = cloneCoverageConfig(C)
    c.staffRouting = [{ fromHour: 0, toHour: 0, match: { team: 'FastTrack' }, to: { area: 'main', team: 'Green' } }]
    expect(routingRuleFor(schedule('Monday')[2], c, 'Monday', 0)).toBeNull()                  // FastTrack attending
    expect(routingRuleFor(schedule('Monday')[5], C, 'Monday', 3)).toBeNull()                  // PA-Prim, no suffix match
  })

  it('validates destination teams', () => {
    const c = cloneCoverageConfig(C)
    c.staffRouting = [{ fromHour: 1, toHour: 7, match: { team: 'FastTrack' }, to: { area: 'main', team: 'ERU' } }]
    expect(validateCoverageConfig(c).join()).toMatch(/not a Main team/)
    expect(validateCoverageConfig(C)).toEqual([])
  })

  it('the planner instance puts routed staff on their operating team at those hours', () => {
    const { instance } = buildPlanInstance({
      days: ['Monday'], shiftsForDay: schedule, customTeams: [], pph: PPH, demand: DEMAND, scope: 'wholeEd',
      patterns: PATTERNS, weeklyBudgetHours: 200, coverage: C,
    })
    const green = instance.areas.find(a => a.key === 'main').slots.find(s => s.id === 'Green')
    expect(green.capacity[0][3][1]).toBeCloseTo(2.1, 10)       // with the routed PGY-3
    expect(green.capacity[0][23][1]).toBeCloseTo(1.3, 10)      // FastTrack still open: resident stays FastTrack
    const ft = instance.areas.find(a => a.key === 'fasttrack').slots.find(s => s.id === 'FastTrack')
    expect(ft.capacity[0][3][0]).toBe(0)                        // solo PA routed away
  })

  it('22. without an operational config nothing is routed (backward compatible)', () => {
    const plain = analyzeScope({ shifts: schedule('Monday'), demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday' }).hours[3]
    expect(plain.byArea.main.capacity).toBeCloseTo(2.6, 10)
    expect(plain.byArea.fasttrack.capacity).toBeCloseTo(1.2, 10)
    const { instance } = buildPlanInstance({
      days: ['Monday'], shiftsForDay: schedule, customTeams: [], pph: PPH, demand: DEMAND, scope: 'wholeEd',
      patterns: PATTERNS, weeklyBudgetHours: 200,
    })
    expect(instance.areas.find(a => a.key === 'main').slots.find(s => s.id === 'Green').capacity[0][3][1]).toBeCloseTo(1.3, 10)
  })

  it('9. routing rules survive scenario save/restore', () => {
    const c = cloneCoverageConfig(C)
    c.staffRouting[0].confirmed = true
    c.staffRouting.push({ days: ['Saturday'], fromHour: 2, toHour: 6, match: { team: 'FastTrack', roleTypes: ['PA'] }, to: { area: 'main', team: 'Blue' }, label: 'x' })
    const payload = buildScenarioPayload({ schedState: { getShiftsForDay: () => [] }, pph: PPH, costRates: {}, customTeams: [], target: 'mean', operationalCoverage: c })
    const restored = scenarioOperationalCoverage(JSON.parse(JSON.stringify(payload)))
    expect(restored.staffRouting).toEqual(normalizeCoverageConfig(c).staffRouting)
    expect(restored.staffRouting[0].confirmed).toBe(true)
    expect(restored.staffRouting[2]).toMatchObject({ days: ['Saturday'], match: { team: 'FastTrack', roleTypes: ['PA'] }, to: { team: 'Blue' } })
  })
})

describe('ERU dedicated-coverage scenarios', () => {
  const modesOf = (c, day) => coverageGrid(c, 'eru', [day])[0].map(r => r.mode)
  const req = (from, to) => Array.from({ length: 24 }, (_, h) => ((from === to) || (from < to ? h >= from && h < to : h >= from || h < to)) ? REQUIRED_DEDICATED : CROSS_COVERED)

  it('10. Current ERU coverage reproduces the configured ERU windows', () => {
    const cur = eruScenarioConfig(C, 'current')
    for (const day of WEEK_DAYS) {
      expect(coverageGrid(cur, 'eru', [day])).toEqual(coverageGrid(C, 'eru', [day]).map(row => row.map((r, h) => ({ ...r, label: coverageGrid(cur, 'eru', [day])[0][h].label }))))
    }
    expect(cur.areas.eru.rules.every(r => r.basis === 'current-schedule')).toBe(true)
  })

  it('12. core daytime: weekdays 09–19, weekend 11–19, cross-covered otherwise', () => {
    const c = eruScenarioConfig(C, 'coreDaytime')
    expect(modesOf(c, 'Wednesday')).toEqual(req(9, 19))
    expect(modesOf(c, 'Sunday')).toEqual(req(11, 19))
    expect(dedicatedWindowFeasibility(c, 'eru', WEEK_DAYS, PATTERNS)).toMatchObject({ feasible: true, minHours: 66 })
  })

  it('13. extended evening enforces 09–23 — which the current shift menu cannot staff with one ERU attending', () => {
    const c = eruScenarioConfig(C, 'extendedEvening')
    expect(modesOf(c, 'Monday')).toEqual(req(9, 23))
    const fit = dedicatedWindowFeasibility(c, 'eru', WEEK_DAYS, PATTERNS)
    expect(fit.feasible).toBe(false)
    expect(fit.byDay.filter(d => !d.feasible).map(d => d.day)).toEqual(WEEK_DAYS.slice(0, 5))
    // 14 h is not a sum of 8/10/12 h shifts (one is ≤ 12 h, two are ≥ 16 h), whatever the start times:
    const anyStart = Array.from({ length: 24 }, (_, start) => [8, 10, 12].map(length => ({ start, length }))).flat()
    expect(dedicatedWindowFeasibility(c, 'eru', WEEK_DAYS, anyStart).feasible).toBe(false)
    // ... while a 7 h shift length would make it representable.
    expect(dedicatedWindowFeasibility(c, 'eru', WEEK_DAYS, [...PATTERNS, { start: 9, length: 7 }, { start: 16, length: 7 }]).feasible).toBe(true)
  })

  it('14. 24/7 needs 168 ERU attending-hours and the menu can staff it', () => {
    const c = eruScenarioConfig(C, 'allDay')
    for (const day of WEEK_DAYS) expect(modesOf(c, day).every(m => m === REQUIRED_DEDICATED)).toBe(true)
    const fit = dedicatedWindowFeasibility(c, 'eru', WEEK_DAYS, PATTERNS)
    expect(fit).toMatchObject({ feasible: true, minHours: 168 })
  })

  it('scenarios keep every other rule (Main, FastTrack, routing, credit, ERU maximum) and ERU demand', () => {
    for (const key of Object.keys(ERU_SCENARIO_PRESETS)) {
      const c = eruScenarioConfig(C, key)
      expect(c.areas.main).toEqual(normalizeCoverageConfig(C).areas.main)
      expect(c.areas.fasttrack).toEqual(normalizeCoverageConfig(C).areas.fasttrack)
      expect(c.staffRouting).toEqual(normalizeCoverageConfig(C).staffRouting)
      expect(c.areas.eru.maxAttendings).toBe(1)
      expect(c.areas.eru.crossCoverCredit).toEqual(C.areas.eru.crossCoverCredit)
      expect(validateCoverageConfig(c)).toEqual([])
      const { instance } = buildPlanInstance({
        days: ['Monday'], shiftsForDay: schedule, customTeams: [], pph: PPH, demand: DEMAND, scope: 'wholeEd',
        patterns: PATTERNS, weeklyBudgetHours: 624, coverage: c,
      })
      expect(instance.areas.find(a => a.key === 'eru').demand[0]).toEqual(flat(0.5))
      expect(instance.areas.find(a => a.key === 'fasttrack').demand[0]).toEqual(flat(0.2))
      expect(JSON.stringify(instance)).not.toMatch(/esi/i)
    }
  })

  it('custom windows, exceptions and outside mode', () => {
    const c = withEruDedicatedCoverage(C, {
      weekday: { fromHour: 9, toHour: 21 }, weekend: null, name: 'custom',
      exceptions: [{ days: ['Friday'], fromHour: 9, toHour: 1 }], outside: COVERAGE_MODE.FLEXIBLE,
    })
    expect(modesOf(c, 'Monday')[20]).toBe(REQUIRED_DEDICATED)
    expect(modesOf(c, 'Monday')[22]).toBe(COVERAGE_MODE.FLEXIBLE)
    expect(modesOf(c, 'Friday')[0]).toBe(REQUIRED_DEDICATED)
    expect(modesOf(c, 'Saturday').every(m => m === COVERAGE_MODE.FLEXIBLE)).toBe(true)
    // 20. survives save/restore
    const payload = buildScenarioPayload({ schedState: { getShiftsForDay: () => [] }, pph: PPH, costRates: {}, customTeams: [], target: 'mean', operationalCoverage: c })
    const restored = scenarioOperationalCoverage(JSON.parse(JSON.stringify(payload)))
    for (const day of WEEK_DAYS) expect(modesOf(restored, day)).toEqual(modesOf(c, day))
  })
})
