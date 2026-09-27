import { describe, it, expect } from 'vitest'
import { BOTTLENECK, DEFAULT_UTILIZATION_THRESHOLD, hourlyPatterns } from './bottlenecks'
import { planAndScore } from './attendingPlanner'
import { DEFAULT_OPERATIONAL_COVERAGE } from './operationalCoverage'

const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const DAYS = ['Monday']
const CURRENT = [7, 15, 23].map(start => ({ start, length: 8 }))
const series = (v, hours) => Array.from({ length: 24 }, (_, h) => (hours.includes(h) ? v : 0))
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i)
const demandOf = (main = [], ft = [], eru = []) => ({
  Main: { overall: main.length ? main : series(0, []) },
  FastTrack: { overall: ft.length ? ft : series(0, []) },
  ERU: { overall: eru.length ? eru : series(0, []) },
})

let seq = 0
const sh = (team, role_type, a, b, extra = {}) => ({
  id: `b${seq++}`, day: 'Monday', team, role_type, role_detail: role_type, resident_level: role_type === 'Resident' ? 'PGY-4' : null,
  startMins: a * 60, endMins: b * 60, start_time: '', end_time: '', ...extra,
})

// A fixed plan (the "solver" returns exactly these attending shifts).
function run({ schedule, demand, scope = 'main', planned, patterns = CURRENT, coverage = null, maxAttendingsByArea, maxFlex }) {
  const shifts = planned.map(([area, slot, start, length]) => ({ area, slot, flex: slot.endsWith(':flex'), day: 'Monday', start, length }))
  const hours = shifts.reduce((t, s) => t + s.length, 0)
  const solve = () => ({ status: 'optimal', message: '', shifts, hours: { total: hours, locked: 0, optimized: hours }, stats: { objectiveValue: 0, relativeGap: 0 } })
  return planAndScore({
    days: DAYS, shiftsForDay: () => schedule, customTeams: [], pph: PPH, demand, target: 'mean', scope, patterns, coverage,
    maxAttendingsByArea: maxAttendingsByArea ?? { eru: 1 }, inputs: { planningMode: 'budget' }, weeklyBudgetHours: 100, solve,
    ...(maxFlex != null ? { maxFlex } : {}),
  })
}

const labelsAt = (plan, area, hour) => plan.bottlenecks.items.find(i => i.area === area && i.hour === hour)?.labels

