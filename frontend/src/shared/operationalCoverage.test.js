import { describe, it, expect } from 'vitest'
import {
  COVERAGE_MODE, CROSS_COVER_CREDIT, DEFAULT_OPERATIONAL_COVERAGE, areaMaxAttendings, cloneCoverageConfig, coverageGrid,
  crossCoverCreditParams, crossCoverHour, effectiveMaxAttendings, normalizeCoverageConfig, operationalCoverageSummary,
  requirementLabels, resolveCoverage, validateCoverageConfig, withCrossCoverCredit,
} from './operationalCoverage'
import { applyPlanResult } from './staffingPlan'
import { buildPlanInstance, schedulePlanMetrics } from './staffingPlan'
import { analyzeScope } from './scopeAnalysis'
import { analyzeWeek } from './weekCoverage'
import { getDemandSeries } from './demandSeries'
import { buildScenarioPayload, scenarioOperationalCoverage } from './scenarioPayload'

const { REQUIRED_DEDICATED, CROSS_COVERED, CLOSED, FLEXIBLE } = COVERAGE_MODE
// The earlier 0.8/2.1 conversion, kept as an explicit ANALYSIS assumption.
const RATIO = withCrossCoverCredit(DEFAULT_OPERATIONAL_COVERAGE, { mode: CROSS_COVER_CREDIT.CURRENT_RATIO })
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const flat = v => Array(24).fill(v)
const DEMAND = { Main: { overall: flat(3) }, FastTrack: { overall: flat(2) }, ERU: { overall: flat(0.5) } }
const PATTERNS = [7, 9, 11, 15, 17, 23].flatMap(start => [8, 10, 12].map(length => ({ start, length })))

let seq = 0
function sh(team, role_type, startH, endH, extra = {}) {
  return {
    id: `s${seq++}`, team, role_type, resident_level: role_type === 'Resident' ? 'PGY-2' : null,
    startMins: startH * 60, endMins: endH * 60, start_time: '', end_time: '', ...extra,
  }
}

// A small week shaped like today's: Main 2 attendings 24/7, ERU attending
// 09:00–01:00 (weekend 11:00–19:00), ERU resident 24/7, FastTrack 09:00–01:00
// with a PA 07:00–19:00.
function schedule(day) {
  const weekend = day === 'Saturday' || day === 'Sunday'
  return [
    sh('Green', 'Attending', 7, 15), sh('Green', 'Attending', 15, 23), sh('Green', 'Attending', 23, 31),
    sh('Red', 'Attending', 7, 15), sh('Red', 'Attending', 15, 23), sh('Red', 'Attending', 23, 31),
    sh('Green', 'Resident', 7, 19),
    ...(weekend ? [sh('ERU', 'Attending', 11, 19)] : [sh('ERU', 'Attending', 9, 17), sh('ERU', 'Attending', 17, 25)]),
    sh('ERU', 'Resident', 7, 15), sh('ERU', 'Resident', 15, 23), sh('ERU', 'Resident', 23, 31),
    sh('FastTrack', 'Attending', 9, 17), sh('FastTrack', 'Attending', 17, 25),
    sh('FastTrack', 'PA', 7, 19),
  ].map(s => ({ ...s, day }))
}

function build(overrides = {}) {
  return buildPlanInstance({
    days: WEEK, shiftsForDay: schedule, customTeams: [], pph: PPH, demand: DEMAND, scope: 'wholeEd',
    patterns: PATTERNS, weeklyBudgetHours: 624, coverage: DEFAULT_OPERATIONAL_COVERAGE, ...overrides,
  })
}
const areaOf = (instance, key) => instance.areas.find(a => a.key === key)
const di = day => WEEK.indexOf(day)

