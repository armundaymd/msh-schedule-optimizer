import { describe, it, expect } from 'vitest'
import { teamCapacityForTeam, teamCapacity, extenderCapacityForTeam, soloExtenderCapacityForTeam, shiftCoversHour } from './capacity'

const PPH = {
  main: 2.0, mainOwn: 1.0,
  fasttrack: 3.0, fasttrackOwn: 0,
}

function shift({ team, role_type, resident_level = null, startMins, endMins }) {
  return { team, role_type, resident_level, startMins, endMins }
}

function attending(team, startMins, endMins) {
  return shift({ team, role_type: 'Attending', startMins, endMins })
}

function pa(team, startMins, endMins) {
  return shift({ team, role_type: 'PA', startMins, endMins })
}

describe('teamCapacityForTeam', () => {
  it('attendings only: reduces to nAtt * ownPph (no unsupervised-PA capacity papering over the gap)', () => {
    const shifts = [attending('Green', 0, 24 * 60)]
    const cap = teamCapacityForTeam(shifts, PPH, 'main', 'Green', 10)
    expect(cap).toBeCloseTo(1 * PPH.mainOwn, 5)
  })

  it('extenders only, no attendings: capacity is zero', () => {
    const shifts = [pa('Green', 0, 24 * 60)]
    const cap = teamCapacityForTeam(shifts, PPH, 'main', 'Green', 10)
    expect(cap).toBe(0)
  })

  it('both, extenders below the supervision ceiling gap: staffing-limited (own + extender)', () => {
    // 1 attending: ceiling = 2.0, own = 1.0. Extender adds 0.5 -> own+ext = 1.5 < ceiling.
    const shifts = [attending('Green', 0, 24 * 60), pa('Green', 0, 24 * 60)]
    const pphWithSmallExtender = { ...PPH, pa: 0.5 }
    const cap = teamCapacityForTeam(shifts, pphWithSmallExtender, 'main', 'Green', 10)
    expect(cap).toBeCloseTo(1.5, 5)
  })

  it('extenders at or above the ceiling gap: reduces to nAtt * supervisionCeiling (today\'s behaviour)', () => {
    // 1 attending: ceiling = 2.0, own = 1.0. Extender adds 2.0 -> own+ext = 3.0 >= ceiling.
    const shifts = [attending('Green', 0, 24 * 60), pa('Green', 0, 24 * 60)]
    const pphWithBigExtender = { ...PPH, pa: 2.0 }
    const cap = teamCapacityForTeam(shifts, pphWithBigExtender, 'main', 'Green', 10)
    expect(cap).toBeCloseTo(PPH.main, 5)
  })

  it('overnight wrap: a shift crossing midnight still covers hour 0 and hour 23', () => {
    const shifts = [attending('Green', 23 * 60, 25 * 60)] // 23:00 -> 01:00
    expect(shiftCoversHour(shifts[0], 23)).toBe(true)
    expect(shiftCoversHour(shifts[0], 0)).toBe(true)
    expect(shiftCoversHour(shifts[0], 1)).toBe(false)
    expect(teamCapacityForTeam(shifts, PPH, 'main', 'Green', 0)).toBeCloseTo(PPH.mainOwn, 5)
    expect(teamCapacityForTeam(shifts, PPH, 'main', 'Green', 12)).toBe(0)
  })

  it('multi-team area rollup: teamCapacity sums each team\'s own min(), never sum-then-min', () => {
    // Green: attending only -> own throughput only
    // Red: attending + PA (extender >= ceiling gap) -> full ceiling
    const shifts = [
      attending('Green', 0, 24 * 60),
      attending('Red', 0, 24 * 60),
      pa('Red', 0, 24 * 60),
    ]
    const pphWithBigExtender = { ...PPH, pa: 2.0 }
    const total = teamCapacity(shifts, pphWithBigExtender, [], 'main', 10)
    expect(total).toBeCloseTo(PPH.mainOwn + PPH.main, 5)
  })

  it('solo throughput can be zeroed for an area that never sees solo patients', () => {
    // Main attending with mainOwn = 0 and no extenders -> capacity is 0, not floored at some minimum.
    const shifts = [attending('Green', 0, 24 * 60)]
    const cap = teamCapacityForTeam(shifts, { main: 2.0, mainOwn: 0 }, 'main', 'Green', 10)
    expect(cap).toBe(0)
  })
})

