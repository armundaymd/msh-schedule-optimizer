// Shared capacity math — single source of truth for how many patients/hour
// a team can handle, used by the demand chart, summary stats, and the
// auto-optimizer.
//
// Capacity per area+hour = min(attendingCapacity, extenderCapacity):
//   attendingCapacity = (# Attending shifts active) * pph[area]
//   extenderCapacity  = sum of each active Resident/PA shift's own max-PPH
// The attending's max PPH is the real ceiling on team throughput; residents
// and PAs supply capacity up to that ceiling. If their combined max PPH is
// below the attending's, that's unused attending capacity (understaffed).
// If it's above, the attending becomes the bottleneck.

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

export function attendingCapacity(shifts, pph, customTeams, area, hour) {
  let count = 0
  for (const s of shifts) {
    if (s.role_type !== 'Attending') continue
    if (teamArea(s.team, customTeams) !== area) continue
    if (!shiftCoversHour(s, hour)) continue
    count++
  }
  return count * (pph[area] ?? 0)
}

export function extenderCapacity(shifts, pph, customTeams, area, hour) {
  let total = 0
  for (const s of shifts) {
    if (s.role_type !== 'PA' && s.role_type !== 'Resident') continue
    if (teamArea(s.team, customTeams) !== area) continue
    if (!shiftCoversHour(s, hour)) continue
    const key = extenderPphKey(s)
    total += pph[key] ?? 0
  }
  return total
}

export function teamCapacity(shifts, pph, customTeams, area, hour) {
  return Math.min(
    attendingCapacity(shifts, pph, customTeams, area, hour),
    extenderCapacity(shifts, pph, customTeams, area, hour),
  )
}

const AREAS = ['main', 'fasttrack', 'eru']

// { main, fasttrack, eru } capacity totals for one hour — used by the
// optimizer, which works off overall Main-team demand.
export function capacityAllAreas(shifts, pph, customTeams, hour) {
  const out = {}
  for (const area of AREAS) out[area] = teamCapacity(shifts, pph, customTeams, area, hour)
  return out
}