describe('coverage config resolution', () => {
  const C = DEFAULT_OPERATIONAL_COVERAGE

  it('1. Main requires a dedicated attending 24/7', () => {
    for (const day of WEEK) for (let h = 0; h < 24; h++) {
      expect(resolveCoverage(C, 'main', day, h)).toMatchObject({ mode: REQUIRED_DEDICATED, minAttendings: 1 })
    }
  })

  it('15. day-specific windows: ERU core is 09–01 on weekdays and 11–19 at weekends', () => {
    expect(resolveCoverage(C, 'eru', 'Monday', 9).mode).toBe(REQUIRED_DEDICATED)
    expect(resolveCoverage(C, 'eru', 'Monday', 8).mode).toBe(CROSS_COVERED)
    expect(resolveCoverage(C, 'eru', 'Saturday', 9).mode).toBe(CROSS_COVERED)
    expect(resolveCoverage(C, 'eru', 'Saturday', 11).mode).toBe(REQUIRED_DEDICATED)
    expect(resolveCoverage(C, 'eru', 'Saturday', 19)).toMatchObject({ mode: CROSS_COVERED, coveredBy: 'main' })
  })

  it('14. overnight windows wrap midnight on the circular day template', () => {
    // 09→01 on Friday covers Friday 00:00 (the tail of Friday's 17:00–01:00 shift) ...
    expect(resolveCoverage(C, 'eru', 'Friday', 0).mode).toBe(REQUIRED_DEDICATED)
    expect(resolveCoverage(C, 'eru', 'Friday', 1).mode).toBe(CROSS_COVERED)
    // ... and a 19→07 rule covers 19–23 and 00–06 of the same day.
    const c = { version: 1, areas: { eru: { default: { mode: FLEXIBLE }, rules: [{ fromHour: 19, toHour: 7, mode: REQUIRED_DEDICATED }] } } }
    const req = Array.from({ length: 24 }, (_, h) => resolveCoverage(c, 'eru', 'Monday', h).mode === REQUIRED_DEDICATED)
    expect(req.map((v, h) => (v ? h : null)).filter(h => h != null)).toEqual([0, 1, 2, 3, 4, 5, 6, 19, 20, 21, 22, 23])
  })

  it('later rules override earlier ones; missing areas are FLEXIBLE', () => {
    const c = cloneCoverageConfig(C)
    c.areas.eru.rules.push({ fromHour: 0, toHour: 0, mode: REQUIRED_DEDICATED, minAttendings: 1 })
    expect(coverageGrid(c, 'eru', WEEK).flat().every(r => r.mode === REQUIRED_DEDICATED)).toBe(true)
    expect(resolveCoverage({ version: 1, areas: {} }, 'eru', 'Monday', 3).mode).toBe(FLEXIBLE)
  })

  it('7. FastTrack is closed 01:00–07:00 and flexible otherwise', () => {
    expect(resolveCoverage(C, 'fasttrack', 'Tuesday', 3).mode).toBe(CLOSED)
    expect(resolveCoverage(C, 'fasttrack', 'Tuesday', 7).mode).toBe(FLEXIBLE)
    expect(resolveCoverage(C, 'fasttrack', 'Tuesday', 0).mode).toBe(FLEXIBLE)
  })

  it('validates: unknown modes, self-cover, cross-cover without covering area, covering area not staffed', () => {
    expect(validateCoverageConfig(C)).toEqual([])
    expect(validateCoverageConfig({ areas: { eru: { default: { mode: 'NOPE' } } } })[0]).toMatch(/unknown mode/)
    expect(validateCoverageConfig({ areas: { eru: { default: { mode: CROSS_COVERED } } } })[0]).toMatch(/needs a covering area/)
    expect(validateCoverageConfig({ areas: { eru: { default: { mode: CROSS_COVERED, coveredBy: 'eru' } } } }).join()).toMatch(/cannot cross-cover itself/)
    const chain = { areas: { main: { default: { mode: CLOSED } }, eru: { default: { mode: CROSS_COVERED, coveredBy: 'main' } } } }
    expect(validateCoverageConfig(chain).join()).toMatch(/Main is closed then/)
  })

  it('names the hard requirements for solver messages', () => {
    expect(requirementLabels(C, 'eru')).toEqual([
      'Current ERU dedicated coverage (weekdays) — ERU Mon–Fri 09:00–01:00: ≥ 1 dedicated attending (kept from the current schedule)',
      'Current ERU dedicated coverage (weekend) — ERU Sat, Sun 11:00–19:00: ≥ 1 dedicated attending (kept from the current schedule)',
    ])
    // Nothing describes the schedule-derived window as clinically required.
    expect(JSON.stringify(C)).not.toMatch(/clinically required|core hours/i)
    expect(requirementLabels(C, 'fasttrack')).toEqual([])
  })
})

