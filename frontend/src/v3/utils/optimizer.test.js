import { describe, it, expect } from 'vitest'
import { getOverflowHours, runOptimizer } from './optimizer'
import { teamArea } from '../../shared/capacity'

const PPH = {
  main: 2, mainOwn: 2,
  fasttrack: 3, fasttrackOwn: 3,
  eru: 4, eruOwn: 4,
  pa: 1, fasttrackPa: 1.5, fasttrackPaWithAttending: 0,
  pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
const DAY = 'Monday'
const flat = v => Array(24).fill(v)

function att(team, startMins = 0, endMins = 24 * 60, id = `${team}-${startMins}`) {
  return { id, day: DAY, team, role_type: 'Attending', startMins, endMins, start_time: '', end_time: '' }
}

// Main -4 / ERU +4 all day: the pooled Main + ERU total is exactly covered.
const shifts = [att('Green'), att('ERU')]
const demand = { Main: { overall: flat(6) }, ERU: { overall: flat(0) }, FastTrack: { overall: flat(0) } }

describe('getOverflowHours with scopes', () => {
  it('single-area scopes behave as before', () => {
    expect(getOverflowHours(shifts, demand, PPH, DAY, [], 'main')).toHaveLength(24)
    expect(getOverflowHours(shifts, demand, PPH, DAY, [], 'eru')).toEqual([])
  })

  it('a combined scope reports the Main deficit even though ERU surplus covers the aggregate', () => {
    expect(getOverflowHours(shifts, demand, PPH, DAY, [], 'mainEru')).toHaveLength(24)
  })

  it('a combined scope with every area covered has no overflow', () => {
    const covered = { Main: { overall: flat(2) }, ERU: { overall: flat(4) } }
    expect(getOverflowHours(shifts, covered, PPH, DAY, [], 'mainEru')).toEqual([])
  })
})

describe('runOptimizer with scopes', () => {
  it('fixes the Main deficit with Main teams and leaves ERU untouched', () => {
    const r = runOptimizer(shifts, demand, PPH, DAY, [], 'mainEru')
    expect(r.totalOverflow).toBe(24)
    const eruBefore = shifts.filter(s => s.team === 'ERU')
    const eruAfter = r.newShifts.filter(s => s.team === 'ERU')
    expect(eruAfter).toEqual(eruBefore)
    const added = r.newShifts.filter(s => !shifts.some(o => o.id === s.id))
    expect(added.length).toBeGreaterThan(0)
    for (const s of added) expect(teamArea(s.team, [...r.newTeams])).toBe('main')
    expect(getOverflowHours(r.newShifts, demand, PPH, DAY, r.newTeams, 'main').length).toBeLessThan(24)
    expect(r.resolvedCount).toBe(24 - getOverflowHours(r.newShifts, demand, PPH, DAY, r.newTeams, 'mainEru').length)
  })

  it('single-area optimize only touches that area', () => {
    const r = runOptimizer(shifts, demand, PPH, DAY, [], 'eru')
    expect(r.totalOverflow).toBe(0)
    expect(r.changes).toEqual([])
    expect(r.newShifts).toEqual(shifts)
  })

  it('whole-ED optimize handles each short area and mints distinct team names', () => {
    // No shifts at all: every area is short, so each may need an overflow team.
    const d = { Main: { overall: flat(1) }, FastTrack: { overall: flat(1) }, ERU: { overall: flat(1) } }
    const r = runOptimizer([], d, PPH, DAY, [], 'wholeEd')
    expect(r.totalOverflow).toBe(24)
    const names = r.newTeams.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const area of ['main', 'fasttrack', 'eru']) {
      expect(r.newShifts.some(s => teamArea(s.team, r.newTeams) === area)).toBe(true)
    }
  })
})