describe('bottleneck diagnosis', () => {
  it('17: attending-limited — supervision ceiling reached, another attending would help', async () => {
    // Green attending + PGY-4 = min(2.1, 1.3 + 1.4) = 2.1 against 4.0: short 1.9.
    // Another attending (Red/Blue/new team, 1.3/hr) fits the 07:00+8h shift.
    const plan = await run({
      schedule: [sh('Green', 'Resident', 7, 15)],
      demand: demandOf(series(4, range(7, 15))),
      planned: [['main', 'Green', 7, 8]],
    })
    expect(plan.summary.byArea.main.unmet).toBeCloseTo(8 * 1.9, 6)
    expect(labelsAt(plan, 'main', 10)).toEqual([BOTTLENECK.ATTENDING])
    const item = plan.bottlenecks.items.find(i => i.hour === 10)
    expect(item.why.attending.gain).toBeCloseTo(1.3, 6)
    expect(item.text).toMatch(/More attending hours would help/)
    expect(plan.bottlenecks.byLabel.ATTENDING).toBeCloseTo(8 * 1.9, 6)
  })

  it('17b: no attending present is reported as attending-limited', async () => {
    const plan = await run({ schedule: [], demand: demandOf(series(2, range(7, 15))), planned: [] })
    const item = plan.bottlenecks.items.find(i => i.hour === 9)
    expect(item.labels).toEqual([BOTTLENECK.ATTENDING])
    expect(item.why.attending.noAttending).toBe(true)
  })

  it('18: resident/APP-limited — the attending has supervision headroom', async () => {
    // Green attending alone: 1.3 of a 2.1 ceiling, demand 1.5 -> short 0.2.
    // One more PA would add 0.8 without another attending; another attending
    // would put only 0.2 of its 1.3/hr against unmet demand.
    const plan = await run({ schedule: [], demand: demandOf(series(1.5, range(7, 15))), planned: [['main', 'Green', 7, 8]] })
    const item = plan.bottlenecks.items.find(i => i.hour === 10)
    expect(item.labels).toContain(BOTTLENECK.RESIDENT_APP)
    expect(item.labels).not.toContain(BOTTLENECK.ATTENDING)
    expect(item.why.residentApp).toMatchObject({ team: 'Green', attendings: 1, solo: false })
    expect(item.why.residentApp.gain).toBeCloseTo(0.8, 6)
    expect(item.text).toMatch(/supervision headroom/)
    // The attending shift's utilisation is 0.2/1.3 — below the threshold.
    expect(item.why.attending.bestShift.utilization).toBeCloseTo(0.2 / 1.3, 6)
    expect(item.why.attending.bestShift.utilization).toBeLessThan(DEFAULT_UTILIZATION_THRESHOLD)
  })

  it('19: ERU maximum one attending is an operational limit', async () => {
    // ERU attending + PA: min(0.8, 0.6 + 1.2) = 0.8 against 2.0 — at the ceiling,
    // so another PA adds nothing, and a second attending is not allowed.
    const plan = await run({
      scope: 'eru', schedule: [sh('ERU', 'PA', 8, 16)], demand: demandOf([], [], series(2, range(8, 16))),
      planned: [['eru', 'ERU', 7, 8], ['eru', 'ERU', 15, 8]], patterns: CURRENT,
    })
    const item = plan.bottlenecks.items.find(i => i.hour === 10)
    expect(item.labels).toEqual([BOTTLENECK.OPERATIONAL])
    expect(item.why.operational).toBe('areaMax')
    expect(item.text).toMatch(/maximum of 1 attending/)
  })

  it('shift-structure-limited: a short peak the 8 h menu can only cover with mostly surplus', async () => {
    const plan = await run({ schedule: [], demand: demandOf(series(2, [12, 13])), planned: [] })
    const item = plan.bottlenecks.items.find(i => i.hour === 12)
    expect(item.labels).toEqual([BOTTLENECK.SHIFT_STRUCTURE])
    expect(item.why.structure).toBe('lowUtilization')
    expect(item.why.attending.bestShift.utilization).toBeCloseTo(2 / 8, 6)
  })

  it('shift-structure: hourly starts would fix what the current menu cannot', async () => {
    // Peak 12-20; menu starts 07/15/23 put at most 3 of 8 hours on the peak.
    const plan = await run({ schedule: [], demand: demandOf(series(2, range(12, 20))), planned: [] })
    const item = plan.bottlenecks.items.find(i => i.hour === 13)
    expect(item.labels).toEqual([BOTTLENECK.SHIFT_STRUCTURE])
    expect(item.why.attending.expanded).toMatchObject({ start: 12, length: 8 })
    expect(item.why.attending.expanded.utilization).toBeCloseTo(1, 6)
    expect(item.text).toMatch(/hourly start times/)
    expect(hourlyPatterns(CURRENT)).toHaveLength(24)
  })

  it('operational: FastTrack closed hours and ERU cross-coverage', async () => {
    const plan = await run({
      scope: 'wholeEd', schedule: [], coverage: DEFAULT_OPERATIONAL_COVERAGE,
      demand: demandOf(series(1, range(0, 24)), series(0.5, [3]), series(0.5, [5])),
      planned: [['main', 'Green', 23, 8], ['main', 'Green', 7, 8], ['main', 'Green', 15, 8],
        ['eru', 'ERU', 9, 8], ['eru', 'ERU', 17, 8]],
      patterns: [7, 9, 11, 15, 17, 23].map(start => ({ start, length: 8 })),
    })
    const ft = plan.bottlenecks.items.find(i => i.area === 'fasttrack' && i.hour === 3)
    expect(ft.labels).toEqual([BOTTLENECK.OPERATIONAL])
    expect(ft.why.operational).toBe('closed')
    const eru = plan.bottlenecks.items.find(i => i.area === 'eru' && i.hour === 5)
    expect(eru.labels).toContain(BOTTLENECK.OPERATIONAL)
    expect(eru.why.operational).toBe('crossCovered')
  })

  it('labels can overlap; the combination split sums to the total', async () => {
    const plan = await run({ schedule: [], demand: demandOf(series(1.5, range(7, 15)), [], []), planned: [['main', 'Green', 7, 8]] })
    const b = plan.bottlenecks
    const combos = Object.values(b.byCombination).reduce((t, v) => t + v, 0)
    expect(combos).toBeCloseTo(b.total, 9)
    expect(b.total).toBeCloseTo(plan.summary.all.unmet, 9)
    expect(b.runs[0].text).toMatch(/Main Monday/)
  })
})
