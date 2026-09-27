import { describe, it, expect } from 'vitest'
import { analyzeWeek, weekCell, weekHourSummary, weekDaySummary, consistentPatterns, isShortStatus } from './weekCoverage'
import { analyzeScope } from './scopeAnalysis'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const PPH = { main: 2, mainOwn: 2, fasttrack: 3, fasttrackOwn: 3, eru: 4, eruOwn: 4, pa: 1, fasttrackPa: 1.5, fasttrackPaWithAttending: 0 }
const flat = v => Array(24).fill(v)
const att = (team, startMins = 0, endMins = 24 * 60) => ({ team, role_type: 'Attending', resident_level: null, startMins, endMins })

// Per-day demand: `by_dow` lets each day differ; `overall` is the fallback.
function demandFor({ main, eru, fasttrack }) {
  const entry = v => (typeof v === 'function'
    ? { overall: flat(0), by_dow: Object.fromEntries(DAYS.map(d => [d, v(d)])) }
    : { overall: flat(v ?? 0) })
  return { Main: entry(main), ERU: entry(eru), FastTrack: entry(fasttrack) }
}

describe('analyzeWeek uses the same per-day analysis as the daily view', () => {
  const shiftsByDay = Object.fromEntries(DAYS.map(d => [d, [att('Green'), att('ERU')]]))
  const demand = demandFor({ main: 3, eru: 1 })
  const week = analyzeWeek({ days: DAYS, shiftsForDay: d => shiftsByDay[d], demand, pph: PPH, scope: 'mainEru' })

  it('covers all 7 days x 24 hours', () => {
    expect(week.days.map(d => d.day)).toEqual(DAYS)
    expect(week.days.every(d => d.analysis.hours.length === 24)).toBe(true)
  })

  it('cell numbers equal analyzeScope for that day and hour', () => {
    const daily = analyzeScope({ shifts: shiftsByDay.Wednesday, demand, pph: PPH, customTeams: [], scope: 'mainEru', day: 'Wednesday' })
    const cell = weekCell(week, 2, 14)
    expect(cell.day).toBe('Wednesday')
    expect(cell.net).toBeCloseTo(daily.hours[14].net, 10)
    expect(cell.capacity).toBeCloseTo(daily.hours[14].capacity, 10)
    expect(cell.demand).toBeCloseTo(daily.hours[14].demand, 10)
  })
})

describe('combined-scope cells expose which area is short', () => {
  // Main: 1 attending (2) vs 4 -> -2. ERU: 1 attending (4) vs 0 -> +4. Total +2.
  const shifts = [att('Green'), att('ERU')]
  const week = analyzeWeek({ days: DAYS, shiftsForDay: () => shifts, demand: demandFor({ main: 4, eru: 0 }), pph: PPH, scope: 'mainEru' })

  it("the 'all' layer is masked (total covered, Main short) with per-area detail", () => {
    const cell = weekCell(week, 0, 9)
    expect(cell.net).toBeCloseTo(2, 5)
    expect(cell.status).toBe('masked')
    expect(isShortStatus(cell.status)).toBe(true)
    expect(cell.shortAreas).toEqual(['main'])
    expect(cell.areas.map(a => [a.area, a.net, a.status])).toEqual([['main', -2, 'deficit'], ['eru', 4, 'excess']])
  })

  it('an area layer reports only that area', () => {
    expect(weekCell(week, 0, 9, 'main')).toMatchObject({ net: -2, status: 'deficit', shortAreas: ['main'] })
    expect(weekCell(week, 0, 9, 'eru')).toMatchObject({ net: 4, status: 'excess', shortAreas: [] })
  })
})

