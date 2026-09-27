import { describe, it, expect } from 'vitest'
import { SCOPES, scopeAreas, isCombinedScope, teamsInArea } from './areas'
import { teamCapacity, teamArea, scopeCapacity, scopeCapacityBreakdown, scopeTeamBreakdown } from './capacity'
import { getDemandSeries, getScopeDemandSeries } from './demandSeries'
import { analyzeScope } from './scopeAnalysis'

// Round numbers so the arithmetic in each test is obvious: one attending
// working alone covers exactly pph[area + 'Own'] (= pph[area] here).
const PPH = {
  main: 2, mainOwn: 2,
  fasttrack: 3, fasttrackOwn: 3,
  eru: 4, eruOwn: 4,
  pa: 1, fasttrackPa: 1.5, fasttrackPaWithAttending: 0,
  pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}

const DAY = 'Monday'
const flat = v => Array(24).fill(v)

function shift(team, role_type, startMins = 0, endMins = 24 * 60) {
  return { team, role_type, resident_level: null, startMins, endMins }
}
const att = (team, s, e) => shift(team, 'Attending', s, e)
const pa = (team, s, e) => shift(team, 'PA', s, e)

function demandOf({ main = 0, fasttrack = 0, eru = 0 } = {}) {
  return {
    Main: { overall: flat(main) },
    FastTrack: { overall: flat(fasttrack) },
    ERU: { overall: flat(eru) },
  }
}

describe('scope definitions', () => {
  it('single-area scope keys are the area keys', () => {
    expect(scopeAreas('main')).toEqual(['main'])
    expect(scopeAreas('fasttrack')).toEqual(['fasttrack'])
    expect(scopeAreas('eru')).toEqual(['eru'])
  })

  it('combined scopes are compositions of existing areas', () => {
    expect(scopeAreas('mainEru')).toEqual(['main', 'eru'])
    expect(scopeAreas('wholeEd')).toEqual(['main', 'fasttrack', 'eru'])
    expect(isCombinedScope('mainEru')).toBe(true)
    expect(isCombinedScope('eru')).toBe(false)
  })

  it('accepts an explicit area list, and falls back to Main for unknown keys', () => {
    expect(scopeAreas(['fasttrack', 'eru'])).toEqual(['fasttrack', 'eru'])
    expect(scopeAreas('nope')).toEqual(SCOPES.main)
  })

  it('custom teams resolve to exactly one real area', () => {
    const customTeams = [{ name: 'Purple', area: 'ERU' }, { name: 'Orange', area: 'FastTrack' }, { name: 'Teal', area: 'Main' }]
    expect(teamArea('Purple', customTeams)).toBe('eru')
    expect(teamArea('Orange', customTeams)).toBe('fasttrack')
    expect(teamArea('Teal', customTeams)).toBe('main')
    expect(teamArea('Unknown', customTeams)).toBe('main')
    expect(teamsInArea('eru', customTeams)).toEqual(['ERU', 'Purple'])
  })
})

describe('single-area behavior is unchanged', () => {
  const shifts = [att('Green'), att('Red'), pa('Green'), att('FastTrack'), pa('FastTrack'), att('ERU')]
  const demand = demandOf({ main: 3, fasttrack: 2, eru: 5 })

  for (const area of ['main', 'fasttrack', 'eru']) {
    it(`${area}: scope capacity and demand equal the per-area functions`, () => {
      for (let h = 0; h < 24; h++) {
        expect(scopeCapacity(shifts, PPH, [], area, h)).toBe(teamCapacity(shifts, PPH, [], area, h))
      }
      const label = { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }[area]
      expect(getScopeDemandSeries(demand, area, DAY)).toEqual(getDemandSeries(demand, label, DAY))
    })
  }

  it('single-area analysis: aggregate == component, limitingNet == net', () => {
    const r = analyzeScope({ shifts, demand, pph: PPH, customTeams: [], scope: 'eru', day: DAY })
    expect(r.areas).toEqual(['eru'])
    // 1 ERU attending = 4 < demand 5 at every hour
    expect(r.hours[10].net).toBeCloseTo(-1, 5)
    expect(r.hours[10].limitingNet).toBeCloseTo(-1, 5)
    expect(r.aggregateDeficitHours).toEqual(r.componentDeficitHours)
    expect(r.deficitHoursByArea.eru).toHaveLength(24)
  })
})

