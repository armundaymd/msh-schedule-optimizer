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
//                        + soloExtenderCapacity(team)
//     supervisionCeiling(team) = (# Attending shifts on that team) * pph[area]
//                                 the max total patients/hr one attending can
//                                 be responsible for, INCLUDING work done by
//                                 residents/PAs they supervise
//     ownThroughput(team)      = (# Attending shifts on that team) * pph[area + 'Own']
//                                 patients/hr an attending sees working alone
//     extenderCapacity(team)  = sum of each SUPERVISED Resident/PA shift's own
//                               max-PPH, restricted to shifts on that team —
//                               this pool is capped by supervisionCeiling
//     soloExtenderCapacity(team) = sum of each UNSUPERVISED extender shift's
//                               own max-PPH (currently: FastTrack PAs seeing
//                               patients solo). NOT capped by the ceiling,
//                               since no attending is reviewing that work —
//                               added on top, and counted even when the team
//                               has NO attending on (FastTrack PAs see solo
//                               patients while attendings cover other parts
//                               of the ED).
// A team with attendings and no residents/PAs is not zero capacity: the
// attendings still see patients on their own (ownThroughput). A team with NO
// attendings has no supervised capacity (the min() term is 0); only solo
// extender capacity counts, which is 0 everywhere except FastTrack PAs.
// Area-level totals (Main/FastTrack/ERU, used for the demand chart) are the
// SUM of each team's own min() — never sum-then-min across teams, which
// would let one team's extenders paper over another team's empty roster.

import { STATIC_MAIN, AREA_KEY, scopeAreas } from './areas'

// Re-exported for existing importers; defined in areas.js.
export { STATIC_MAIN }

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
  return AREA_KEY[ct?.area] ?? 'main'
}

// The pph object key a Resident extender shift's max-PPH lives under.
export function extenderPphKey(shift) {
  if (shift.role_type === 'Resident') {
    const level = shift.resident_level || shift.role_detail
    return RESIDENT_LEVEL_TO_PPH_KEY[level] ?? DEFAULT_RESIDENT_PPH_KEY
  }
  return null
}

// Numeric PPH for one SUPERVISED extender shift — the pool the supervision
// ceiling caps. FastTrack PAs co-managing alongside an attending
// (fasttrackPaWithAttending) belong here; their solo work does not (see
// soloExtenderPphValue). Falls back to the single area-agnostic `pa` key
// when no FastTrack override is set, so existing scenarios are unaffected.
function extenderPphValue(shift, pph, area) {
  if (shift.role_type === 'PA') {
    if (area === 'fasttrack' && (pph.fasttrackPa != null || pph.fasttrackPaWithAttending != null)) {
      return pph.fasttrackPaWithAttending ?? 0
    }
    return pph.pa ?? 0
  }
  return pph[extenderPphKey(shift)] ?? 0
}

// Numeric PPH for one UNSUPERVISED (solo) extender shift — added on top of
// the ceiling-capped pool, not inside it. Currently only FastTrack PAs
// working solo; everywhere else this is 0.
function soloExtenderPphValue(shift, pph, area) {
  if (shift.role_type === 'PA' && area === 'fasttrack') return pph.fasttrackPa ?? 0
  return 0
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

export function soloExtenderCapacityForTeam(shifts, pph, area, teamName, hour) {
  let total = 0
  for (const s of shifts) {
    if (s.role_type !== 'PA') continue
    if (s.team !== teamName) continue
    if (!shiftCoversHour(s, hour)) continue
    total += soloExtenderPphValue(s, pph, area)
  }
  return total
}

export function teamCapacityForTeam(shifts, pph, area, teamName, hour) {
  const solo = soloExtenderCapacityForTeam(shifts, pph, area, teamName, hour)
  const nAtt = attendingCountForTeam(shifts, teamName, hour)
  if (nAtt === 0) return solo
  const supervisionCeiling = attendingCapacityForTeam(shifts, pph, area, teamName, hour)
  const ownThroughput = ownThroughputForTeam(shifts, pph, area, teamName, hour)
  const extenders = extenderCapacityForTeam(shifts, pph, area, teamName, hour)
  return Math.min(supervisionCeiling, ownThroughput + extenders) + solo
}

// Per-team breakdown for an area+hour — used by the chart tooltip so you can
// see which specific team is dragging the area total down (and why).
export function teamBreakdown(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .sort()
    .map(team => {
      const nAtt = attendingCountForTeam(shifts, team, hour)
      const supervisionCeiling = attendingCapacityForTeam(shifts, pph, area, team, hour)
      const ownThroughput = ownThroughputForTeam(shifts, pph, area, team, hour)
      const extender = extenderCapacityForTeam(shifts, pph, area, team, hour)
      const solo = soloExtenderCapacityForTeam(shifts, pph, area, team, hour)
      const cap = nAtt === 0 ? solo : Math.min(supervisionCeiling, ownThroughput + extender) + solo
      return { team, supervisionCeiling, ownThroughput, extender, solo, cap }
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

export function soloExtenderCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + soloExtenderCapacityForTeam(shifts, pph, area, team, hour), 0)
}

export function teamCapacity(shifts, pph, customTeams, area, hour) {
  return activeTeamsInArea(shifts, customTeams, area, hour)
    .reduce((sum, team) => sum + teamCapacityForTeam(shifts, pph, area, team, hour), 0)
}

// ── Scope-level (one or more areas) ─────────────────────────────────────────
// `scope` is a scope key, an area key, or an array of area keys (see
// areas.js). A scope's capacity is the SUM of each component area's own
// teamCapacity — the same never-min-across-teams rule as above, one level up.
// Summing is only the aggregate view: capacity does not transfer between
// areas, so per-area results must stay visible (see scopeAnalysis.js).

export function scopeCapacity(shifts, pph, customTeams, scope, hour) {
  return scopeAreas(scope)
    .reduce((sum, area) => sum + teamCapacity(shifts, pph, customTeams, area, hour), 0)
}

// Summed capacity components across the scope, plus the same numbers per
// component area under `byArea`.
export function scopeCapacityBreakdown(shifts, pph, customTeams, scope, hour) {
  const total = { supervisionCeiling: 0, ownThroughput: 0, extender: 0, solo: 0, cap: 0, byArea: {} }
  for (const area of scopeAreas(scope)) {
    const a = {
      supervisionCeiling: attendingCapacity(shifts, pph, customTeams, area, hour),
      ownThroughput:      ownThroughput(shifts, pph, customTeams, area, hour),
      extender:           extenderCapacity(shifts, pph, customTeams, area, hour),
      solo:               soloExtenderCapacity(shifts, pph, customTeams, area, hour),
      cap:                teamCapacity(shifts, pph, customTeams, area, hour),
    }
    total.byArea[area] = a
    total.supervisionCeiling += a.supervisionCeiling
    total.ownThroughput      += a.ownThroughput
    total.extender           += a.extender
    total.solo               += a.solo
    total.cap                += a.cap
  }
  return total
}

// Per-team breakdown across every area in the scope; each row carries `area`.
export function scopeTeamBreakdown(shifts, pph, customTeams, scope, hour) {
  return scopeAreas(scope).flatMap(area =>
    teamBreakdown(shifts, pph, customTeams, area, hour).map(row => ({ ...row, area }))
  )
}
