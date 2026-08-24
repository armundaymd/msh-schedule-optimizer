import { describe, it, expect } from 'vitest'
import { generateSchedule, assignTeams } from './generator'
import { DEFAULT_PATTERNS, anyStartPatterns } from './patterns'
import { shiftCoversHour } from '../../shared/capacity'

const PPH = { main: 2.0, mainOwn: 1.0 }

function flatDemand(value, hours = null) {
  const series = Array(24).fill(0)
  const targetHours = hours ?? Array.from({ length: 24 }, (_, h) => h)
  for (const h of targetHours) series[h] = value
  return { Main: { overall: series, by_dow: {}, pct: { overall: {}, by_dow: {} } } }
}

const BASE_CONSTRAINTS = { minConcurrent: 0, maxConcurrent: 3, overnightMin: 0, overnightHours: [], costPerHour: 100 }

describe('generateSchedule', () => {
  it('covers flat daytime demand within a capacity multiple, near zero uncovered', () => {
    // demand 2/hr for hours 8-16, attending capacity (ceiling) = 2/hr -> need ~1 concurrent attending
    const demand = flatDemand(2, [8, 9, 10, 11, 12, 13, 14, 15])
    const result = generateSchedule({
      demand, target: 'mean', day: 'Monday', area: 'main',
      patterns: DEFAULT_PATTERNS, constraints: BASE_CONSTRAINTS, pph: PPH,
    })
    const totalUncovered = result.uncovered.reduce((a, b) => a + b, 0)
    expect(totalUncovered).toBeLessThan(2) // small edge effects from 8h blocks are fine, not large gaps
    expect(result.shifts.length).toBeGreaterThan(0)
  })

  it('respects maxConcurrent: demand beyond what maxConcurrent*c can supply stays uncovered', () => {
    // demand 10/hr all day, capacity (ceiling) 2/hr, maxConcurrent 2 -> cap is 4/hr, so ~6/hr uncovered
    const demand = flatDemand(10)
    const result = generateSchedule({
      demand, target: 'mean', day: 'Monday', area: 'main',
      patterns: anyStartPatterns(8), constraints: { ...BASE_CONSTRAINTS, maxConcurrent: 2 }, pph: PPH,
    })
    for (let h = 0; h < 24; h++) {
      expect(result.uncovered[h]).toBeGreaterThan(5)
    }
    // never exceeds maxConcurrent at any hour
    for (let h = 0; h < 24; h++) {
      const coveringCount = result.shifts.filter(s => {
        const hStart = h * 60, hEnd = hStart + 60
        return s.endMins <= 1440 ? s.startMins < hEnd && s.endMins > hStart : s.startMins < hEnd || hStart < s.endMins - 1440
      }).length
      expect(coveringCount).toBeLessThanOrEqual(2)
    }
  })

  it('minConcurrent adds coverage even with zero demand', () => {
    const demand = flatDemand(0)
    const result = generateSchedule({
      demand, target: 'mean', day: 'Monday', area: 'main',
      patterns: anyStartPatterns(8), constraints: { ...BASE_CONSTRAINTS, minConcurrent: 1 }, pph: PPH,
    })
    expect(result.shifts.length).toBeGreaterThan(0)
    // every hour has at least one covering shift
    for (let h = 0; h < 24; h++) {
      const covered = result.shifts.some(s => {
        const hStart = h * 60, hEnd = hStart + 60
        return s.endMins <= 1440 ? s.startMins < hEnd && s.endMins > hStart : s.startMins < hEnd || hStart < s.endMins - 1440
      })
      expect(covered).toBe(true)
    }
  })

  it('overnight pattern (23:00 start, 8h) produces a shift covering hour 0 (circular hours)', () => {
    const demand = flatDemand(5, [23, 0, 1, 2])
    const result = generateSchedule({
      demand, target: 'mean', day: 'Monday', area: 'main',
      patterns: [{ start: 23, length: 8 }], constraints: BASE_CONSTRAINTS, pph: PPH,
    })
    expect(result.shifts.length).toBeGreaterThan(0)
    const s = result.shifts[0]
    expect(s.startMins).toBe(23 * 60)
    expect(s.endMins).toBe(31 * 60) // 23 + 8 = 31, past midnight
  })

  it('hourBudget caps total shift-hours added', () => {
    const demand = flatDemand(10)
    const result = generateSchedule({
      demand, target: 'mean', day: 'Monday', area: 'main',
      patterns: DEFAULT_PATTERNS, constraints: { ...BASE_CONSTRAINTS, maxConcurrent: 10, hourBudget: 16 }, pph: PPH,
    })
    const totalHours = result.shifts.reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
    expect(totalHours).toBeLessThanOrEqual(16)
  })

  it('ids are prefixed distinctly from normalizeShifts\' day-team-role-index scheme', () => {
    const demand = flatDemand(3, [10])
    const result = generateSchedule({
      demand, target: 'mean', day: 'Monday', area: 'main',
      patterns: DEFAULT_PATTERNS, constraints: BASE_CONSTRAINTS, pph: PPH,
    })
    for (const s of result.shifts) expect(s.id.startsWith('gen-')).toBe(true)
  })

  it('does not overbook an early hour just to reach a later peak, when a staggered start covers it exactly as well', () => {
    // A ramp from 3/hr up to 11/hr peaking midday, capacity 2.1/hr. Hour 9
    // needs exactly ceil(7/2.1) = 4 concurrent -- two identical 09:00-17:00
    // blocks would leave 5 concurrent there (needless surplus) when a
    // second shift starting at 10 or 11 covers the peak just as well.
    const demandSeries = [6, 5, 4, 3, 3, 4, 4, 3, 5, 7, 9, 10, 11, 11, 11, 9, 10, 10, 9, 7, 8, 7, 6, 4]
    const demand = { Main: { overall: demandSeries, by_dow: {}, pct: { overall: {}, by_dow: {} } } }
    const pph = { main: 2.1 }
    const constraints = { minConcurrent: 1, maxConcurrent: 6, overnightMin: 0, overnightHours: [23, 0, 1, 2, 3, 4, 5, 6], maxStartsPerHour: 6, costPerHour: 250 }

    const result = generateSchedule({ demand, target: 'mean', day: 'Monday', area: 'main', patterns: DEFAULT_PATTERNS, constraints, pph })
    const concurrencyAt = h => result.shifts.filter(s => shiftCoversHour(s, h)).length

    expect(concurrencyAt(9)).toBeLessThanOrEqual(Math.ceil(demandSeries[9] / pph.main))
  })
})