describe('16. scenario serialization', () => {
  it('round-trips the coverage config through a saved scenario payload', () => {
    const c = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    c.areas.eru.rules.push({ days: ['Friday', 'Saturday'], fromHour: 1, toHour: 9, mode: FLEXIBLE, coveredBy: 'main', label: 'ERU overnight trial' })
    c.areas.fasttrack.rules[0].toHour = 8
    const payload = buildScenarioPayload({
      schedState: { getShiftsForDay: () => [] }, pph: PPH, costRates: {}, customTeams: [], target: 'mean', operationalCoverage: c,
    })
    const restored = scenarioOperationalCoverage(JSON.parse(JSON.stringify(payload)))
    expect(restored).toEqual(normalizeCoverageConfig(c))
    expect(resolveCoverage(restored, 'eru', 'Friday', 3)).toMatchObject({ mode: FLEXIBLE, coveredBy: 'main', label: 'ERU overnight trial' })
    expect(resolveCoverage(restored, 'fasttrack', 'Monday', 7).mode).toBe(CLOSED)
  })

  it('old scenarios without a config restore as null (caller keeps its current config)', () => {
    expect(scenarioOperationalCoverage({ shifts: {} })).toBeNull()
  })

  it('normalization is idempotent and JSON-stable', () => {
    const n = normalizeCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    expect(normalizeCoverageConfig(JSON.parse(JSON.stringify(n)))).toEqual(n)
  })
})

