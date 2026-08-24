// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

// Shared capacity math — single source of truth for how many patients/hour
// a team can handle, used by the demand chart, summary stats, and the
// auto-optimizer.
//
// An attending and their residents/PAs are tied to ONE specific team — an
// attending on Blue can't be covered by residents staffed on Green. So
// capacity is computed per INDIVIDUAL team first:
//   teamCapacity(team) = min(supervisionCeiling(team), ownThroughput(team) + extenderCapacity(team))
//     supervisionCeiling(team) = (# Attending shifts on that team) * pph[area]
//                                 the max total patients/hr one attending can
//                                 be responsible for, INCLUDING work done by
//                                 residents/PAs they supervise
//     ownThroughput(team)      = (# Attending shifts on that team) * pph[area + 'Own']
//                                 patients/hr an attending sees working alone
//     extenderCapacity(team)  = sum of each Resident/PA shift's own max-PPH,
//                               restricted to shifts on that team
// A team with attendings and no residents/PAs is not zero capacity: the
// attendings still see patients on their own (ownThroughput). A team with NO
// attendings is zero capacity — residents/PAs are never staffed unsupervised
// (deliberate, do not add unsupervised-PA capacity without asking).
// Area-level totals (Main/FastTrack/ERU, used for the demand chart) are the
// SUM of each team's own min() — never sum-then-min across teams, which
// would let one team's extenders paper over another team's empty roster.

export const STATIC_MAIN = ['Green', 'Red', 'Blue']

const RESIDENT_LEVEL_TO_PPH_KEY = {
  'PGY-1': 'pgy1',
  'PGY-2': 'pgy2',
  'PGY-3': 'pgy3',
  'PGY-4': 'pgy4',
  'Off-Service': 'offService',
}

// Defensive fallback for shifts with no/unrecognized resident_level (should
// not happen after the role_detail -> resident_level migration).
const DEFAULT_RESIDENT_PPH_KEY = 'pgy2'

export function shiftCoversHour(s, h) {
  const hStart = h * 60, hEnd = hStart + 60
  if (s.endMins <= 1440) return s.startMins < hEnd && s.endMins > hStart
  const wrapEnd = s.endMins - 1440
  return s.startMins < hEnd || hStart < wrapEnd
}

export function teamArea(teamName, customTeams = []) {
  if (STATIC_MAIN.includes(teamName)) return 'main'
  if (teamName === 'FastTrack') return 'fasttrack'
  if (teamName === 'ERU') return 'eru'
  const ct = customTeams.find(t => t.name === teamName)
  if (!ct) return 'main'
  return ct.area === 'FastTrack' ? 'fasttrack' : ct.area === 'ERU' ? 'eru' : 'main'
}

// The pph object key a Resident extender shift's max-PPH lives under.
export function extenderPphKey(shift) {
  if (shift.role_type === 'Resident') {
    const level = shift.resident_level || shift.role_detail
    return RESIDENT_LEVEL_TO_PPH_KEY[level] ?? DEFAULT_RESIDENT_PPH_KEY
  }
  return null
}

// Numeric PPH for one extender shift. FastTrack PAs do two things a Main/ERU
// PA doesn't: see patients solo (fasttrackPa) AND co-manage patients
// alongside an attending (fasttrackPaWithAttending) in the same hour, so
// their rate is the SUM of both, not a single number. Falls back to the
// single area-agnostic `pa` key when no FastTrack override is set, so
// existing scenarios are unaffected.
function extenderPphValue(shift, pph, area) {
  if (shift.role_type === 'PA') {
    if (area === 'fasttrack' && (pph.fasttrackPa != null || pph.fasttrackPaWithAttending != null)) {
      return (pph.fasttrackPa ?? pph.pa ?? 0) + (pph.fasttrackPaWithAttending ?? 0)
    }
    return pph.pa ?? 0
  }
  return pph[extenderPphKey(shift)] ?? 0
}

// Distinct team names with any shift active in `area` at `hour` — the set
// of teams to roll up when computing an area-level total.
export function activeTeamsInArea(shifts, customTeams, area, hour) {
  const teams = new Set()
  for (const s of shifts) {
    if (!shiftCoversHour(s, hour)) continue
    if (teamArea(s.team, customTeams) !== area) continue
    teams.add(s.team)
  }
  return [...teams]
}

export function attendingCountForTeam(shifts, teamName, hour) {
  let count = 0
  for (const s of shifts) {
    if (s.role_type !== 'Attending') continue
    if (s.team !== teamName) continue
    if (!shiftCoversHour(s, hour)) continue
    count++
  }
  return count
}

// Attending supervision ceiling: max total patients/hr one attending can be
// responsible for, including work done by residents/PAs they supervise.
export function attendingCapacityForTeam(shifts, pph, area, teamName, hour) {
  return attendingCountForTeam(shifts, teamName, hour) * (pph[area] ?? 0)
}

// Attending solo throughput: patients/hr an attending on this team sees
// working independently, with no supervision credit for residents/PAs.
export function ownThroughputForTeam(shifts, pph, area, teamName, hour) {
  const nAtt = attendingCountForTeam(shifts, teamName, hour)
  return nAtt * (pph[`${area}Own`] ?? pph[area] ?? 0)
}

export function extenderCapacityForTeam(shifts, pph, area, teamName, hour) {
  let total = 0
  for (const s of shifts) {
    if (s.role_type !== 'PA' && s.role_type !== 'Resident') continue
    if (s.team !== teamName) continue
    if (!shiftCoversHour(s, hour)) continue
    total += extenderPphValue(s, pph, area)
  }
  return total
}

export function teamCapacityForTeam(shifts, pph, area, teamName, hour) {
  const nAtt = attendingCountForTeam(shifts, teamName, hour)
  if (nAtt === 0) return 0
  const supervisionCeiling = attendingCapacityForTeam(shifts, pph, area, teamName, hour)
  const ownThroughput = ownThroughputForTeam(shifts, pph, area, teamName, hour)
  const extenders = extenderCapacityForTeam(shifts, pph, area, teamName, hour)
  return Math.min(supervisionCeiling, ownThroughput + extenders)
}

// Per-team breakdown for an area+hour — used by the chart tooltip so you can
// see which specific team is dragging the area total down (and why).
export function teamBreakdown(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .sort()
    .map(team => {
      const supervisionCeiling = attendingCapacityForTeam(shifts, pph, area, team, hour)
      const ownThroughput = ownThroughputForTeam(shifts, pph, area, team, hour)
      const extender = extenderCapacityForTeam(shifts, pph, area, team, hour)
      return { team, supervisionCeiling, ownThroughput, extender, cap: Math.min(supervisionCeiling, ownThroughput + extender) }
    })
}

export function attendingCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + attendingCapacityForTeam(shifts, pph, area, team, hour), 0)
}

export function ownThroughput(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + ownThroughputForTeam(shifts, pph, area, team, hour), 0)
}

export function extenderCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + extenderCapacityForTeam(shifts, pph, area, team, hour), 0)
}

export function teamCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + teamCapacityForTeam(shifts, pph, area, team, hour), 0)
}

const AREAS = ['main', 'fasttrack', 'eru']

// { main, fasttrack, eru } capacity totals for one hour — used by the
// optimizer, which works off overall Main-team demand.
export function capacityAllAreas(shifts, pph, customTeams, hour) {
  const out = {}
  for (const area of AREAS) out[area] = teamCapacity(shifts, pph, customTeams, area, hour)
  return out
}
