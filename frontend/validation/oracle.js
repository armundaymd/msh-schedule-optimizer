// Independent reference ("oracle") for coverage and capacity, written from
// the written rules in shared/capacity.js's header comment — NOT by calling
// or copying capacity.js. Validation compares the two on every generated
// schedule, so a coding slip in either shows up as a disagreement.
//
// What this validates: the CODE implements the written rules.
// What it cannot validate: whether the written rules are clinically right.

const MAIN_TEAMS = ['Green', 'Red', 'Blue']
const AREA_OF_LABEL = { Main: 'main', FastTrack: 'fasttrack', ERU: 'eru' }
const RESIDENT_KEY = { 'PGY-1': 'pgy1', 'PGY-2': 'pgy2', 'PGY-3': 'pgy3', 'PGY-4': 'pgy4', 'Off-Service': 'offService' }

export function oracleArea(team, customTeams = []) {
  if (MAIN_TEAMS.includes(team)) return 'main'
  if (team === 'FastTrack') return 'fasttrack'
  if (team === 'ERU') return 'eru'
  const ct = customTeams.find(t => t.name === team)
  return AREA_OF_LABEL[ct?.area] ?? 'main'
}

// Clock hours (0-23) a shift touches, by walking its minutes. Shifts are
// on a 30-minute grid; a shift ending past 24:00 wraps into the early hours
// of the same day template (the app's circular-day convention).
export function oracleHours(shift) {
  const hours = new Set()
  for (let m = shift.startMins; m < shift.endMins; m += 30) hours.add(Math.floor((m % 1440) / 60))
  return hours
}

function covers(shift, h) {
  return oracleHours(shift).has(h)
}

// One team at one hour:
//   no attending on            -> solo extender capacity only
//   otherwise                  -> min(nAtt*ceiling, nAtt*own + supervised extenders) + solo
// supervised extender = Resident at their level's PPH, or a PA at `pa`
//   (FastTrack PAs: `fasttrackPaWithAttending` when a FastTrack PA override exists)
// solo = FastTrack PAs at `fasttrackPa`; zero everywhere else.
export function oracleTeamCapacity(shifts, pph, area, team, h) {
  const on = shifts.filter(s => s.team === team && covers(s, h))
  const nAtt = on.filter(s => s.role_type === 'Attending').length
  const ftOverride = area === 'fasttrack' && (pph.fasttrackPa != null || pph.fasttrackPaWithAttending != null)
  let supervised = 0, solo = 0
  for (const s of on) {
    if (s.role_type === 'Resident') supervised += pph[RESIDENT_KEY[s.resident_level ?? s.role_detail] ?? 'pgy2'] ?? 0
    if (s.role_type === 'PA') {
      supervised += ftOverride ? (pph.fasttrackPaWithAttending ?? 0) : (pph.pa ?? 0)
      if (area === 'fasttrack') solo += pph.fasttrackPa ?? 0
    }
  }
  if (nAtt === 0) return { nAtt, supervised, solo, ceiling: 0, cap: solo }
  const ceiling = nAtt * (pph[area] ?? 0)
  const own = nAtt * (pph[`${area}Own`] ?? pph[area] ?? 0)
  return { nAtt, supervised, solo, ceiling, cap: Math.min(ceiling, own + supervised) + solo }
}

export function oracleAreaCapacity(shifts, pph, customTeams, area, h) {
  const teams = [...new Set(shifts.filter(s => oracleArea(s.team, customTeams) === area).map(s => s.team))]
  return teams.reduce((t, team) => t + oracleTeamCapacity(shifts, pph, area, team, h).cap, 0)
}
