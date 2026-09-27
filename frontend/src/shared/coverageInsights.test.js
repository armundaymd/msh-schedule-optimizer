import { describe, it, expect } from 'vitest'
import {
  classifyNet, coverageGrid, hourSnapshot, worstHour, groupRuns, formatRange, buildCoverageInsights,
} from './coverageInsights'
import { analyzeScope } from './scopeAnalysis'
import { scopeAreas } from './areas'

// Build an analyzeScope()-shaped result from explicit per-area demand and
// capacity series, so each test states its numbers directly.
function analysisFrom(scope, perArea) {
  const areas = scopeAreas(scope)
  const series = v => (Array.isArray(v) ? v : Array(24).fill(v))
  const hours = Array.from({ length: 24 }, (_, h) => {
    const byArea = {}
    const shortAreas = []
    let demand = 0, capacity = 0, worst = Infinity
    for (const area of areas) {
      const d = series(perArea[area].demand)[h]
      const c = series(perArea[area].capacity)[h]
      byArea[area] = { demand: d, capacity: c, net: c - d }
      demand += d
      capacity += c
      if (d > c) shortAreas.push(area)
      worst = Math.min(worst, c - d)
    }
    const net = capacity - demand
    return { hour: h, demand, capacity, net, limitingNet: shortAreas.length ? worst : net, shortAreas, byArea }
  })
  return { scope, areas, hours }
}

// Series that is `base` everywhere except `overrides` { hour: value }.
function withHours(base, overrides) {
  const s = Array(24).fill(base)
  for (const [h, v] of Object.entries(overrides)) s[h] = v
  return s
}

describe('classifyNet', () => {
  it('deficit whenever demand exceeds capacity, however slightly', () => {
    expect(classifyNet(5, 4.99)).toBe('deficit')
  })
  it('adequate when covered without a meaningful surplus', () => {
    expect(classifyNet(5, 5)).toBe('adequate')
    expect(classifyNet(5, 5.9)).toBe('adequate') // < 1 PPH surplus
    expect(classifyNet(9.5, 10.5)).toBe('adequate') // 1 PPH but < 25% of demand
  })
  it('excess when surplus is both >= 1 PPH and >= 25% of demand', () => {
    expect(classifyNet(3, 4)).toBe('excess')
    expect(classifyNet(0, 4)).toBe('excess')
    expect(classifyNet(0, 0.5)).toBe('adequate')
  })
})

describe('groupRuns / formatRange', () => {
  it('merges adjacent hours with the same key into ranges', () => {
    const runs = groupRuns(h => (h >= 17 && h <= 19 ? 'x' : null))
    expect(runs).toEqual([{ key: 'x', hours: [17, 18, 19] }])
    expect(formatRange(runs[0].hours)).toBe('from 17:00–20:00')
  })
  it('splits runs when the key changes', () => {
    const runs = groupRuns(h => (h < 2 ? 'a' : h < 4 ? 'b' : null))
    expect(runs.map(r => [r.key, r.hours])).toEqual([['a', [0, 1]], ['b', [2, 3]]])
  })
  it('merges a run that wraps across midnight', () => {
    const runs = groupRuns(h => (h >= 22 || h <= 1 ? 'x' : null))
    expect(runs).toEqual([{ key: 'x', hours: [22, 23, 0, 1] }])
    expect(formatRange(runs[0].hours)).toBe('from 22:00–02:00')
  })
  it('formats single hours and full days', () => {
    expect(formatRange([18])).toBe('at 18:00')
    expect(formatRange(groupRuns(() => 'x')[0].hours)).toBe('all day')
  })
})

describe('the user example: Whole ED at one hour', () => {
  // At 18:00 only: Main -2.7, FastTrack -1.2, ERU +0.5 -> aggregate -3.4.
  const a = analysisFrom('wholeEd', {
    main: { demand: withHours(5, { 18: 10 }), capacity: withHours(5, { 18: 7.3 }) },
    fasttrack: { demand: withHours(2, { 18: 4 }), capacity: withHours(2, { 18: 2.8 }) },
    eru: { demand: withHours(1, { 18: 1 }), capacity: withHours(1, { 18: 1.5 }) },
  })

  it('hourSnapshot exposes the aggregate and every area value', () => {
    const snap = hourSnapshot(a, 18)
    expect(snap.aggregate.net).toBeCloseTo(-3.4, 5)
    expect(snap.aggregate.status).toBe('deficit')
    expect(snap.areas.map(x => [x.area, Number(x.net.toFixed(1)), x.status])).toEqual([
      ['main', -2.7, 'deficit'], ['fasttrack', -1.2, 'deficit'], ['eru', 0.5, 'adequate'],
    ])
  })

  it('worstHour picks the most-short hour', () => {
    expect(worstHour(a)).toBe(18)
  })

  it('reports each area deficit and the aggregate deficit', () => {
    const msgs = buildCoverageInsights(a).map(i => i.message)
    expect(msgs).toEqual([
      'Main has a capacity deficit at 18:00 (−2.7 PPH).',
      'FastTrack has a capacity deficit at 18:00 (−1.2 PPH).',
      'Whole ED aggregate is below demand at 18:00 (−3.4 PPH).',
    ])
  })
})

