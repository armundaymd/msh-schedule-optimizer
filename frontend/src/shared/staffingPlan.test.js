import { describe, it, expect } from 'vitest'
import {
  weeklyBudget, isLockedShift, buildPlanInstance, applyPlanResult, schedulePlanMetrics, capacityCrossCheck,
} from './staffingPlan'
import { teamCapacityForTeam, shiftCoversHour } from './capacity'
import { getDemandSeries } from './demandSeries'
import { analyzeWeek } from './weekCoverage'

const DAYS = ['Monday', 'Tuesday']
const PPH = {
  main: 2.1, mainOwn: 1.3, fasttrack: 3.5, fasttrackOwn: 2.2, eru: 0.8, eruOwn: 0.6,
  pa: 1.2, fasttrackPa: 1.2, fasttrackPaWithAttending: 0, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const flat = v => Array(24).fill(v)
const demand = { Main: { overall: flat(4) }, FastTrack: { overall: flat(2) }, ERU: { overall: flat(1) } }
const PATTERNS = [{ start: 7, length: 8 }, { start: 15, length: 8 }, { start: 23, length: 8 }]

let seq = 0
function sh(team, role_type, startH, endH, extra = {}) {
  return { id: `s${seq++}`, team, role_type, resident_level: role_type === 'Resident' ? 'PGY-2' : null,
    startMins: startH * 60, endMins: endH * 60, start_time: '', end_time: '', ...extra }
}

// Monday and Tuesday share one schedule.
const SCHEDULE = [
  sh('Green', 'Attending', 7, 15),
  sh('Green', 'Resident', 7, 19),
  sh('Red', 'Attending', 23, 31), // overnight
  sh('FastTrack', 'Attending', 9, 17),
  sh('FastTrack', 'PA', 9, 21),
  sh('ERU', 'Attending', 8, 20),
]
const shiftsForDay = day => SCHEDULE.map(s => ({ ...s, day }))

function build(overrides = {}) {
  return buildPlanInstance({
    days: DAYS, shiftsForDay, customTeams: [], pph: PPH, demand, scope: 'mainEru',
    patterns: PATTERNS, weeklyBudgetHours: 100, ...overrides,
  })
}

describe('weeklyBudget', () => {
  it('annual hours divide by 52 without rounding', () => {
    const b = weeklyBudget(10000, 'annual')
    expect(b.weeklyHours).toBeCloseTo(192.3077, 4)
    expect(b.annualHours).toBeCloseTo(10000, 6)
  })
  it('weekly hours pass through and annualise x52', () => {
    expect(weeklyBudget(200, 'weekly')).toEqual({ weeklyHours: 200, annualHours: 10400 })
  })
})

describe('buildPlanInstance', () => {
  const { instance, context } = build()

  it('includes only the scope areas, each with its teams plus a flex pool', () => {
    expect(instance.areas.map(a => a.key)).toEqual(['main', 'eru'])
    const main = instance.areas[0]
    expect(main.slots.map(s => s.id)).toEqual(['Green', 'Red', 'Blue', 'main:flex'])
  })

  it('capacity tables are capacity.js teamCapacityForTeam with the team\'s own residents', () => {
    const green = instance.areas[0].slots[0]
    const resident = SCHEDULE[1]
    const att = n => Array.from({ length: n }, () => ({ team: 'Green', role_type: 'Attending', startMins: 600, endMins: 660 }))
    // 10:00 — resident on: 1 attending is capped by the 2.1 ceiling (1.3 own + 0.8 resident).
    expect(green.capacity[0][10]).toEqual([0, 1].map(n =>
      teamCapacityForTeam([resident, ...att(n)], PPH, 'main', 'Green', 10)))
    expect(green.capacity[0][10][1]).toBeCloseTo(2.1, 10)
    // 20:00 — no resident: own throughput only.
    expect(green.capacity[0][20][1]).toBeCloseTo(1.3, 10)
  })

  it('flex pool capacity is linear own throughput (no extenders)', () => {
    const flex = instance.areas[0].slots.at(-1)
    expect(flex.flex).toBe(true)
    expect(flex.capacity[0][12].map(v => Number(v.toFixed(6)))).toEqual([0, 1.3, 2.6, 3.9])
  })

  it('demand and excess tolerance come from getDemandSeries and the shared thresholds', () => {
    expect(instance.areas[0].demand[1]).toEqual(getDemandSeries(demand, 'Main', 'Tuesday', 'mean'))
    expect(instance.areas[0].excessTolerance[0][0]).toBe(1) // max(1, 0.25 * 4)
  })

  it('without locks, scope attendings are re-planned and everything else is kept', () => {
    const kept = context.keptByDay.Monday.map(s => `${s.team}/${s.role_type}`)
    expect(kept).toEqual(['Green/Resident', 'FastTrack/Attending', 'FastTrack/PA'])
    expect(instance.lockedHours).toBe(0)
  })

  it('lock rules keep matching current shifts, count them, and charge their hours', () => {
    const locked = build({ lockRules: [{ area: 'main', fromHour: 19, toHour: 7 }] }) // overnight starts
    expect(locked.instance.lockedHours).toBe(16) // Red 23:00-07:00 on two days
    const red = locked.instance.areas[0].slots[1]
    expect(red.locked[0][2]).toBe(1)
    expect(red.locked[0][12]).toBe(0)
    expect(locked.context.keptByDay.Monday.some(s => s.team === 'Red')).toBe(true)
    expect(isLockedShift(SCHEDULE[0], 'main', [], [{ area: 'main', fromHour: 19, toHour: 7 }])).toBe(false)
    expect(isLockedShift(SCHEDULE[0], 'main', [], [{ area: 'main', fromHour: 0, toHour: 0 }])).toBe(true)
  })

  it('minimum coverage rules expand to area-hours', () => {
    const { instance: i } = build({ minCoverageRules: [{ area: 'eru', fromHour: 8, toHour: 20, min: 1 }] })
    const eru = i.areas[1]
    expect(eru.minCoverage[0].slice(6, 22)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
    expect(i.areas[0].minCoverage[0].every(v => v === 0)).toBe(true)
  })

  it('custom teams join their own area as slots', () => {
    const customTeams = [{ name: 'Purple', color: '#000', area: 'ERU' }]
    const { instance: i } = build({ customTeams })
    expect(i.areas[1].slots.map(s => s.id)).toEqual(['ERU', 'Purple', 'eru:flex'])
  })

  it('FastTrack solo PAs appear as capacity with zero attendings', () => {
    const { instance: i } = build({ scope: 'fasttrack', pph: { ...PPH, fasttrackPa: 1.5 } })
    const ft = i.areas[0].slots[0]
    expect(ft.capacity[0][10][0]).toBeCloseTo(1.5, 10)
  })
})

describe('applyPlanResult', () => {
  const { context } = build({ lockRules: [{ area: 'main', fromHour: 19, toHour: 7 }] })
  const result = {
    shifts: [
      { area: 'main', slot: 'Green', flex: false, day: 'Monday', start: 7, length: 8 },
      { area: 'main', slot: 'main:flex', flex: true, day: 'Monday', start: 9, length: 8 },
      { area: 'main', slot: 'main:flex', flex: true, day: 'Monday', start: 11, length: 8 },
      { area: 'main', slot: 'main:flex', flex: true, day: 'Tuesday', start: 9, length: 8 },
      { area: 'eru', slot: 'ERU', flex: false, day: 'Monday', start: 23, length: 8 },
    ],
  }
  const customTeams = [{ name: 'Plan Main 1', color: '#000', area: 'Main' }]
  const { proposedByDay, newTeams } = applyPlanResult(result, context, customTeams)

  it('places existing-team shifts on that team and keeps locked shifts', () => {
    const mon = proposedByDay.Monday
    expect(mon.filter(s => s.team === 'Green' && s.role_type === 'Attending').map(s => s.start_time)).toEqual(['07:00'])
    expect(mon.some(s => s.team === 'Red' && s.startMins === 23 * 60)).toBe(true)
  })

  it('packs flex shifts into the fewest non-overlapping new teams, reused across days, with unique names', () => {
    expect(newTeams.map(t => t.name)).toEqual(['Plan Main 2', 'Plan Main 3'])
    expect(newTeams.every(t => t.area === 'Main')).toBe(true)
    const byTeam = name => proposedByDay.Monday.filter(s => s.team === name)
    expect(byTeam('Plan Main 2')).toHaveLength(1)
    expect(byTeam('Plan Main 3')).toHaveLength(1)
    expect(proposedByDay.Tuesday.filter(s => s.team === 'Plan Main 2')).toHaveLength(1)
  })

  it('overnight planned shifts wrap like the rest of the app', () => {
    const eru = proposedByDay.Monday.find(s => s.team === 'ERU' && s.role_type === 'Attending')
    expect(eru.endMins).toBe(31 * 60)
    expect(eru.end_time).toBe('07:00')
    expect(shiftCoversHour(eru, 3)).toBe(true)
  })
})

describe('plan metrics', () => {
  it('reports per-area deficits that the pooled aggregate would hide', () => {
    // Main: nobody on vs 4 demand. ERU: one attending at a high PPH, so
    // ERU carries a surplus big enough to cover Main in the pooled total.
    const pph = { ...PPH, eru: 8, eruOwn: 8 }
    const shifts = [sh('ERU', 'Attending', 0, 24)]
    const m = schedulePlanMetrics({
      days: ['Monday'], shiftsForDay: () => shifts, customTeams: [], pph,
      demand: { Main: { overall: flat(4) }, ERU: { overall: flat(0) } }, scope: 'mainEru', target: 'mean',
    })
    expect(m.aggregate.uncoveredPphHours).toBe(0)
    expect(m.byArea.main.uncoveredPphHours).toBeCloseTo(96, 6)
    expect(m.componentUncoveredPphHours).toBeCloseTo(96, 6)
    expect(m.byArea.main.severeDeficitHours).toBe(24)
    expect(m.byArea.eru.excessHours).toBe(24)
    expect(m.byArea.eru.attendingHours).toBe(24)
    expect(m.byArea.main.unattendedDemandHours).toBe(24)
    expect(m.byArea.eru.unattendedDemandHours).toBe(0)
  })

  it('capacityCrossCheck is ~0 when the solver capacity matches capacity.js', () => {
    const { context } = build()
    const result = { shifts: [{ area: 'main', slot: 'Green', flex: false, day: 'Monday', start: 7, length: 8 }] }
    const { proposedByDay } = applyPlanResult(result, context, [])
    const week = analyzeWeek({ days: DAYS, shiftsForDay: d => proposedByDay[d], demand, pph: PPH, scope: 'mainEru' })
    result.modeledCapacity = Object.fromEntries(week.areas.map(a => [a,
      week.days.map(({ analysis }) => analysis.hours.map(r => r.byArea[a].capacity))]))
    expect(capacityCrossCheck(result, week)).toBe(0)
    result.modeledCapacity.main[0][10] += 0.5
    expect(capacityCrossCheck(result, week)).toBeCloseTo(0.5, 10)
  })
})