describe('buildPlanInstance with operational coverage', () => {
  const { instance } = build()
  const main = areaOf(instance, 'main')
  const eru = areaOf(instance, 'eru')
  const ft = areaOf(instance, 'fasttrack')

  it('1/13. Main minCoverage is 1 at every hour; ERU core hours are required; whole ED respects all rules', () => {
    expect(main.minCoverage.flat().every(v => v === 1)).toBe(true)
    expect(eru.minCoverage[di('Monday')][9]).toBe(1)
    expect(eru.minCoverage[di('Monday')][0]).toBe(1)
    expect(eru.minCoverage[di('Monday')][5]).toBe(0)
    expect(eru.minCoverage[di('Sunday')][12]).toBe(1)
    expect(eru.minCoverage[di('Sunday')][20]).toBe(0)
    expect(ft.minCoverage.flat().every(v => v === 0)).toBe(true)
  })

  it('manual minimum-coverage rules still combine (max) with the operational ones', () => {
    const { instance: i } = build({ minCoverageRules: [{ area: 'main', fromHour: 10, toHour: 14, min: 2 }] })
    expect(areaOf(i, 'main').minCoverage[0][11]).toBe(2)
    expect(areaOf(i, 'main').minCoverage[0][15]).toBe(1)
  })

  it('7. cross-covered and closed hours take no new dedicated attendings', () => {
    for (const s of eru.slots) {
      expect(s.maxAttendings[di('Monday')][5]).toBe(0)
      expect(s.maxAttendings[di('Monday')][12]).toBeGreaterThan(0)
    }
    for (const s of ft.slots) {
      expect(s.maxAttendings[0][3]).toBe(0)
      expect(s.maxAttendings[0][8]).toBeGreaterThan(0)
    }
    expect(eru.coverageMode[di('Monday')][5]).toBe(CROSS_COVERED)
    expect(ft.coverageMode[0][3]).toBe(CLOSED)
  })

  it('8/9. demand is each area\'s own historical series — nothing created, deleted or re-routed', () => {
    const { instance: plain } = build({ coverage: null })
    for (const key of ['main', 'fasttrack', 'eru']) {
      expect(areaOf(instance, key).demand).toEqual(areaOf(plain, key).demand)
      const label = { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }[key]
      expect(areaOf(instance, key).demand[0]).toEqual(getDemandSeries(DEMAND, label, 'Monday', 'mean'))
    }
    // No ESI anywhere in the instance.
    expect(JSON.stringify(instance)).not.toMatch(/esi/i)
  })

  it('4. cross-covered ERU stays a separate area with its own cross-cover entry', () => {
    // Conservative default: responsibility in the config, no throughput entry for the solver.
    expect(instance.crossCover).toBeUndefined()
    expect(eru.coverageMode[di('Monday')][5]).toBe(CROSS_COVERED)
    const { instance: withRatio } = build({ coverage: RATIO })
    expect(withRatio.crossCover).toHaveLength(1)
    const cc = withRatio.crossCover[0]
    expect(cc).toMatchObject({ area: 'eru', coveredBy: 'main' })
    expect(cc.headroomFactor).toBeCloseTo(0.8 / 2.1, 12)
    expect(cc.eligible[di('Monday')][5]).toBe(1)
    expect(cc.eligible[di('Monday')][12]).toBe(0)
    // ERU resident 23:00–07:00 (PGY-2, 0.8) is what Main would supervise at 05:00.
    expect(cc.supervised[di('Monday')][5]).toBeCloseTo(0.8, 10)
    expect(withRatio.coveringAreas).toEqual({})    // Main is in scope: solver computes its headroom
    expect(main.supervisionCeilingPph).toBe(2.1)
  })

  it('ERU-only scope: Main (fixed) headroom is passed as constants', () => {
    const { instance: i } = build({ scope: 'eru', coverage: RATIO })
    expect(Object.keys(i.coveringAreas)).toEqual(['main'])
    // Main at 05:00: 2 attendings -> ceiling 4.2; its own expected demand 3.0.
    expect(i.coveringAreas.main.ceiling[0][5]).toBeCloseTo(4.2, 10)
    expect(i.coveringAreas.main.load[0][5]).toBeCloseTo(3.0, 10)
  })

  it('without a config the instance is exactly the unconstrained one', () => {
    const { instance: plain } = build({ coverage: null })
    expect(plain.crossCover).toBeUndefined()
    expect(areaOf(plain, 'main').minCoverage.flat().every(v => v === 0)).toBe(true)
    expect(areaOf(plain, 'eru').slots[0].maxAttendings[0][5]).toBe(1)
  })

  it('rejects an invalid config instead of guessing', () => {
    expect(() => build({ coverage: { areas: { eru: { default: { mode: CROSS_COVERED } } } } })).toThrow(/invalid/)
  })
})