describe('Main + ERU aggregation', () => {
  it('demand is the hourly sum of Main and ERU (FastTrack excluded)', () => {
    const demand = {
      Main: { overall: flat(3) },
      FastTrack: { overall: flat(100) },
      ERU: { overall: Array.from({ length: 24 }, (_, h) => h / 10) },
    }
    const series = getScopeDemandSeries(demand, 'mainEru', DAY)
    expect(series[0]).toBeCloseTo(3, 5)
    expect(series[15]).toBeCloseTo(4.5, 5)
  })

  it('aggregates percentile demand at the same target, using per-DOW data when present', () => {
    const demand = {
      Main: { overall: flat(1), pct: { by_dow: { Monday: { p90: flat(5) } }, overall: { p90: flat(4) } } },
      ERU: { overall: flat(1), pct: { overall: { p90: flat(2) } } },
    }
    expect(getScopeDemandSeries(demand, 'mainEru', DAY, 'p90')[8]).toBeCloseTo(7, 5)
  })

  it('capacity is the sum of Main and ERU capacity (FastTrack excluded)', () => {
    const shifts = [att('Green'), att('Blue'), att('ERU'), att('FastTrack')]
    // Main 2 attendings * 2 + ERU 1 * 4
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 10)).toBeCloseTo(8, 5)
  })

  it('still applies the per-team min() rule inside each area', () => {
    // Green: attending + PA (min(2, 2+1) = 2); Red: PA only, no attending (0).
    const shifts = [att('Green'), pa('Green'), pa('Red'), att('ERU')]
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 10)).toBeCloseTo(2 + 4, 5)
  })
})

describe('Whole ED aggregation', () => {
  it('demand is the hourly sum of all three areas', () => {
    const demand = demandOf({ main: 6, fasttrack: 2.5, eru: 1.25 })
    expect(getScopeDemandSeries(demand, 'wholeEd', DAY)[12]).toBeCloseTo(9.75, 5)
  })

  it('missing area demand counts as zero rather than throwing', () => {
    const demand = { Main: { overall: flat(2) } }
    expect(getScopeDemandSeries(demand, 'wholeEd', DAY)[3]).toBeCloseTo(2, 5)
  })

  it('capacity is the sum of all three areas, including solo FastTrack PA capacity', () => {
    // Main 1 att = 2; FastTrack: no attending, solo PA = 1.5; ERU 1 att = 4
    const shifts = [att('Green'), pa('FastTrack'), att('ERU')]
    expect(scopeCapacity(shifts, PPH, [], 'wholeEd', 10)).toBeCloseTo(7.5, 5)
  })

  it('capacity breakdown sums components and keeps per-area values', () => {
    const shifts = [att('Green'), pa('Green'), att('FastTrack'), pa('FastTrack'), att('ERU')]
    const b = scopeCapacityBreakdown(shifts, PPH, [], 'wholeEd', 10)
    expect(b.byArea.main.cap).toBeCloseTo(2, 5)
    expect(b.byArea.fasttrack.cap).toBeCloseTo(3 + 1.5, 5) // min(3, 3 + 0) + solo 1.5
    expect(b.byArea.eru.cap).toBeCloseTo(4, 5)
    expect(b.cap).toBeCloseTo(10.5, 5)
    expect(b.supervisionCeiling).toBeCloseTo(2 + 3 + 4, 5)
    expect(b.solo).toBeCloseTo(1.5, 5)
  })

  it('team breakdown spans every area and tags each row with its area', () => {
    const shifts = [att('Green'), att('FastTrack'), att('ERU')]
    const rows = scopeTeamBreakdown(shifts, PPH, [], 'wholeEd', 10)
    expect(rows.map(r => [r.team, r.area])).toEqual([['Green', 'main'], ['FastTrack', 'fasttrack'], ['ERU', 'eru']])
  })
})