describe('FastTrack PA solo vs with-attending', () => {
  it('with-attending PA capacity is in the supervised (ceiling-capped) pool', () => {
    const shifts = [pa('FastTrack', 0, 24 * 60)]
    const pph = { ...PPH, pa: 1.2, fasttrackPa: 1.5, fasttrackPaWithAttending: 0.7 }
    expect(extenderCapacityForTeam(shifts, pph, 'fasttrack', 'FastTrack', 10)).toBeCloseTo(0.7, 5)
  })

  it('solo PA capacity is NOT in the supervised pool', () => {
    const shifts = [pa('FastTrack', 0, 24 * 60)]
    const pph = { ...PPH, pa: 1.2, fasttrackPa: 1.5, fasttrackPaWithAttending: 0.7 }
    expect(soloExtenderCapacityForTeam(shifts, pph, 'fasttrack', 'FastTrack', 10)).toBeCloseTo(1.5, 5)
  })

  it('falls back to the general pa rate (fully supervised, no solo) when no FastTrack override is set', () => {
    const shifts = [pa('FastTrack', 0, 24 * 60)]
    const pph = { ...PPH, pa: 1.2 }
    expect(extenderCapacityForTeam(shifts, pph, 'fasttrack', 'FastTrack', 10)).toBeCloseTo(1.2, 5)
    expect(soloExtenderCapacityForTeam(shifts, pph, 'fasttrack', 'FastTrack', 10)).toBe(0)
  })

  it('Main PAs are unaffected by FastTrack-specific overrides', () => {
    const shifts = [pa('Green', 0, 24 * 60)]
    const pph = { ...PPH, pa: 1.2, fasttrackPa: 1.5, fasttrackPaWithAttending: 0.7 }
    expect(extenderCapacityForTeam(shifts, pph, 'main', 'Green', 10)).toBeCloseTo(1.2, 5)
    expect(soloExtenderCapacityForTeam(shifts, pph, 'main', 'Green', 10)).toBe(0)
  })

  it('teamCapacityForTeam: solo PA capacity is added on top of the ceiling, not capped by it', () => {
    // 1 attending: ceiling = 3.0, own = 0. With-attending PA = 0 -> capped pool = 0.
    // Solo PA = 1.5, uncapped -> total capacity = min(3.0, 0) + 1.5 = 1.5, and moving
    // the solo slider changes this even though the capped pool is unaffected.
    const shifts = [attending('FastTrack', 0, 24 * 60), pa('FastTrack', 0, 24 * 60)]
    const pph = { ...PPH, fasttrackPa: 1.5, fasttrackPaWithAttending: 0 }
    expect(teamCapacityForTeam(shifts, pph, 'fasttrack', 'FastTrack', 10)).toBeCloseTo(1.5, 5)

    const pphMoreSolo = { ...pph, fasttrackPa: 2.5 }
    expect(teamCapacityForTeam(shifts, pphMoreSolo, 'fasttrack', 'FastTrack', 10)).toBeCloseTo(2.5, 5)
  })

  it('solo PA capacity still requires at least one attending scheduled on the team', () => {
    const shifts = [pa('FastTrack', 0, 24 * 60)] // no attending
    const pph = { ...PPH, fasttrackPa: 1.5, fasttrackPaWithAttending: 0 }
    expect(teamCapacityForTeam(shifts, pph, 'fasttrack', 'FastTrack', 10)).toBe(0)
  })
})