describe('cross-coverage analysis', () => {
  const C = DEFAULT_OPERATIONAL_COVERAGE

  it('5/6. ERU demand stays ERU\'s and its resident is credited via Main\'s supervision headroom', () => {
    const shifts = schedule('Monday')
    const a = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday', coverage: RATIO })
    const eru5 = a.hours[5].byArea.eru
    expect(eru5.demand).toBe(0.5)                               // not moved into Main
    expect(eru5.coverage).toMatchObject({ mode: CROSS_COVERED, crossCovered: true, ownAttendings: 0, coveredBy: 'main' })
    // Main 05:00: 2 attendings, ceiling 4.2, expected demand 3 -> headroom 1.2 Main-patients/hr
    // = 1.2 x 0.8/2.1 ERU-patients/hr (ceiling ratio) < the 0.8 resident -> credit 0.457.
    expect(eru5.coverage.crossCoverCredit).toBeCloseTo(1.2 * 0.8 / 2.1, 10)
    expect(eru5.capacity).toBeCloseTo(1.2 * 0.8 / 2.1, 10)
    expect(eru5.coverage.unsupervisedExtender).toBe(0)
    // Main's own numbers are not changed by covering ERU.
    const plain = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday' })
    expect(a.hours[5].byArea.main).toMatchObject({ demand: plain.hours[5].byArea.main.demand, capacity: plain.hours[5].byArea.main.capacity })
    // Without the config ERU's resident is unsupervised: capacity 0.
    expect(plain.hours[5].byArea.eru.capacity).toBe(0)
  })

  it('credit is capped by the covering area\'s headroom', () => {
    const shifts = schedule('Monday')
    const demandFor = dem => a => getDemandSeries(dem, { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }[a], 'Monday')
    const at = (sh, dem) => crossCoverHour({ shifts: sh, pph: PPH, config: RATIO, day: 'Monday', hour: 5, areas: ['main', 'fasttrack', 'eru'], demandFor: demandFor(dem) })
    // Main 05:00, 2 attendings: ceiling 4.2 − expected 4.0 = 0.2 Main-patients of headroom = 0.076 ERU-patients.
    expect(at(shifts, { ...DEMAND, Main: { overall: flat(4.0) } }).eru.credit).toBeCloseTo(0.2 * 0.8 / 2.1, 10)
    // Main expected 5.0 > ceiling 4.2: no headroom at all, even though Main's attendings are on.
    expect(at(shifts, { ...DEMAND, Main: { overall: flat(5.0) } }).eru.credit).toBe(0)
    // Quiet Main (1.0): headroom 3.2 = 1.22 ERU-patients, so the full 0.8 resident is credited.
    expect(at(shifts, { ...DEMAND, Main: { overall: flat(1.0) } }).eru).toMatchObject({ credit: 0.8, supervised: 0.8, headroomBefore: 3.2 })
  })

  it('areas covered by the same area share its headroom in AREAS order', () => {
    const c = cloneCoverageConfig(RATIO)
    c.areas.fasttrack.rules = [{ fromHour: 1, toHour: 7, mode: CROSS_COVERED, coveredBy: 'main' }]
    const shifts = [...schedule('Monday'), sh('FastTrack', 'Resident', 0, 8, { day: 'Monday' })]
    const dem = { ...DEMAND, Main: { overall: flat(3.0) } }   // headroom 4.2 − 3.0 = 1.2
    const x = crossCoverHour({ shifts, pph: PPH, config: c, day: 'Monday', hour: 5, areas: ['main', 'fasttrack', 'eru'], demandFor: a => getDemandSeries(dem, { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }[a], 'Monday') })
    // FastTrack first: 1.2 x 3.5/2.1 = 2.0 FastTrack-patients available, the 0.8 resident uses 0.48 of Main's 1.2.
    expect(x.fasttrack.credit).toBeCloseTo(0.8, 10)
    // ERU gets what is left: 0.72 x 0.8/2.1.
    expect(x.eru.credit).toBeCloseTo((1.2 - 0.8 * 2.1 / 3.5) * 0.8 / 2.1, 10)
  })

  it('a whole idle Main attending buys at most one ERU attending\'s worth of supervision', () => {
    const x = crossCoverHour({
      shifts: [sh('Green', 'Attending', 0, 8, { day: 'Monday' }), sh('ERU', 'Resident', 0, 8, { day: 'Monday' }), sh('ERU', 'Resident', 0, 8, { day: 'Monday', resident_level: 'PGY-4' })],
      pph: PPH, config: RATIO, day: 'Monday', hour: 5, areas: ['main', 'eru'], demandFor: () => flat(0),
    })
    expect(x.eru.supervised).toBeCloseTo(2.2, 10)
    expect(x.eru.credit).toBeCloseTo(0.8, 10)        // = ERU ceiling, same as a dedicated ERU attending
  })

  it('a dedicated ERU attending replaces cross-coverage, even in a cross-covered window', () => {
    const shifts = [...schedule('Monday'), sh('ERU', 'Attending', 1, 9, { day: 'Monday' })]
    const a = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'eru', day: 'Monday', coverage: C })
    expect(a.hours[5].byArea.eru.coverage).toMatchObject({ crossCovered: false, ownAttendings: 1, crossCoverCredit: 0 })
  })

  it('6. residents with no attending and no cross-coverage are reported as unsupervised, not dropped', () => {
    const c = cloneCoverageConfig(C)
    c.areas.eru.default = { mode: FLEXIBLE }          // no Main fallback
    const a = analyzeScope({ shifts: schedule('Monday'), demand: DEMAND, pph: PPH, scope: 'eru', day: 'Monday', coverage: c })
    expect(a.hours[5].byArea.eru.coverage).toMatchObject({ crossCovered: false, unsupervisedExtender: 0.8 })
    expect(a.hours[5].byArea.eru.capacity).toBe(0)
  })

  it('8. closing FastTrack does not create or delete demand', () => {
    const shifts = schedule('Tuesday')
    const withC = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'fasttrack', day: 'Tuesday', coverage: C })
    const without = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'fasttrack', day: 'Tuesday' })
    expect(withC.hours.map(r => r.demand)).toEqual(without.hours.map(r => r.demand))
    expect(withC.hours[3].byArea.fasttrack.coverage.mode).toBe(CLOSED)
    expect(withC.hours[3].byArea.fasttrack.net).toBeCloseTo(-2, 10)   // still counted as unmet
  })
})