describe('component-area deficits stay visible in combined scopes', () => {
  // Main: 1 attending = 2 vs demand 6 -> -4. ERU: 1 attending = 4 vs demand 0 -> +4.
  const shifts = [att('Green'), att('ERU')]
  const demand = demandOf({ main: 6, eru: 0 })
  const r = analyzeScope({ shifts, demand, pph: PPH, customTeams: [], scope: 'mainEru', day: DAY })

  it('aggregate nets to zero', () => {
    expect(r.hours[10].demand).toBeCloseTo(6, 5)
    expect(r.hours[10].capacity).toBeCloseTo(6, 5)
    expect(r.hours[10].net).toBeCloseTo(0, 5)
    expect(r.aggregateDeficitHours).toEqual([])
  })

  it('each component result is still accessible', () => {
    expect(r.hours[10].byArea.main.net).toBeCloseTo(-4, 5)
    expect(r.hours[10].byArea.eru.net).toBeCloseTo(4, 5)
    expect(r.hours[10].shortAreas).toEqual(['main'])
    expect(r.deficitHoursByArea.main).toHaveLength(24)
    expect(r.deficitHoursByArea.eru).toEqual([])
  })

  it('the actionable deficit set and limitingNet reflect the Main shortfall', () => {
    expect(r.componentDeficitHours).toHaveLength(24)
    expect(r.hours[10].limitingNet).toBeCloseTo(-4, 5)
  })

  it('when every component is covered, limitingNet is the aggregate surplus', () => {
    const covered = analyzeScope({ shifts, demand: demandOf({ main: 1, eru: 1 }), pph: PPH, customTeams: [], scope: 'mainEru', day: DAY })
    expect(covered.componentDeficitHours).toEqual([])
    expect(covered.hours[0].limitingNet).toBeCloseTo(4, 5) // (2 + 4) - (1 + 1)
  })
})

describe('custom teams within combined scopes', () => {
  const customTeams = [
    { name: 'Purple', color: '#000', area: 'ERU' },
    { name: 'Orange', color: '#000', area: 'FastTrack' },
    { name: 'Teal', color: '#000', area: 'Main' },
  ]
  const shifts = [att('Purple'), att('Orange'), att('Teal')]

  it('are counted in the area they belong to', () => {
    expect(scopeCapacity(shifts, PPH, customTeams, 'eru', 10)).toBeCloseTo(4, 5)
    expect(scopeCapacity(shifts, PPH, customTeams, 'main', 10)).toBeCloseTo(2, 5)
  })

  it('Main + ERU includes Main and ERU custom teams but not FastTrack ones', () => {
    expect(scopeCapacity(shifts, PPH, customTeams, 'mainEru', 10)).toBeCloseTo(2 + 4, 5)
  })

  it('Whole ED includes all of them', () => {
    expect(scopeCapacity(shifts, PPH, customTeams, 'wholeEd', 10)).toBeCloseTo(2 + 3 + 4, 5)
  })

  it('an ERU custom team covering an ERU deficit does not mask a Main deficit', () => {
    const r = analyzeScope({ shifts: [att('Purple'), att('Purple')], demand: demandOf({ main: 1, eru: 2 }), pph: PPH, customTeams, scope: 'mainEru', day: DAY })
    expect(r.hours[5].byArea.eru.net).toBeCloseTo(6, 5)
    expect(r.hours[5].byArea.main.net).toBeCloseTo(-1, 5)
    expect(r.hours[5].net).toBeCloseTo(5, 5)
    expect(r.componentDeficitHours).toHaveLength(24)
  })
})

describe('overnight shifts in combined scopes', () => {
  // Main 19:00-03:00 and ERU 23:00-07:00, both crossing midnight.
  const shifts = [att('Green', 19 * 60, 27 * 60), att('ERU', 23 * 60, 31 * 60)]

  it('count toward capacity on both sides of midnight', () => {
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 20)).toBeCloseTo(2, 5)
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 23)).toBeCloseTo(6, 5)
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 1)).toBeCloseTo(6, 5)
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 5)).toBeCloseTo(4, 5)
    expect(scopeCapacity(shifts, PPH, [], 'mainEru', 12)).toBe(0)
  })

  it('component deficits after a Main shift ends are flagged even while ERU is still on', () => {
    const r = analyzeScope({ shifts, demand: demandOf({ main: 1, eru: 1 }), pph: PPH, customTeams: [], scope: 'mainEru', day: DAY })
    // 03:00-06:59: ERU (+3) covers the pooled total but Main (-1) is uncovered.
    expect(r.hours[4].net).toBeCloseTo(2, 5)
    expect(r.hours[4].shortAreas).toEqual(['main'])
    expect(r.aggregateDeficitHours).not.toContain(4)
    expect(r.componentDeficitHours).toContain(4)
    // 23:00-02:59: both covered.
    expect(r.componentDeficitHours).not.toContain(0)
    expect(r.componentDeficitHours).not.toContain(23)
  })
})