describe('good total coverage must not mask local understaffing', () => {
  // 17:00-19:59: Main -4, ERU +4 -> aggregate 0.
  const a = analysisFrom('mainEru', {
    main: { demand: withHours(3, { 17: 8, 18: 8, 19: 8 }), capacity: 4 },
    eru: { demand: withHours(1, { 17: 0, 18: 0, 19: 0 }), capacity: withHours(1.5, { 17: 4, 18: 4, 19: 4 }) },
  })

  it('the aggregate row is flagged masked, not adequate/excess', () => {
    const grid = coverageGrid(a)
    expect(grid.aggregate.status[18]).toBe('masked')
    expect(grid.aggregate.net[18]).toBeCloseTo(0, 5)
    expect(grid.byArea.main.status[18]).toBe('deficit')
    expect(grid.byArea.eru.status[18]).toBe('excess')
    expect(hourSnapshot(a, 18).aggregate.status).toBe('masked')
  })

  it('produces one masked-deficit insight for the whole range, ranked first', () => {
    const insights = buildCoverageInsights(a)
    expect(insights[0]).toMatchObject({
      kind: 'masked-deficit', areas: ['main'], startHour: 17, endHour: 20, peakHour: 17,
      message: 'Main + ERU aggregate coverage is adequate from 17:00–20:00, but Main remains below demand.',
    })
    expect(insights.find(i => i.kind === 'deficit')?.message)
      .toBe('Main has a capacity deficit from 17:00–20:00 (worst −4.0 PPH at 17:00).')
    expect(insights.find(i => i.kind === 'excess')?.message)
      .toBe('ERU has excess capacity from 17:00–20:00 (up to +4.0 PPH).')
    expect(insights.some(i => i.kind === 'aggregate-deficit')).toBe(false)
  })

  it('names every short area and splits ranges when the set of short areas changes', () => {
    const b = analysisFrom('wholeEd', {
      main: { demand: withHours(2, { 10: 3, 11: 3 }), capacity: 2 },
      fasttrack: { demand: withHours(2, { 11: 3 }), capacity: 2 },
      eru: { demand: 0, capacity: withHours(0, { 10: 5, 11: 5 }) },
    })
    const masked = buildCoverageInsights(b).filter(i => i.kind === 'masked-deficit').map(i => i.message)
    expect(masked).toEqual([
      'Whole ED aggregate coverage is adequate at 10:00, but Main remains below demand.',
      'Whole ED aggregate coverage is adequate at 11:00, but Main and FastTrack remain below demand.',
    ])
  })
})

describe('excess and overnight ranges', () => {
  it('reports excess over a range with its peak, and wraps across midnight', () => {
    const a = analysisFrom('eru', {
      eru: { demand: 1, capacity: withHours(1, { 23: 3, 0: 3, 1: 4, 2: 3 }) },
    })
    const insights = buildCoverageInsights(a)
    expect(insights).toHaveLength(1)
    expect(insights[0]).toMatchObject({ kind: 'excess', startHour: 23, endHour: 3, peakHour: 1 })
    expect(insights[0].message).toBe('ERU has excess capacity from 23:00–03:00 (up to +3.0 PPH).')
  })

  it('single-area scopes never emit aggregate or masked insights', () => {
    const a = analysisFrom('main', { main: { demand: withHours(2, { 5: 4 }), capacity: 2 } })
    expect(buildCoverageInsights(a).map(i => i.kind)).toEqual(['deficit'])
  })

  it('a fully adequate day produces no insights', () => {
    const a = analysisFrom('mainEru', { main: { demand: 2, capacity: 2.5 }, eru: { demand: 1, capacity: 1.2 } })
    expect(buildCoverageInsights(a)).toEqual([])
    expect(coverageGrid(a).aggregate.status.every(s => s === 'adequate')).toBe(true)
  })
})

describe('end to end with analyzeScope', () => {
  it('flags an overnight Main gap covered in total by ERU', () => {
    const PPH = { main: 2, mainOwn: 2, eru: 4, eruOwn: 4, fasttrack: 3, fasttrackOwn: 3 }
    const shift = (team, startMins, endMins) => ({ team, role_type: 'Attending', startMins, endMins })
    // Main 07:00-03:00 (wraps), ERU all day. Main is uncovered 03:00-07:00.
    const shifts = [shift('Green', 7 * 60, 27 * 60), shift('ERU', 0, 24 * 60)]
    const demand = { Main: { overall: Array(24).fill(1) }, ERU: { overall: Array(24).fill(1) } }
    const analysis = analyzeScope({ shifts, demand, pph: PPH, customTeams: [], scope: 'mainEru', day: 'Monday' })
    const masked = buildCoverageInsights(analysis).filter(i => i.kind === 'masked-deficit')
    expect(masked.map(i => i.message)).toEqual([
      'Main + ERU aggregate coverage is adequate from 03:00–07:00, but Main remains below demand.',
    ])
  })
})
