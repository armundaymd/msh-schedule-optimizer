import { describe, it, expect } from 'vitest'
import { generateSchedule, assignTeams, applyGeneratedAttendings, attendingHoursAndCost } from './generator'
import { DEFAULT_PATTERNS, anyStartPatterns } from './patterns'
import { shiftCoversHour, teamCapacity } from '../../shared/capacity'
import { teamsInArea } from '../../shared/areas'

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
    // Local search may re-center a shift around the demand block it's
    // covering (see the peak-centering objective term) rather than leaving
    // it at greedy's original pick, so this only checks the wraparound
    // arithmetic itself: any shift that starts before midnight and covers
    // hour 0 must have endMins > 1440.
    const wrapping = result.shifts.find(s => s.startMins < 1440 && s.endMins > 1440)
    expect(wrapping).toBeDefined()
    expect(wrapping.endMins).toBe(wrapping.startMins + 8 * 60)
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

describe('generateSchedule local search stays within the caller\'s limits (validation S11/S17 regressions)', () => {
  it('never exceeds hourBudget, even when a longer shift would close more deficit', () => {
    // 24h demand, 16h budget, 8h and 12h shifts allowed: greedy stops at 16h;
    // local search used to swap one shift to 12h (20h total).
    const patterns = [...anyStartPatterns(8), ...anyStartPatterns(12)]
    const result = generateSchedule({
      demand: flatDemand(2), target: 'mean', day: 'Monday', area: 'main', patterns,
      constraints: { ...BASE_CONSTRAINTS, hourBudget: 16 }, pph: PPH,
    })
    const hours = result.shifts.reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)
    expect(hours).toBeLessThanOrEqual(16)
  })

  it('only returns (start, length) patterns from the menu it was given', () => {
    // Demand 08-16 with today's menu (07/09/11/15/17/23 starts): local search
    // used to slide 07:00 to an invented 05:00 start on a centering tie-break.
    const result = generateSchedule({
      demand: flatDemand(2, [8, 9, 10, 11, 12, 13, 14, 15]), target: 'mean', day: 'Monday', area: 'main',
      patterns: DEFAULT_PATTERNS, constraints: BASE_CONSTRAINTS, pph: PPH,
    })
    const menu = new Set(DEFAULT_PATTERNS.map(p => `${p.start}/${p.length}`))
    for (const s of result.shifts) expect(menu.has(`${s.startMins / 60}/${(s.endMins - s.startMins) / 60}`)).toBe(true)
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

  it('prefers the lane with the smaller gap over the first available one', () => {
    // Green's morning shift ends at 13:00, Red's ends at 15:00. A new
    // shift starting at 15:00 fits in either lane without overlapping, but
    // only Red's is adjacent (gap 0) -- picking Green instead (the
    // first-available lane, ignoring gap size) would leave Green idle for
    // 2 hours and an unrelated pair sharing Red's lane with a gap.
    const shifts = [
      { startMins: 7 * 60, endMins: 13 * 60 },  // -> Green (lane 0, shorter)
      { startMins: 7 * 60, endMins: 15 * 60 },  // -> Red (lane 1, longer)
      { startMins: 15 * 60, endMins: 23 * 60 }, // touches Red's end exactly
    ]
    const { shifts: assigned } = assignTeams(shifts, 'main', [])
    const red = assigned.filter(s => s.team === 'Red').sort((a, b) => a.startMins - b.startMins)
    expect(red).toHaveLength(2)
    expect(red[1].startMins).toBe(red[0].endMins) // back-to-back, no gap
    const green = assigned.filter(s => s.team === 'Green')
    expect(green).toHaveLength(1) // left alone, not stretched with a gap
  })
})

describe('applying a generated schedule replaces attendings only', () => {
  function shift(team, role_type, startH, endH, extra = {}) {
    return { id: `${team}-${role_type}-${startH}-${extra.resident_level ?? ''}`, day: 'Monday', team, role_type,
      role_detail: extra.resident_level ?? role_type, resident_level: null, startMins: startH * 60, endMins: endH * 60, ...extra }
  }
  const existing = [
    shift('Green', 'Attending', 7, 15),
    shift('Green', 'Resident', 7, 19, { resident_level: 'PGY-4', role_detail: 'Senior' }),
    shift('Red', 'Resident', 9, 21, { resident_level: 'PGY-1', role_detail: 'EM1' }),
    shift('Red', 'PA', 11, 23),
    shift('FastTrack', 'Attending', 9, 17), // another area
    shift('FastTrack', 'PA', 9, 21),
  ]
  const generated = [shift('Green', 'Attending', 8, 16), shift('Red', 'Attending', 8, 16)]
  const merged = applyGeneratedAttendings(existing, generated, teamsInArea('main', []))

  it('resident shifts survive unchanged, including their level and team', () => {
    const residents = existing.filter(s => s.role_type === 'Resident')
    for (const r of residents) expect(merged).toContainEqual(r)
    expect(merged.filter(s => s.role_type === 'Resident').map(s => [s.team, s.resident_level, s.role_detail]))
      .toEqual([['Green', 'PGY-4', 'Senior'], ['Red', 'PGY-1', 'EM1']])
  })

  it('PA/extender shifts survive unchanged', () => {
    for (const p of existing.filter(s => s.role_type === 'PA')) expect(merged).toContainEqual(p)
  })

  it("the area's attending shifts are replaced by the generated ones; other areas are untouched", () => {
    const mainAttendings = merged.filter(s => s.role_type === 'Attending' && ['Green', 'Red', 'Blue'].includes(s.team))
    expect(mainAttendings).toEqual(generated)
    expect(merged).toContainEqual(existing[4])
    expect(merged).toHaveLength(existing.length - 1 + generated.length)
  })
})

describe('app capacity after applying Generate vs the generator\'s own model', () => {
  // The generator's documented assumption: each attending delivers the area's
  // supervision ceiling (pph[area]); residents/PAs are assumed to be there to
  // supervise. With the extenders now kept, app capacity equals the
  // generator's model wherever each attending's team has enough extenders
  // (own + extenders >= ceiling), and never exceeds it apart from FastTrack
  // solo-PA capacity, which the generator does not model.
  const REAL = { main: 2.1, mainOwn: 1.3, pgy2: 0.8, pgy3: 1.1, pa: 1.2, fasttrack: 3.5, fasttrackOwn: 2.2, fasttrackPa: 1.5, fasttrackPaWithAttending: 0 }
  const res = (team, level) => ({ day: 'Monday', team, role_type: 'Resident', resident_level: level, role_detail: level, startMins: 480, endMins: 960 })
  const peak = [8, 9, 10, 11, 12, 13, 14, 15]

  function generateAndApply(existing, demandValue) {
    const out = generateSchedule({
      demand: flatDemand(demandValue, peak), target: 'mean', day: 'Monday', area: 'main',
      patterns: [{ start: 0, length: 8 }, { start: 8, length: 8 }, { start: 16, length: 8 }],
      constraints: BASE_CONSTRAINTS, pph: REAL,
    })
    const { shifts } = assignTeams(out.shifts, 'main', [], [])
    const merged = applyGeneratedAttendings(existing, shifts, teamsInArea('main', []))
    const claimed = h => shifts.filter(s => shiftCoversHour(s, h)).length * REAL.main
    return { merged, claimed, shifts }
  }

  it('matches exactly when every generated attending has enough residents to supervise', () => {
    // 4.2/hr needs 2 attendings at the 2.1 ceiling; they land on Green and Red,
    // which each have a resident worth >= 0.8 (ceiling - own).
    const { merged, claimed, shifts } = generateAndApply([res('Green', 'PGY-2'), res('Red', 'PGY-3')], 4.2)
    expect(shifts.map(s => s.team).sort()).toEqual(['Green', 'Red'])
    for (let h = 0; h < 24; h++) expect(teamCapacity(merged, REAL, [], 'main', h)).toBeCloseTo(claimed(h), 10)
  })

  it('never exceeds the model, and falls short where a team has no residents (documented ceiling assumption)', () => {
    // Only Green has a resident: Red's attending works alone at 1.3, not 2.1.
    const { merged, claimed } = generateAndApply([res('Green', 'PGY-2')], 4.2)
    for (let h = 0; h < 24; h++) expect(teamCapacity(merged, REAL, [], 'main', h)).toBeLessThanOrEqual(claimed(h) + 1e-9)
    expect(teamCapacity(merged, REAL, [], 'main', 10)).toBeCloseTo(2.1 + 1.3, 10)
  })
})

describe('generator "vs baseline" cost is attending-for-attending', () => {
  const RATE = 250
  const MAIN = teamsInArea('main', [])
  const s = (team, role_type, startH, endH) => ({ team, role_type, startMins: startH * 60, endMins: endH * 60 })
  const baseline = [s('Green', 'Attending', 7, 15), s('Red', 'Attending', 15, 23)] // 16 attending hours

  it('resident hours do not increase baseline attending cost', () => {
    const withResidents = [...baseline, s('Green', 'Resident', 7, 19), s('Red', 'Resident', 9, 21)]
    expect(attendingHoursAndCost(withResidents, MAIN, RATE)).toEqual(attendingHoursAndCost(baseline, MAIN, RATE))
  })

  it('PA/extender hours do not increase baseline attending cost', () => {
    const withPAs = [...baseline, s('Blue', 'PA', 11, 23), s('Green', 'NP', 7, 19)]
    expect(attendingHoursAndCost(withPAs, MAIN, RATE)).toEqual(attendingHoursAndCost(baseline, MAIN, RATE))
  })

  it('attending hours do increase baseline attending cost', () => {
    expect(attendingHoursAndCost(baseline, MAIN, RATE)).toEqual({ hours: 16, cost: 16 * RATE })
    const more = attendingHoursAndCost([...baseline, s('Blue', 'Attending', 23, 31)], MAIN, RATE) // overnight
    expect(more).toEqual({ hours: 24, cost: 24 * RATE })
  })

  it('generated vs baseline compares the same role category', () => {
    // Generated attendings replace the baseline attendings one-for-one, with
    // residents/PAs kept (applyGeneratedAttendings): equal attending hours
    // must mean equal cost, whatever the extender mix.
    const existing = [...baseline, s('Green', 'Resident', 7, 19), s('Red', 'PA', 9, 21)]
    const generated = [s('Green', 'Attending', 8, 16), s('Red', 'Attending', 16, 24)]
    const after = applyGeneratedAttendings(existing, generated, MAIN)
    const gen = attendingHoursAndCost(after, MAIN, RATE)
    const base = attendingHoursAndCost(existing, MAIN, RATE)
    expect(gen).toEqual(attendingHoursAndCost(generated, MAIN, RATE))
    expect(gen.cost).toBe(base.cost)
  })

  it('combined scopes count attendings on every included area and nothing else', () => {
    const mainEru = [...teamsInArea('main', []), ...teamsInArea('eru', [])]
    const shifts = [
      ...baseline,                              // Main attendings: 16 h
      s('ERU', 'Attending', 8, 20),            // ERU attending: 12 h
      s('ERU', 'Resident', 8, 20),             // not an attending
      s('FastTrack', 'Attending', 9, 17),      // outside the scope
    ]
    expect(attendingHoursAndCost(shifts, mainEru, RATE)).toEqual({ hours: 28, cost: 28 * RATE })
  })
})

