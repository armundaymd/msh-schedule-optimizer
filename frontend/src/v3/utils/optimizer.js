import { shiftCoversHour, teamCapacity } from '../../shared/capacity'
import { getDemandSeries } from '../../shared/demandSeries'
import { AREA_LABEL, scopeAreas, teamsInArea } from '../../shared/areas'
import { analyzeScope } from '../../shared/scopeAnalysis'
import { formatRange, groupRuns } from '../../shared/coverageInsights'
import {
  COVERAGE_MODE, DEFAULT_OPERATIONAL_COVERAGE, attendingsInArea, effectiveMaxAttendings, resolveCoverage,
} from '../../shared/operationalCoverage'

// Auto-optimize: a lightweight, rule-of-thumb patch for one day's deficit
// hours. It is NOT the staffing planner (no budget, no shift menu, no
// search) — but it must never propose structurally invalid staffing:
//
//   - every added or lengthened shift is scored with the authoritative
//     capacity maths (capacity.js teamCapacity, as scheduled) and is only
//     kept when it adds modeled capacity at the hour it was added for;
//   - attending hours are never added where the operational coverage config
//     forbids them: CLOSED or CROSS_COVERED hours (no dedicated attending),
//     or beyond the area's maximum simultaneous attendings (ERU: one);
//   - no staff at all are added to an area during its CLOSED hours.
// Hours it cannot fix without breaking one of these rules are reported in
// `blocked` with the reason, rather than fixed by breaking the rule.

const SNAP = 30
const EPS = 1e-6
const MIN_NEW_SHIFT_MINS = 4 * 60
const CUSTOM_COLORS = ['#0d9488','#ec4899','#f59e0b','#6366f1','#84cc16','#06b6d4','#f43f5e','#64748b']

function snap(m) { return Math.round(m / SNAP) * SNAP }

function minsToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2,'0')}:${String(norm % 60).padStart(2,'0')}`
}

function newId() {
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// Hours of the day template a [startMins, endMins) span touches.
function hoursOfSpan(startMins, endMins) {
  if (endMins <= startMins) return []
  const span = { startMins, endMins }
  return Array.from({ length: 24 }, (_, h) => h).filter(h => shiftCoversHour(span, h))
}

// `scope` is an area key or a scope key (see shared/areas.js). For a combined
// scope an hour overflows when ANY component area is short — one area's
// surplus never offsets another's deficit.
export function getOverflowHours(shifts, demand, pph, day, customTeams, scope = 'main', target = 'mean') {
  return analyzeScope({ shifts, demand, pph, customTeams, scope, day, target }).componentDeficitHours
}

// Runs the single-area pass below once per component area of `scope`,
// threading the working shifts and custom teams through, so each area's
// deficit is fixed against that area's own demand with that area's teams.
// options.coverage: the operational coverage config (shared/operationalCoverage.js)
// whose hard rules are enforced; defaults to DEFAULT_OPERATIONAL_COVERAGE.
// Pass null to enforce only the structural limits (ERU: one attending).
export function runOptimizer(shifts, demand, pph, day, customTeams, scope = 'main', target = 'mean', options = {}) {
  const coverage = options.coverage === undefined ? DEFAULT_OPERATIONAL_COVERAGE : options.coverage
  const totalOverflow = getOverflowHours(shifts, demand, pph, day, customTeams, scope, target).length
  let work = shifts
  let allCustom = customTeams
  const newTeams = []
  const changes = []
  const blocked = []
  for (const area of scopeAreas(scope)) {
    const r = optimizeArea(work, demand, pph, day, allCustom, area, target, coverage)
    work = r.newShifts
    allCustom = [...allCustom, ...r.newTeams]
    newTeams.push(...r.newTeams)
    changes.push(...r.changes)
    blocked.push(...r.blocked)
  }
  const resolvedCount = totalOverflow - getOverflowHours(work, demand, pph, day, allCustom, scope, target).length
  return { newShifts: work, newTeams, changes, blocked, resolvedCount, totalOverflow }
}

// Hard rules for one area on one day, from the operational config.
export function areaRules(coverage, area, day) {
  const max = effectiveMaxAttendings(coverage, area)
  const modeAt = h => (coverage ? resolveCoverage(coverage, area, day, h).mode : COVERAGE_MODE.FLEXIBLE)
  return {
    max,
    modeAt,
    closedAt: h => modeAt(h) === COVERAGE_MODE.CLOSED,
    // Why no further attending may be placed in this area at hour h, given
    // the shifts in `work` (null = allowed).
    attendingBlockReason(work, customTeams, h) {
      const mode = modeAt(h)
      if (mode === COVERAGE_MODE.CLOSED) return 'closed'
      if (mode === COVERAGE_MODE.CROSS_COVERED) return 'crossCovered'
      if (max != null && attendingsInArea(work, customTeams, area, h) + 1 > max) return 'areaMax'
      return null
    },
  }
}

function blockText(area, reason, max) {
  const A = AREA_LABEL[area]
  switch (reason) {
    case 'closed': return `${A} is closed at these hours under the operational coverage rules — no staff added`
    case 'crossCovered': return `${A} is cross-covered at these hours — no dedicated ${A} attending may be added`
    case 'areaMax': return `${A} already has its maximum of ${max} attending${max === 1 ? '' : 's'} on at once — no attending added`
    default: return `no rule-compliant change adds modeled capacity here`
  }
}

function optimizeArea(shifts, demand, pph, day, customTeams, area, target, coverage) {
  const series = getDemandSeries(demand, AREA_LABEL[area], day, target)
  const rules = areaRules(coverage, area, day)

  let work = shifts.map(s => ({ ...s }))
  const allCustom = [...customTeams]
  const changes = []
  const newTeams = []

  const capAt = (list, h) => teamCapacity(list, pph, allCustom, area, h)
  const overflowAt = h => Math.max(0, (series[h] ?? 0) - capAt(work, h))
  const overflowHours = () => Array.from({ length: 24 }, (_, h) => h).filter(h => overflowAt(h) > 0)
  // Modeled capacity `added` shifts contribute at hour h (capacity.js).
  const gainAt = (added, h) => capAt([...work, ...added], h) - capAt(work, h)
  const canPlaceAttending = (h, list = work) => rules.attendingBlockReason(list, allCustom, h) == null

  const totalOverflow = overflowHours().length
  const areaTeams = teamsInArea(area, allCustom)

  // Step 1 — extend end times of attending shifts ending within 2h before an
  // overflow hour, only through hours where another attending is allowed.
  let dirty = true
  while (dirty) {
    dirty = false
    for (const h of overflowHours()) {
      if (overflowAt(h) <= 0) continue
      const hMins = h * 60
      const candidates = work
        .filter(s => s.role_type === 'Attending' && areaTeams.includes(s.team) && s.endMins > hMins - 120 && s.endMins <= hMins)
        .sort((a, b) => b.endMins - a.endMins)
      for (const shift of candidates) {
        if (overflowAt(h) <= 0) break
        const origEnd = shift._origEnd ?? shift.endMins
        let target = Math.min(hMins + 60, origEnd + 4 * 60)
        // Stop at the first new hour where the rules forbid the attending.
        // (Candidates end at or before hour h, so the extension never wraps midnight.)
        for (const nh of hoursOfSpan(shift.endMins, target)) {
          if (!canPlaceAttending(nh)) { target = Math.max(shift.endMins, nh * 60); break }
        }
        if (target <= shift.endMins) continue
        const before = capAt(work, h)
        const oldEnd = shift.endMins, oldEndTime = shift.end_time
        shift.endMins = target
        shift.end_time = minsToTime(target)
        if (capAt(work, h) <= before + EPS) {
          shift.endMins = oldEnd
          shift.end_time = oldEndTime
          continue
        }
        if (!shift._origEnd) shift._origEnd = oldEnd
        changes.push(`Extended ${shift.team} attending shift end from ${minsToTime(oldEnd)} to ${shift.end_time}`)
        dirty = true
      }
    }
  }

  // Step 2 — pull start times of attending shifts starting within 2h after
  // an overflow hour, only back through hours where another attending is allowed.
  dirty = true
  while (dirty) {
    dirty = false
    for (const h of overflowHours()) {
      if (overflowAt(h) <= 0) continue
      const hMins = h * 60
      const candidates = work
        .filter(s => s.role_type === 'Attending' && areaTeams.includes(s.team) && s.startMins >= hMins + 60 && s.startMins < hMins + 180)
        .sort((a, b) => a.startMins - b.startMins)
      for (const shift of candidates) {
        if (overflowAt(h) <= 0) break
        const origStart = shift._origStart ?? shift.startMins
        let target = snap(Math.max(hMins, origStart - 2 * 60))
        const newHours = hoursOfSpan(target, shift.startMins).reverse()
        for (const nh of newHours) {
          if (!canPlaceAttending(nh)) { target = Math.max(target, (nh + 1) * 60); break }
        }
        if (target >= shift.startMins) continue
        const before = capAt(work, h)
        const oldStart = shift.startMins, oldStartTime = shift.start_time
        shift.startMins = target
        shift.start_time = minsToTime(target)
        if (capAt(work, h) <= before + EPS) {
          shift.startMins = oldStart
          shift.start_time = oldStartTime
          continue
        }
        if (!shift._origStart) shift._origStart = oldStart
        changes.push(`Moved ${shift.team} attending shift start from ${minsToTime(oldStart)} to ${shift.start_time}`)
        dirty = true
      }
    }
  }

  // Step 3 — where one more PA adds modeled capacity WITHOUT another
  // attending (capacity.js decides: attending headroom under the ceiling,
  // counting their solo pace, or FastTrack solo PA work), add a PA shift to
  // the team where it adds the most. A PA that would add nothing — e.g. on
  // a team with no attending on — is never added.
  let guard = 0
  dirty = true
  while (dirty && guard < 200) {
    dirty = false
    for (const h of overflowHours()) {
      guard++
      if (overflowAt(h) <= 0 || rules.closedAt(h)) continue
      // An hour either side of h, but never into the area's closed hours.
      const sStart = (h > 0 && !rules.closedAt(h - 1) ? h - 1 : h) * 60
      const sEnd   = (h < 23 && !rules.closedAt(h + 1) ? h + 2 : h + 1) * 60
      let best = null
      for (const team of areaTeams) {
        const pa = { id: newId(), day, team, role_type: 'PA', role_detail: 'PA',
          start_time: minsToTime(sStart), end_time: minsToTime(sEnd), startMins: sStart, endMins: sEnd }
        const g = gainAt([pa], h)
        if (g > EPS && (!best || g > best.gain + EPS)) best = { pa, gain: g }
      }
      if (!best) continue
      work.push(best.pa)
      changes.push(`Added PA shift to ${best.pa.team} (adds ${best.gain.toFixed(1)} patients/hr without another attending): ${best.pa.start_time}–${best.pa.end_time}`)
      dirty = true
    }
  }

  // Adds an attending (+ a PA alongside when that PA adds capacity) on
  // `team` over each still-allowed run of `hours`. Returns true if anything
  // was added. Hours are re-checked here because an earlier addition (or its
  // padding) may have used up the area's attending maximum.
  function addAttendingCoverage(team, hours, label) {
    let any = false
    for (const run of allowedRuns(hours, h => canPlaceAttending(h))) any = addOne(team, run, label) || any
    return any
  }

  function addOne(team, hours, label) {
    const [sStart, sEnd] = spanFor(hours, h => canPlaceAttending(h))
    const att = { id: newId(), day, team, role_type: 'Attending', role_detail: 'Attending',
      start_time: minsToTime(sStart), end_time: minsToTime(sEnd), startMins: sStart, endMins: sEnd }
    const pa = { id: newId(), day, team, role_type: 'PA', role_detail: 'PA',
      start_time: minsToTime(sStart), end_time: minsToTime(sEnd), startMins: sStart, endMins: sEnd }
    const attGain = hours.reduce((t, h) => t + gainAt([att], h), 0)
    const paGain = hours.reduce((t, h) => t + (gainAt([att, pa], h) - gainAt([att], h)), 0)
    // An attending that adds nothing is only worth adding if it lets a PA add capacity.
    if (attGain + paGain <= EPS) return false
    work.push(att)
    changes.push(`${label} ${team}: ${att.start_time}–${att.end_time}`)
    if (paGain > EPS) {
      work.push(pa)
      changes.push(`Added PA shift to ${team} alongside the new attending coverage: ${pa.start_time}–${pa.end_time}`)
    }
    return true
  }

  // Step 4 — add attending coverage to existing teams for the remaining
  // overflow, only over hours where another attending is allowed.
  for (const run of allowedRuns(overflowHours(), h => canPlaceAttending(h))) {
    if (run.every(h => overflowAt(h) <= 0)) continue
    let bestTeam = null
    let minCov = Infinity
    for (const name of areaTeams) {
      const cov = work.filter(s => s.team === name && s.role_type === 'Attending' && run.some(h => shiftCoversHour(s, h))).length
      if (cov < minCov) { minCov = cov; bestTeam = name }
    }
    if (bestTeam) addAttendingCoverage(bestTeam, run, 'Added attending shift to')
  }

  // Step 5 — a new "Optimized Team" for any remaining overflow the rules allow.
  const stillOverflow = overflowHours()
  const runs = allowedRuns(stillOverflow, h => canPlaceAttending(h))
  if (runs.length > 0) {
    const usedColors = new Set(allCustom.map(t => t.color))
    const color = CUSTOM_COLORS.find(c => !usedColors.has(c)) ?? CUSTOM_COLORS[0]
    const optN = allCustom.filter(t => t.name.startsWith('Optimized Team')).length + 1
    const teamName = `Optimized Team ${optN}`
    const team = { name: teamName, color, area: AREA_LABEL[area] }
    allCustom.push(team)
    let used = false
    for (const run of runs) used = addAttendingCoverage(teamName, run, 'Added attending coverage on new team') || used
    if (used) newTeams.push(team)
    else allCustom.pop()
  }

  // What is still short, and why it was left (a hard rule, or no change helps).
  const blocked = []
  const left = new Set(overflowHours())
  for (const run of groupRuns(h => {
    if (!left.has(h)) return null
    return rules.attendingBlockReason(work, allCustom, h) ?? 'noHelp'
  })) {
    blocked.push({
      area, hours: run.hours, reason: run.key,
      message: `${AREA_LABEL[area]} still short ${formatRange(run.hours)}: ${blockText(area, run.key, rules.max)}.`,
    })
  }

  const resolvedCount = totalOverflow - left.size
  work = work.map(s => { const rest = { ...s }; delete rest._origEnd; delete rest._origStart; return rest })
  return { newShifts: work, newTeams, changes, blocked, resolvedCount, totalOverflow }

  // [startMins, endMins) for a new shift over `hours` (consecutive), padded
  // by an hour each side and up to MIN_NEW_SHIFT_MINS, but only through hours
  // `allowed` permits and never past midnight.
  function spanFor(hours, allowed) {
    let lo = hours[0], hi = hours[hours.length - 1] + 1
    if (lo > 0 && allowed(lo - 1)) lo -= 1
    if (hi < 24 && allowed(hi % 24)) hi += 1
    while ((hi - lo) * 60 < MIN_NEW_SHIFT_MINS && hi < 24 && allowed(hi)) hi += 1
    while ((hi - lo) * 60 < MIN_NEW_SHIFT_MINS && lo > 0 && allowed(lo - 1)) lo -= 1
    return [snap(lo * 60), snap(Math.min(hi, 24) * 60)]
  }
}

// Consecutive runs (not wrapping midnight) of `hours` where `allowed(h)`.
function allowedRuns(hours, allowed) {
  const runs = []
  let cur = null
  for (const h of [...hours].sort((a, b) => a - b)) {
    if (!allowed(h)) { cur = null; continue }
    if (cur && cur[cur.length - 1] === h - 1) cur.push(h)
    else { cur = [h]; runs.push(cur) }
  }
  return runs
}