describe('operational summary', () => {
  it('splits hours into dedicated / cross-covered / required / voluntary', () => {
    const args = { days: WEEK, shiftsForDay: schedule, customTeams: [], demand: DEMAND, pph: PPH, scope: 'wholeEd', target: 'mean', coverage: RATIO }
    const m = schedulePlanMetrics(args)
    const eru = m.operational.eru
    // Weekdays 16 h dedicated, weekends 8 h.
    expect(eru.hoursDedicated).toBe(5 * 16 + 2 * 8)
    expect(eru.hoursCrossCovered).toBe(168 - eru.hoursDedicated)
    expect(eru.requiredAttendingHours).toBe(5 * 16 + 2 * 8)
    expect(eru.requiredAttendingHoursMet).toBe(eru.requiredAttendingHours)
    expect(eru.voluntaryAttendingHours).toBe(0)
    expect(eru.requiredShortfallHours).toBe(0)
    expect(eru.crossCovered.demand).toBeCloseTo(0.5 * eru.hoursCrossCovered, 10)
    expect(m.operational.main.coveringLoad.eru).toBeGreaterThan(0)
    expect(m.operational.main.voluntaryAttendingHours).toBe(168 * 2 - 168)
    const ft = m.operational.fasttrack
    expect(ft.hoursClosedUncovered).toBe(7 * 6)
    expect(ft.closed.demand).toBeCloseTo(2 * 42, 10)
    // Same week without the config: identical demand totals.
    const plainWeek = analyzeWeek({ ...args, coverage: null })
    const total = w => w.days.reduce((t, d) => t + d.analysis.hours.reduce((u, r) => u + r.demand, 0), 0)
    expect(total(m.week)).toBeCloseTo(total(plainWeek), 10)
  })

  it('counts a missing required attending as a shortfall', () => {
    const noEru = day => schedule(day).filter(s => !(s.team === 'ERU' && s.role_type === 'Attending'))
    const m = schedulePlanMetrics({ days: WEEK, shiftsForDay: noEru, customTeams: [], demand: DEMAND, pph: PPH, scope: 'eru', target: 'mean', coverage: DEFAULT_OPERATIONAL_COVERAGE })
    expect(m.operational.eru.requiredShortfallHours).toBe(96)
    expect(m.operational.eru.hoursRequiredUncovered).toBe(96)
    expect(operationalCoverageSummary).toBeTypeOf('function')
  })
})


