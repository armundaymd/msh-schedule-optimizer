import { describe, it, expect } from 'vitest'
import {
  DISPLAY_DEFICIT_TOLERANCE_PPH, buildCoverageInsights, classifyNet, coverageGrid, deficitHours,
  hourSnapshot, isBelowDisplayTolerance,
} from './coverageInsights'
import { analyzeWeek, weekCell, weekDaySummary } from './weekCoverage'

const TOL = { deficitTolerance: DISPLAY_DEFICIT_TOLERANCE_PPH }

// A hand-built analyzeScope() result: `values[area][h] = [demand, capacity]`
// (unlisted hours: demand 1, capacity 1).
function analysisOf(values, scope = 'main') {
  const areas = Object.keys(values)
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const byArea = {}
    let demand = 0, capacity = 0
    const shortAreas = []
    for (const a of areas) {
      const [d, c] = values[a][hour] ?? [1, 1]
      byArea[a] = { demand: d, capacity: c, net: c - d }
      demand += d; capacity += c
      if (d > c) shortAreas.push(a)
    }
    return { hour, demand, capacity, net: capacity - demand, limitingNet: capacity - demand, shortAreas, byArea }
  })
  return { scope, areas, hours }
}

describe('display tolerance for tiny deficits (presentation only)', () => {
  it('is 0.05 PPH: the shortfall that rounds to 0.0 at one decimal', () => {
    expect(DISPLAY_DEFICIT_TOLERANCE_PPH).toBe(0.05)
  })

  it('the raw rule is unchanged: any demand above capacity is a deficit', () => {
    expect(classifyNet(4.211, 4.2)).toBe('deficit')
    expect(classifyNet(4.211, 4.2, 0)).toBe('deficit')
  })

  it('a shortfall below the tolerance displays as covered, at or above it as a deficit', () => {
    expect(classifyNet(4.211, 4.2, 0.05)).toBe('adequate') // the audited case: 0.011 short
    expect(classifyNet(4.249, 4.2, 0.05)).toBe('adequate')
    expect(classifyNet(4.25, 4.2, 0.05)).toBe('deficit')
    expect(classifyNet(7.2, 4.2, 0.05)).toBe('deficit')
    expect(isBelowDisplayTolerance(4.211, 4.2)).toBe(true)
    expect(isBelowDisplayTolerance(4.2, 4.2)).toBe(false)
    expect(isBelowDisplayTolerance(4.3, 4.2)).toBe(false)
  })

  it('excess classification does not depend on the tolerance', () => {
    expect(classifyNet(3, 4, 0.05)).toBe(classifyNet(3, 4))
    expect(classifyNet(3, 4)).toBe('excess')
  })

  it('Coverage issues no longer lists a "deficit (0.0 PPH)"; the raw call still does', () => {
    const a = analysisOf({ main: { 8: [4.211, 4.2], 14: [7.2, 4.2] } })
    const raw = buildCoverageInsights(a).filter(i => i.kind === 'deficit').map(i => i.message)
    const shown = buildCoverageInsights(a, TOL).filter(i => i.kind === 'deficit').map(i => i.message)
    expect(raw.some(m => m.includes('(0.0 PPH)'))).toBe(true)
    expect(shown).toEqual(['Main has a capacity deficit at 14:00 (−3.0 PPH).'])
  })

  it('grid, snapshot and short-hour counts follow the tolerance; nets stay raw', () => {
    const a = analysisOf({ main: { 8: [4.211, 4.2], 14: [7.2, 4.2] } })
    expect(coverageGrid(a).byArea.main.status[8]).toBe('deficit')
    const g = coverageGrid(a, TOL)
    expect(g.byArea.main.status[8]).toBe('adequate')
    expect(g.byArea.main.net[8]).toBeCloseTo(-0.011, 9)
    expect(hourSnapshot(a, 8, TOL).areas[0].status).toBe('adequate')
    expect(deficitHours(a).anyArea).toEqual([8, 14])
    expect(deficitHours(a, TOL).anyArea).toEqual([14])
  })

  it('a tiny area shortfall does not make a combined total "hidden short"', () => {
    const a = analysisOf({ main: { 8: [4.211, 4.2] }, eru: { 8: [0, 3] } }, 'mainEru')
    expect(coverageGrid(a).aggregate.status[8]).toBe('masked')
    expect(coverageGrid(a, TOL).aggregate.status[8]).not.toBe('masked')
    expect(buildCoverageInsights(a, TOL).some(i => i.kind === 'masked-deficit')).toBe(false)
  })

  it('the week heatmap counts use the tolerance only when asked', () => {
    // Green: one attending all day (ceiling 2.1); demand 2.111 at 08:00, 4 at 14:00.
    const shifts = [{ id: 'g', day: 'Monday', team: 'Green', role_type: 'Attending', startMins: 0, endMins: 1440 }]
    const series = Array.from({ length: 24 }, (_, h) => (h === 8 ? 2.111 : h === 14 ? 4 : 1))
    const demand = { Main: { by_dow: { Monday: series } } }
    const pph = { main: 2.1, mainOwn: 2.1 }
    const args = { days: ['Monday'], shiftsForDay: () => shifts, demand, pph, scope: 'main' }
    expect(weekDaySummary(analyzeWeek(args))[0].shortHours).toBe(2)
    const shown = analyzeWeek({ ...args, deficitTolerance: DISPLAY_DEFICIT_TOLERANCE_PPH })
    expect(weekDaySummary(shown)[0].shortHours).toBe(1)
    const cell = weekCell(shown, 0, 8)
    expect(cell.status).toBe('adequate')
    expect(cell.net).toBeCloseTo(-0.011, 9) // raw value kept for hover text
  })
})

