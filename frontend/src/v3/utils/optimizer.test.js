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

// ── Structural validity (audit fixes) ────────────────────────────────────────
import { DEFAULT_PPH } from '../../shared/pph'
import { teamCapacity } from '../../shared/capacity'

function staff(team, role, startH, endH, extra = {}) {
  return { id: `${team}-${role}-${startH}-${extra.resident_level ?? ''}`, day: DAY, team, role_type: role, role_detail: role,
    resident_level: null, startMins: startH * 60, endMins: endH * 60, start_time: '', end_time: '', ...extra }
}
const peak = (from, to, v) => Array.from({ length: 24 }, (_, h) => (h >= from && h < to ? v : 0))
const addedOf = (before, after) => after.filter(s => !before.some(o => o.id === s.id))
const attendingsAt = (shifts, teams, h) => shifts.filter(s => s.role_type === 'Attending' && teams.includes(s.team)
  && s.startMins < (h + 1) * 60 && s.endMins > h * 60).length

// Every added resident/PA shift must add modeled capacity (capacity.js) at some hour it covers.
function expectEveryAddedExtenderAddsCapacity(r, before, area) {
  for (const s of addedOf(before, r.newShifts).filter(x => x.role_type !== 'Attending')) {
    const without = r.newShifts.filter(x => x.id !== s.id)
    const gain = Array.from({ length: 24 }, (_, h) =>
      teamCapacity(r.newShifts, DEFAULT_PPH, r.newTeams, area, h) - teamCapacity(without, DEFAULT_PPH, r.newTeams, area, h))
    expect(Math.max(...gain)).toBeGreaterThan(0)
  }
}

describe('auto-optimize never adds staff that add no modeled capacity', () => {
  // Green: attending + PGY-2 → solo 1.3 + 0.8 = 2.1 = ceiling. Red/Blue: nobody on.
  const base = [staff('Green', 'Attending', 12, 20), staff('Green', 'Resident', 12, 20, { resident_level: 'PGY-2' })]
  const demand = { Main: { by_dow: { [DAY]: peak(14, 16, 4) } } }

  it('does not add PAs to teams with no attending on (the audit reproduction)', () => {
    const r = runOptimizer(base, demand, DEFAULT_PPH, DAY, [], 'main')
    for (const pa of addedOf(base, r.newShifts).filter(s => s.role_type === 'PA')) {
      const hours = Array.from({ length: 24 }, (_, h) => h).filter(h => pa.startMins < (h + 1) * 60 && pa.endMins > h * 60)
      expect(hours.some(h => attendingsAt(r.newShifts, [pa.team], h) > 0)).toBe(true)
    }
    expectEveryAddedExtenderAddsCapacity(r, base, 'main')
    expect(r.resolvedCount).toBe(r.totalOverflow)
  })

  it('does not treat teams at their ceiling (solo pace + helpers) as resident/PA-limited', () => {
    // Every Main team: attending + PGY-2 → 1.3 + 0.8 = 2.1 = ceiling. Area extender
    // capacity (2.4) is below the area ceiling (6.3), which the old test misread as
    // "resident/PA-limited" — but one more PA adds nothing to any team.
    const full = ['Green', 'Red', 'Blue'].flatMap(t => [staff(t, 'Attending', 12, 20), staff(t, 'Resident', 12, 20, { resident_level: 'PGY-2' })])
    const d = { Main: { by_dow: { [DAY]: peak(14, 16, 8) } } }
    const r = runOptimizer(full, d, DEFAULT_PPH, DAY, [], 'main')
    expect(r.changes.some(c => /Added PA shift to \w+ \(adds/.test(c))).toBe(false)
    expect(addedOf(full, r.newShifts).some(s => s.role_type === 'Attending')).toBe(true)
    expectEveryAddedExtenderAddsCapacity(r, full, 'main')
  })

  it('adds a PA where the attending has supervision headroom', () => {
    // Attending alone: solo 1.3 under a 2.1 ceiling → one PA adds 0.8 without another attending.
    const lone = [staff('Green', 'Attending', 8, 20)]
    const d = { Main: { by_dow: { [DAY]: peak(12, 14, 2) } } }
    const r = runOptimizer(lone, d, DEFAULT_PPH, DAY, [], 'main')
    const added = addedOf(lone, r.newShifts)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ team: 'Green', role_type: 'PA' })
    expect(r.resolvedCount).toBe(2)
  })
})

describe('auto-optimize enforces hard structural rules', () => {
  const eruTeams = ['ERU']

  it('never puts a second ERU attending on at once, and reports the hours it left', () => {
    // Monday 09:00–01:00 is ERU dedicated; one ERU attending is already on.
    const base = [staff('ERU', 'Attending', 9, 17)]
    const d = { ERU: { by_dow: { [DAY]: peak(10, 16, 5) } } }
    const r = runOptimizer(base, d, DEFAULT_PPH, DAY, [], 'eru')
    for (let h = 0; h < 24; h++) expect(attendingsAt(r.newShifts, eruTeams, h)).toBeLessThanOrEqual(1)
    expect(r.blocked.some(b => b.area === 'eru' && b.reason === 'areaMax')).toBe(true)
    expect(r.blocked[0].message).toMatch(/maximum of 1 attending/)
  })

  it('never adds a dedicated attending in cross-covered hours', () => {
    // Monday 02:00–08:00: ERU is cross-covered by Main in the default config.
    const d = { ERU: { by_dow: { [DAY]: peak(2, 8, 2) } } }
    const r = runOptimizer([], d, DEFAULT_PPH, DAY, [], 'eru')
    expect(r.newShifts).toEqual([])
    expect(r.blocked.map(b => b.reason)).toEqual(['crossCovered'])
  })

  it('adds no staff at all to an area during its closed hours', () => {
    // FastTrack is closed 01:00–07:00 in the default config.
    const d = { FastTrack: { by_dow: { [DAY]: peak(0, 9, 3) } } }
    const r = runOptimizer([], d, DEFAULT_PPH, DAY, [], 'fasttrack')
    for (const s of r.newShifts) {
      for (let h = 1; h < 7; h++) expect(s.startMins < (h + 1) * 60 && s.endMins > h * 60).toBe(false)
    }
    expect(r.blocked.some(b => b.reason === 'closed' && b.hours.includes(3))).toBe(true)
    expectEveryAddedExtenderAddsCapacity(r, [], 'fasttrack')
  })

  it('stops extending a shift at the edge of a cross-covered window', () => {
    // Saturday ERU is dedicated 11:00–19:00, cross-covered after.
    const sat = 'Saturday'
    const base = [{ ...staff('ERU', 'Attending', 11, 17), day: sat }]
    const d = { ERU: { by_dow: { [sat]: peak(17, 21, 1) } } }
    const r = runOptimizer(base, d, DEFAULT_PPH, sat, [], 'eru')
    const eru = r.newShifts.filter(s => s.team === 'ERU' && s.role_type === 'Attending')
    for (const s of eru) expect(s.endMins).toBeLessThanOrEqual(19 * 60)
    expect(r.blocked.some(b => b.reason === 'crossCovered' && b.hours.includes(19))).toBe(true)
  })

  it('with no operational config still enforces the structural ERU maximum', () => {
    const base = [staff('ERU', 'Attending', 0, 24)]
    const d = { ERU: { by_dow: { [DAY]: flat(3) } } }
    const r = runOptimizer(base, d, DEFAULT_PPH, DAY, [], 'eru', 'mean', { coverage: null })
    for (let h = 0; h < 24; h++) expect(attendingsAt(r.newShifts, eruTeams, h)).toBeLessThanOrEqual(1)
  })
})