describe('cross-cover throughput credit is an explicit assumption', () => {
  const shifts = schedule('Monday')
  const scoreAt5 = coverage => analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday', coverage }).hours[5]
  const custom = (residentCreditFraction, headroomFactor) =>
    withCrossCoverCredit(DEFAULT_OPERATIONAL_COVERAGE, { mode: CROSS_COVER_CREDIT.CUSTOM, residentCreditFraction, headroomFactor })
  const modes = {
    conservative: DEFAULT_OPERATIONAL_COVERAGE,
    ratio: RATIO,
    custom: custom(0.5, 0.25),
  }

  it('the default is CONSERVATIVE', () => {
    expect(DEFAULT_OPERATIONAL_COVERAGE.areas.eru.crossCoverCredit).toEqual({ mode: CROSS_COVER_CREDIT.CONSERVATIVE })
    expect(crossCoverCreditParams(DEFAULT_OPERATIONAL_COVERAGE, 'eru', 'main', PPH)).toMatchObject({ residentCreditFraction: 0, headroomFactor: 0 })
  })

  it('responsibility is identical in every mode; only the credit differs', () => {
    const cov = Object.fromEntries(Object.entries(modes).map(([k, c]) => [k, scoreAt5(c).byArea.eru.coverage]))
    for (const c of Object.values(cov)) {
      expect(c).toMatchObject({ mode: CROSS_COVERED, coveredBy: 'main', crossCovered: true, ownAttendings: 0, unsupervisedExtender: 0 })
      expect(c.supervisedByCovering).toBeCloseTo(0.8, 10)   // the ERU resident is supervised by Main in every mode
    }
    expect(cov.conservative.crossCoverCredit).toBe(0)
    // Main 05:00: headroom 4.2 − 3.0 = 1.2.
    expect(cov.ratio.crossCoverCredit).toBeCloseTo(Math.min(0.8, 1.2 * 0.8 / 2.1), 10)   // reproduces the earlier calculation
    expect(cov.custom.crossCoverCredit).toBeCloseTo(Math.min(0.5 * 0.8, 0.25 * 1.2), 10)  // uses the configured values
  })

  it('conservative mode adds no ERU capacity in cross-covered hours', () => {
    const noCover = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday' })
    const cons = analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday', coverage: DEFAULT_OPERATIONAL_COVERAGE })
    for (let h = 0; h < 24; h++) expect(cons.hours[h].byArea.eru.capacity).toBe(noCover.hours[h].byArea.eru.capacity)
  })

  it('ERU demand, dedicated ERU capacity and Main capacity are the same in every mode', () => {
    const rows = Object.values(modes).map(c => analyzeScope({ shifts, demand: DEMAND, pph: PPH, scope: 'wholeEd', day: 'Monday', coverage: c }))
    for (let h = 0; h < 24; h++) {
      const [a, ...rest] = rows.map(r => r.hours[h].byArea)
      for (const b of rest) {
        expect(b.eru.demand).toBe(a.eru.demand)
        expect(b.main.capacity).toBe(a.main.capacity)
        expect(b.main.demand).toBe(a.main.demand)
        if (a.eru.coverage.ownAttendings > 0) expect(b.eru.capacity).toBe(a.eru.capacity)   // dedicated hours untouched
      }
    }
  })

  it('required coverage constraints do not depend on the credit mode', () => {
    const inst = c => build({ coverage: c }).instance
    const [a, ...rest] = Object.values(modes).map(inst)
    for (const b of rest) {
      for (const key of ['main', 'fasttrack', 'eru']) {
        expect(areaOf(b, key).minCoverage).toEqual(areaOf(a, key).minCoverage)
        expect(areaOf(b, key).slots.map(x => x.maxAttendings)).toEqual(areaOf(a, key).slots.map(x => x.maxAttendings))
        expect(areaOf(b, key).demand).toEqual(areaOf(a, key).demand)
      }
    }
  })

  it('custom mode reaches the solver as its configured factor; conservative sends nothing', () => {
    const { instance } = build({ coverage: custom(0.5, 0.25) })
    expect(instance.crossCover[0].headroomFactor).toBe(0.25)
    expect(instance.crossCover[0].supervised[di('Monday')][5]).toBeCloseTo(0.5 * 0.8, 10)
    expect(build({ coverage: custom(0, 0.25) }).instance.crossCover).toBeUndefined()
  })

  it('rejects out-of-range custom values', () => {
    expect(validateCoverageConfig(custom(1.5, 0.2)).join()).toMatch(/fraction/)
    expect(validateCoverageConfig(custom(1, -1)).join()).toMatch(/headroom factor/)
  })
})

