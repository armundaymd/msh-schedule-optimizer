import { describe, it, expect } from 'vitest'
import { getDemandSeries, hasPercentiles } from './demandSeries'

const MEAN_OVERALL = Array.from({ length: 24 }, (_, h) => h)
const MEAN_MONDAY = Array.from({ length: 24 }, (_, h) => h + 100)
const P75_OVERALL = Array.from({ length: 24 }, (_, h) => h + 200)
const P75_MONDAY = Array.from({ length: 24 }, (_, h) => h + 300)

const DEMAND_WITH_PCT = {
  Main: {
    overall: MEAN_OVERALL,
    by_dow: { Monday: MEAN_MONDAY },
    pct: {
      overall: { p75: P75_OVERALL },
      by_dow: { Monday: { p75: P75_MONDAY } },
    },
  },
}

describe('getDemandSeries', () => {
  it('mean target: returns by_dow series for the requested day', () => {
    expect(getDemandSeries(DEMAND_WITH_PCT, 'Main', 'Monday', 'mean')).toBe(MEAN_MONDAY)
  })

  it('mean target: falls back to overall when the day has no by_dow entry', () => {
    expect(getDemandSeries(DEMAND_WITH_PCT, 'Main', 'Tuesday', 'mean')).toBe(MEAN_OVERALL)
  })

  it('percentile target: returns by_dow percentile when available', () => {
    expect(getDemandSeries(DEMAND_WITH_PCT, 'Main', 'Monday', 'p75')).toBe(P75_MONDAY)
  })

  it('percentile target: falls back to overall percentile when the day has none', () => {
    expect(getDemandSeries(DEMAND_WITH_PCT, 'Main', 'Tuesday', 'p75')).toBe(P75_OVERALL)
  })

  it('percentile target: falls back to the day mean when no percentile data exists at all', () => {
    const demand = { Main: { overall: MEAN_OVERALL, by_dow: { Monday: MEAN_MONDAY } } }
    expect(getDemandSeries(demand, 'Main', 'Monday', 'p90')).toBe(MEAN_MONDAY)
  })

  it('percentile target: falls back to overall mean when nothing else exists', () => {
    const demand = { Main: { overall: MEAN_OVERALL } }
    expect(getDemandSeries(demand, 'Main', 'Monday', 'p90')).toBe(MEAN_OVERALL)
  })

  it('never throws: unknown team returns 24 zeros', () => {
    expect(getDemandSeries(DEMAND_WITH_PCT, 'FastTrack', 'Monday', 'mean')).toEqual(Array(24).fill(0))
  })

  it('never throws: null demand returns 24 zeros', () => {
    expect(getDemandSeries(null, 'Main', 'Monday', 'mean')).toEqual(Array(24).fill(0))
  })
})

describe('hasPercentiles', () => {
  it('true when at least one team has pct.overall', () => {
    expect(hasPercentiles(DEMAND_WITH_PCT)).toBe(true)
  })

  it('false when no team has percentile data (production before pipeline refresh)', () => {
    expect(hasPercentiles({ Main: { overall: MEAN_OVERALL } })).toBe(false)
  })

  it('false for null/undefined demand', () => {
    expect(hasPercentiles(null)).toBe(false)
    expect(hasPercentiles(undefined)).toBe(false)
  })
})