describe('display tolerance in the Staffing plan results (presentation only)', () => {
  it('schedulePlanMetrics keeps raw deficit hours and adds the display count; unmet stays exact', async () => {
    const { schedulePlanMetrics } = await import('./staffingPlan')
    const shifts = [{ id: 'g', day: 'Monday', team: 'Green', role_type: 'Attending', startMins: 0, endMins: 1440 }]
    const series = Array.from({ length: 24 }, (_, h) => (h === 8 ? 2.111 : h === 14 ? 4 : 1))
    const m = schedulePlanMetrics({ days: ['Monday'], shiftsForDay: () => shifts, customTeams: [], demand: { Main: { by_dow: { Monday: series } } },
      pph: { main: 2.1, mainOwn: 2.1 }, scope: 'main', target: 'mean' })
    expect(m.byArea.main.deficitHours).toBe(2)
    expect(m.byArea.main.displayDeficitHours).toBe(1)
    expect(m.byArea.main.uncoveredPphHours).toBeCloseTo(0.011 + 1.9, 9)
  })

  it('withDeficitTolerance re-classifies a raw week without touching its numbers', async () => {
    const { withDeficitTolerance, consistentPatterns } = await import('./weekCoverage')
    const shifts = [{ id: 'g', day: 'Monday', team: 'Green', role_type: 'Attending', startMins: 0, endMins: 1440 }]
    const series = Array.from({ length: 24 }, (_, h) => (h === 8 ? 2.111 : 1))
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday']
    const raw = analyzeWeek({ days, shiftsForDay: d => shifts.map(s => ({ ...s, day: d })), demand: { Main: { overall: series } }, pph: { main: 2.1, mainOwn: 2.1 }, scope: 'main' })
    expect(consistentPatterns(raw).some(p => p.kind === 'short')).toBe(true)
    const shown = withDeficitTolerance(raw, DISPLAY_DEFICIT_TOLERANCE_PPH)
    expect(consistentPatterns(shown).some(p => p.kind === 'short')).toBe(false)
    expect(shown.days[0].analysis).toBe(raw.days[0].analysis)
  })

  it('bottleneck periods carry their worst hour so screens can hide sub-threshold ones', async () => {
    const { summarizeBottlenecks } = await import('./bottlenecks')
    const item = (hour, unmet) => ({ area: 'main', day: 'Monday', hour, unmet, labels: ['ATTENDING'], text: 'x', why: {} })
    const s = summarizeBottlenecks([item(8, 0.011), item(14, 1.9), item(15, 0.5)])
    expect(s.total).toBeCloseTo(2.411, 9)
    expect(s.runs.map(r => r.peak).sort()).toEqual([0.011, 1.9])
  })
})