describe('ERU: at most one dedicated attending at a time', () => {
  it('is structural: applies with no config, with the default, and cannot be raised', () => {
    expect(areaMaxAttendings(null)).toEqual({ eru: 1 })
    expect(effectiveMaxAttendings(DEFAULT_OPERATIONAL_COVERAGE, 'eru')).toBe(1)
    const c = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    c.areas.eru.maxAttendings = 2
    expect(validateCoverageConfig(c).join()).toMatch(/never has more than 1/)
    expect(effectiveMaxAttendings(c, 'eru')).toBe(1)
    const r = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    r.areas.eru.rules[0].minAttendings = 2
    expect(validateCoverageConfig(r).join()).toMatch(/allows at most 1/)
  })

  it('caps every ERU slot and gives the solver an area maximum — with or without the coverage rules', () => {
    for (const coverage of [DEFAULT_OPERATIONAL_COVERAGE, null]) {
      const eru = areaOf(build({ coverage }).instance, 'eru')
      expect(eru.maxCoverage.flat().every(v => v === 1)).toBe(true)
      for (const s of eru.slots) expect(Math.max(...s.maxAttendings.flat())).toBeLessThanOrEqual(1)
    }
    // Other areas are not limited.
    expect(areaOf(build().instance, 'main').maxCoverage).toBeUndefined()
  })

  it('survives scenario serialization and restoration (even for configs saved without it)', () => {
    const payload = buildScenarioPayload({ schedState: { getShiftsForDay: () => [] }, pph: PPH, costRates: {}, customTeams: [], target: 'mean', operationalCoverage: RATIO })
    const restored = scenarioOperationalCoverage(JSON.parse(JSON.stringify(payload)))
    expect(restored.areas.eru.maxAttendings).toBe(1)
    expect(restored.areas.eru.crossCoverCredit).toEqual({ mode: CROSS_COVER_CREDIT.CURRENT_RATIO })
    const old = JSON.parse(JSON.stringify(payload))
    delete old.operationalCoverage.areas.eru.maxAttendings
    expect(scenarioOperationalCoverage(old).areas.eru.maxAttendings).toBe(1)
  })
})

describe('plans never move residents/PAs', () => {
  it('applyPlanResult keeps every non-attending shift exactly', () => {
    const { context } = build()
    const fake = { shifts: [{ area: 'eru', slot: 'ERU', flex: false, day: 'Monday', start: 9, length: 8 }] }
    const { proposedByDay } = applyPlanResult(fake, context, [])
    for (const day of WEEK) {
      const key = s => `${s.team}|${s.role_type}|${s.startMins}|${s.endMins}`
      const before = schedule(day).filter(s => s.role_type !== 'Attending').map(key).sort()
      const after = proposedByDay[day].filter(s => s.role_type !== 'Attending').map(key).sort()
      expect(after).toEqual(before)
    }
  })
})
