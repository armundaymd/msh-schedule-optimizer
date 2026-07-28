// Shared capacity math — single source of truth for how many patients/hour
// a team can handle, used by the demand chart, summary stats, and the
// auto-optimizer.
//
// An attending and their residents/PAs are tied to ONE specific team — an
// attending on Blue can't be covered by residents staffed on Green. So
// capacity is computed per INDIVIDUAL team first:
//   teamCapacity(team) = min(attendingCapacity(team), extenderCapacity(team))
//     attendingCapacity(team) = (# Attending shifts on that team) * pph[area]
//     extenderCapacity(team)  = sum of each Resident/PA shift's own max-PPH,
//                               restricted to shifts on that team
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

// The pph object key an extender (PA/Resident) shift's max-PPH lives under.
export function extenderPphKey(shift) {
  if (shift.role_type === 'PA') return 'pa'
  if (shift.role_type === 'Resident') {
    const level = shift.resident_level || shift.role_detail
    return RESIDENT_LEVEL_TO_PPH_KEY[level] ?? DEFAULT_RESIDENT_PPH_KEY
  }
  return null
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

export function attendingCapacityForTeam(shifts, pph, area, teamName, hour) {
  let count = 0
  for (const s of shifts) {
    if (s.role_type !== 'Attending') continue
    if (s.team !== teamName) continue
    if (!shiftCoversHour(s, hour)) continue
    count++
  }
  return count * (pph[area] ?? 0)
}

export function extenderCapacityForTeam(shifts, pph, teamName, hour) {
  let total = 0
  for (const s of shifts) {
    if (s.role_type !== 'PA' && s.role_type !== 'Resident') continue
    if (s.team !== teamName) continue
    if (!shiftCoversHour(s, hour)) continue
    total += pph[extenderPphKey(s)] ?? 0
  }
  return total
}

export function teamCapacityForTeam(shifts, pph, area, teamName, hour) {
  return Math.min(
    attendingCapacityForTeam(shifts, pph, area, teamName, hour),
    extenderCapacityForTeam(shifts, pph, teamName, hour),
  )
}

// Per-team breakdown for an area+hour — used by the chart tooltip so you can
// see which specific team is dragging the area total down (and why).
export function teamBreakdown(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .sort()
    .map(team => {
      const attending = attendingCapacityForTeam(shifts, pph, area, team, hour)
      const extender = extenderCapacityForTeam(shifts, pph, team, hour)
      return { team, attending, extender, cap: Math.min(attending, extender) }
    })
}

export function attendingCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + attendingCapacityForTeam(shifts, pph, area, team, hour), 0)
}

export function extenderCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + extenderCapacityForTeam(shifts, pph, team, hour), 0)
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
