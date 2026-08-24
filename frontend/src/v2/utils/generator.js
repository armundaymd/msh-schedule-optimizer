import { shiftCoversHour, STATIC_MAIN } from '../../shared/capacity'
import { getDemandSeries } from '../../shared/demandSeries'

// Shift set covering formulation (Savage et al., CJEM 2014):
//
//   S        = menu of allowable shift patterns, each (start_hour, length_hours)
//   x[s]     = integer count of attendings assigned to pattern s
//   d[h]     = target demand at hour h
//   c        = attending SOLO throughput for the area (pph[area+'Own']) --
//              not the supervision ceiling, because this pass places
//              attendings on an otherwise empty board (see 4.1 in the brief:
//              residents/APPs layer on afterwards against residual headroom,
//              a later phase).
//   u[h]     = uncovered demand at hour h, >= 0
//
//   minimise  sum_s x[s] * length(s) * costPerHour  +  M * sum_h u[h]
//   s.t.      sum_{s covers h} x[s] * c  +  u[h]  >=  d[h]      for h in 0..23
//             minConcurrentForHour(h) <= sum_{s covers h} x[s] <= maxConcurrent
//             sum_{s starts at h} x[s] <= maxStartsPerHour
//
// Solved as greedy + local search (not a MIP): 24 hours, a few dozen
// patterns at most, runs in milliseconds and lands close to optimal. A real
// MIP solver is a later swap behind this same function signature.

const M_UNCOVERED_PENALTY = 10000
const LOCAL_SEARCH_ITERATION_CAP = 500
const GREEDY_ITERATION_CAP = 1000

const AREA_LABEL = { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }

function minsToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`
}

function patternHours(pattern) {
  const hrs = []
  for (let i = 0; i < pattern.length; i++) hrs.push((pattern.start + i) % 24)
  return hrs
}

let _genCounter = 0
// 'gen-' prefix is deliberate: useScheduleState's normalizeShifts ids as
// `${day}-${team}-${role_type}-${index}` (see PHASE 3 trap #6) -- generated
// shifts must not collide with that scheme.
function makeShift(pattern, day) {
  const startMins = pattern.start * 60
  const endMins = (pattern.start + pattern.length) * 60
  return {
    id: `gen-${day}-${_genCounter++}-${Math.random().toString(36).slice(2, 7)}`,
    day,
    team: null, // assigned by the team-assignment post-pass
    role_type: 'Attending',
    role_detail: 'Attending',
    resident_level: null,
    start_time: minsToTime(startMins),
    end_time: minsToTime(endMins),
    startMins,
    endMins,
  }
}

function concurrencyAt(shifts, h) {
  let n = 0
  for (const s of shifts) if (shiftCoversHour(s, h)) n++
  return n
}

function capacityAt(shifts, h, c) {
  return concurrencyAt(shifts, h) * c
}

function startsAt(shifts, startMins) {
  return shifts.filter(s => s.startMins === startMins).length
}

function minConcurrentForHour(h, constraints) {
  const overnightHours = constraints.overnightHours ?? []
  return overnightHours.includes(h)
    ? (constraints.overnightMin ?? constraints.minConcurrent ?? 0)
    : (constraints.minConcurrent ?? 0)
}

function canAdd(shifts, pattern, constraints) {
  const hrs = patternHours(pattern)
  const maxConcurrent = constraints.maxConcurrent ?? Infinity
  for (const h of hrs) {
    if (concurrencyAt(shifts, h) >= maxConcurrent) return false
  }
  const maxStartsPerHour = constraints.maxStartsPerHour ?? maxConcurrent
  if (startsAt(shifts, pattern.start * 60) >= maxStartsPerHour) return false
  return true
}

function violatesConstraints(shifts, constraints) {
  const maxConcurrent = constraints.maxConcurrent ?? Infinity
  for (let h = 0; h < 24; h++) {
    const n = concurrencyAt(shifts, h)
    if (n > maxConcurrent) return true
    if (n < minConcurrentForHour(h, constraints)) return true
  }
  const maxStartsPerHour = constraints.maxStartsPerHour ?? maxConcurrent
  const counts = {}
  for (const s of shifts) counts[s.startMins] = (counts[s.startMins] ?? 0) + 1
  return Object.values(counts).some(n => n > maxStartsPerHour)
}

function uncoveredSeries(shifts, demandSeries, c) {
  return Array.from({ length: 24 }, (_, h) => Math.max(0, (demandSeries[h] ?? 0) - capacityAt(shifts, h, c)))
}

function objectiveValue(shifts, demandSeries, c, costPerHour) {
  const laborCost = shifts.reduce((sum, s) => sum + (s.endMins - s.startMins) / 60 * costPerHour, 0)
  const uncovered = uncoveredSeries(shifts, demandSeries, c).reduce((a, b) => a + b, 0)
  return laborCost + M_UNCOVERED_PENALTY * uncovered
}

// Greedy: repeatedly add whichever pattern closes the most weighted deficit
// per dollar, until no deficit remains, no pattern can help within
// constraints, or (if hourBudget is set) the budget is exhausted -- stopping
// early on budget naturally maximizes coverage under that budget, since
// greedy always picks the best-value move first.
function greedyCover(shifts, demandSeries, patterns, constraints, c, day, costPerHour, hourBudget) {
  let hoursUsed = shifts.reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
  let guard = 0
  while (guard++ < GREEDY_ITERATION_CAP) {
    let best = null
    let bestRatio = 0
    for (const pattern of patterns) {
      if (hourBudget != null && hoursUsed + pattern.length > hourBudget) continue
      if (!canAdd(shifts, pattern, constraints)) continue
      const hrs = patternHours(pattern)
      const closed = hrs.reduce((sum, h) => {
        const deficit = Math.max(0, (demandSeries[h] ?? 0) - capacityAt(shifts, h, c))
        return sum + Math.min(deficit, c)
      }, 0)
      if (closed <= 0) continue
      const cost = pattern.length * costPerHour
      const ratio = closed / cost
      if (ratio > bestRatio) { bestRatio = ratio; best = pattern }
    }
    if (!best) break
    shifts.push(makeShift(best, day))
    hoursUsed += best.length
  }
  return shifts
}

// After demand is covered, add whatever's still needed to satisfy
// minConcurrent/overnightMin at every hour, even hours with no remaining
// demand deficit.
function satisfyMinConcurrent(shifts, patterns, constraints, day, hourBudget) {
  let hoursUsed = shifts.reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
  let guard = 0
  while (guard++ < GREEDY_ITERATION_CAP) {
    let best = null
    let bestScore = 0
    for (const pattern of patterns) {
      if (hourBudget != null && hoursUsed + pattern.length > hourBudget) continue
      if (!canAdd(shifts, pattern, constraints)) continue
      const hrs = patternHours(pattern)
      const need = hrs.reduce((sum, h) => sum + (concurrencyAt(shifts, h) < minConcurrentForHour(h, constraints) ? 1 : 0), 0)
      if (need <= 0) continue
      const score = need / pattern.length
      if (score > bestScore) { bestScore = score; best = pattern }
    }
    if (!best) break
    shifts.push(makeShift(best, day))
    hoursUsed += best.length
  }
  return shifts
}

// Local search: try deleting each shift, shifting each start by +/- 1 hour,
// and swapping each shift for a different allowed length. Accept any move
// that improves the objective without violating constraints. Loop until no
// improving move exists, with an iteration cap.
function localSearch(shifts, demandSeries, allowedLengths, constraints, c, costPerHour) {
  let current = shifts
  let currentObj = objectiveValue(current, demandSeries, c, costPerHour)
  let iterations = 0
  let improved = true

  while (improved && iterations < LOCAL_SEARCH_ITERATION_CAP) {
    improved = false
    for (let i = 0; i < current.length && !improved; i++) {
      const shift = current[i]
      const length = (shift.endMins - shift.startMins) / 60
      const candidates = []

      // delete
      candidates.push(current.filter((_, idx) => idx !== i))

      // shift start +/- 1 hour (circular)
      for (const delta of [-1, 1]) {
        const newStartHour = (((shift.startMins / 60) + delta) % 24 + 24) % 24
        const newStartMins = newStartHour * 60
        const newEndMins = newStartMins + length * 60
        candidates.push(current.map((s, idx) => idx === i
          ? { ...s, startMins: newStartMins, endMins: newEndMins, start_time: minsToTime(newStartMins), end_time: minsToTime(newEndMins) }
          : s))
      }

      // swap to a different allowed length, same start
      for (const len of allowedLengths) {
        if (len === length) continue
        const newEndMins = shift.startMins + len * 60
        candidates.push(current.map((s, idx) => idx === i
          ? { ...s, endMins: newEndMins, end_time: minsToTime(newEndMins) }
          : s))
      }

      for (const cand of candidates) {
        iterations++
        if (iterations >= LOCAL_SEARCH_ITERATION_CAP) break
        if (violatesConstraints(cand, constraints)) continue
        const obj = objectiveValue(cand, demandSeries, c, costPerHour)
        if (obj < currentObj - 1e-9) {
          current = cand
          currentObj = obj
          improved = true
          break
        }
      }
    }
  }
  return current
}

// generateSchedule({ demand, target, day, area, patterns, constraints, pph })
//   -> { shifts, uncovered: number[24], objective, patternCounts }
//
// constraints: { minConcurrent, maxConcurrent, overnightMin, overnightHours,
//                maxStartsPerHour, costPerHour, hourBudget? }
// hourBudget, if set, caps total shift-hours THIS call may add (used by the
// caller to implement "maximise coverage under a fixed weekly hour budget"
// by slicing the budget across days/templates and passing the remainder).
export function generateSchedule({ demand, target, day, area, patterns, constraints, pph }) {
  const demandSeries = getDemandSeries(demand, AREA_LABEL[area], day, target)
  const c = pph[`${area}Own`] ?? pph[area] ?? 0
  const costPerHour = constraints.costPerHour ?? 250
  const allowedLengths = [...new Set(patterns.map(p => p.length))]

  let shifts = []
  shifts = greedyCover(shifts, demandSeries, patterns, constraints, c, day, costPerHour, constraints.hourBudget)
  shifts = satisfyMinConcurrent(shifts, patterns, constraints, day, constraints.hourBudget)
  shifts = localSearch(shifts, demandSeries, allowedLengths, constraints, c, costPerHour)

  const uncovered = uncoveredSeries(shifts, demandSeries, c).map(v => parseFloat(v.toFixed(3)))
  const objective = objectiveValue(shifts, demandSeries, c, costPerHour)

  const patternCounts = {}
  for (const s of shifts) {
    const length = (s.endMins - s.startMins) / 60
    const key = `${s.start_time}-${s.end_time}`
    patternCounts[key] = { count: (patternCounts[key]?.count ?? 0) + 1, start: s.start_time, end: s.end_time, length }
  }

  return { shifts, uncovered, objective, patternCounts }
}

const AREA_NAMED_TEAMS = { main: STATIC_MAIN, fasttrack: ['FastTrack'], eru: ['ERU'] }
const GENERATOR_COLORS = ['#0d9488','#ec4899','#f59e0b','#6366f1','#84cc16','#06b6d4','#f43f5e','#64748b']

function shiftsOverlap(a, b) {
  const aOvernight = a.endMins > 1440
  const bOvernight = b.endMins > 1440
  if (!aOvernight && !bOvernight) return a.startMins < b.endMins && a.endMins > b.startMins
  if (aOvernight && bOvernight) return true
  const [on, off] = aOvernight ? [a, b] : [b, a]
  const wrapEnd = on.endMins - 1440
  return on.startMins < off.endMins || wrapEnd > off.startMins
}

// 4.5 team assignment: the solver produces anonymous attending slots. This
// post-pass assigns them to teams by start time order (earliest to the
// area's first named team, then the next, ...), creating an additional
// (custom) team only when concurrency exceeds the named team count.
// maxConcurrent therefore controls how many teams get created.
export function assignTeams(shifts, area, existingCustomTeamNames = []) {
  const namedTeams = AREA_NAMED_TEAMS[area] ?? []
  const sorted = [...shifts].sort((a, b) => a.startMins - b.startMins)
  const lanes = [] // [{ name, shifts: [] }]
  const newTeams = []
  let extraCount = 0

  for (const shift of sorted) {
    let lane = lanes.find(l => !l.shifts.some(s => shiftsOverlap(s, shift)))
    if (!lane) {
      const idx = lanes.length
      let name = namedTeams[idx]
      if (!name) {
        do {
          extraCount++
          name = `Generated Team ${extraCount}`
        } while (existingCustomTeamNames.includes(name))
        newTeams.push({ name, color: GENERATOR_COLORS[(idx - namedTeams.length) % GENERATOR_COLORS.length], area: AREA_LABEL[area] })
      }
      lane = { name, shifts: [] }
      lanes.push(lane)
    }
    lane.shifts.push(shift)
    shift.team = lane.name
  }

  return { shifts: sorted, newTeams }
}