describe('assignTeams', () => {
  it('never assigns overlapping shifts to the same team', () => {
    const shifts = [
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 9 * 60, endMins: 17 * 60 },
      { startMins: 11 * 60, endMins: 19 * 60 },
    ]
    const { shifts: assigned } = assignTeams(shifts, 'main', [])
    const byTeam = {}
    for (const s of assigned) (byTeam[s.team] ??= []).push(s)
    for (const teamShifts of Object.values(byTeam)) {
      for (let i = 0; i < teamShifts.length; i++) {
        for (let j = i + 1; j < teamShifts.length; j++) {
          const a = teamShifts[i], b = teamShifts[j]
          const overlap = a.startMins < b.endMins && a.endMins > b.startMins
          expect(overlap).toBe(false)
        }
      }
    }
  })

  it('uses named teams first (Green, Red, Blue for main)', () => {
    const shifts = [
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 7 * 60, endMins: 15 * 60 },
    ]
    const { shifts: assigned, newTeams } = assignTeams(shifts, 'main', [])
    expect(new Set(assigned.map(s => s.team))).toEqual(new Set(['Green', 'Red', 'Blue']))
    expect(newTeams).toHaveLength(0)
  })

  it('creates a new team when concurrency exceeds the named team count', () => {
    const shifts = [
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 7 * 60, endMins: 15 * 60 }, // 4th overlapping shift, only 3 named Main teams
    ]
    const { shifts: assigned, newTeams } = assignTeams(shifts, 'main', [])
    expect(newTeams).toHaveLength(1)
    expect(assigned.some(s => s.team === newTeams[0].name)).toBe(true)
  })

  it('FastTrack has only one named team, so a second concurrent shift creates a new team', () => {
    const shifts = [
      { startMins: 7 * 60, endMins: 15 * 60 },
      { startMins: 7 * 60, endMins: 15 * 60 },
    ]
    const { shifts: assigned, newTeams } = assignTeams(shifts, 'fasttrack', [])
    expect(assigned.some(s => s.team === 'FastTrack')).toBe(true)
    expect(newTeams).toHaveLength(1)
    expect(newTeams[0].area).toBe('FastTrack')
  })
})