describe('weekly summaries and consistent patterns', () => {
  // Main demand 4 from 17:00-19:59 on weekdays only (else 2); one Green
  // attending all day (cap 2). ERU demand 0, one attending (cap 4) 02:00-05:59.
  const weekdays = DAYS.slice(0, 5)
  const mainDemand = d => flat(2).map((v, h) => (weekdays.includes(d) && h >= 17 && h <= 19 ? 4 : v))
  const shifts = [att('Green'), att('ERU', 2 * 60, 6 * 60)]
  const week = analyzeWeek({ days: DAYS, shiftsForDay: () => shifts, demand: demandFor({ main: mainDemand, eru: 0 }), pph: PPH, scope: 'mainEru' })

  it('hour summary counts the days each hour is short', () => {
    const s = weekHourSummary(week)
    expect(s[18]).toMatchObject({ hour: 18, shortDays: 5 })
    expect(s[10]).toMatchObject({ shortDays: 0 })
    expect(s[3].excessDays).toBe(7)
  })

  it('day summary counts short hours per day', () => {
    const s = weekDaySummary(week)
    expect(s[0]).toMatchObject({ day: 'Monday', shortHours: 3 })
    expect(s[6]).toMatchObject({ day: 'Sunday', shortHours: 0 })
  })

  it('merges consistently short hours into one range and names the driving area', () => {
    const short = consistentPatterns(week).filter(p => p.kind === 'short')
    expect(short).toHaveLength(1)
    expect(short[0]).toMatchObject({ startHour: 17, endHour: 20, minDays: 5, maxDays: 5, areaCounts: [{ area: 'main', count: 15 }] })
    expect(short[0].message).toBe('Main + ERU is short from 17:00–20:00 on 5 of 7 days (short in Main 15×).')
  })

  it('reports consistent excess too, and respects minDays', () => {
    const excess = consistentPatterns(week).filter(p => p.kind === 'excess')
    expect(excess.map(p => p.message)).toContain('Main + ERU has excess capacity from 02:00–06:00 on 7 of 7 days.')
    expect(consistentPatterns(week, { minDays: 6 }).filter(p => p.kind === 'short')).toEqual([])
  })

  it('per-area layers describe that area only', () => {
    const short = consistentPatterns(week, { layer: 'main' }).filter(p => p.kind === 'short')
    expect(short[0].message).toBe('Main is short from 17:00–20:00 on 5 of 7 days.')
    expect(consistentPatterns(week, { layer: 'eru' }).filter(p => p.kind === 'short')).toEqual([])
  })
})

describe('pattern ordering', () => {
  it('puts the range with the most short day-hours first, not the earliest', () => {
    // Main short 01:00 on 4 days (4 day-hours) and 12:00-15:59 on 7 days (28).
    const early = ['Monday', 'Tuesday', 'Wednesday', 'Thursday']
    const mainDemand = d => flat(2).map((v, h) => ((h === 1 && early.includes(d)) || (h >= 12 && h <= 15) ? 3 : v))
    const week = analyzeWeek({ days: DAYS, shiftsForDay: () => [att('Green')], demand: demandFor({ main: mainDemand }), pph: PPH, scope: 'main' })
    const short = consistentPatterns(week).filter(p => p.kind === 'short')
    expect(short.map(p => [p.startHour, p.dayHours])).toEqual([[12, 28], [1, 4]])
  })
})

describe('overnight shifts in the week view', () => {
  it('a shift wrapping midnight covers the early hours of the same day', () => {
    const shifts = [att('ERU', 22 * 60, 30 * 60)] // 22:00-06:00
    const week = analyzeWeek({ days: DAYS, shiftsForDay: () => shifts, demand: demandFor({ eru: 1 }), pph: PPH, scope: 'eru' })
    expect(weekCell(week, 0, 3).capacity).toBeCloseTo(4, 5)
    expect(weekCell(week, 0, 23).capacity).toBeCloseTo(4, 5)
    expect(weekCell(week, 0, 12).status).toBe('deficit')
    const short = consistentPatterns(week).filter(p => p.kind === 'short')
    expect(short.map(p => [p.startHour, p.endHour])).toEqual([[6, 22]])
  })
})
