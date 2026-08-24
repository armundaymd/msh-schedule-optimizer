import { shiftCoversHour, STATIC_MAIN } from '../../shared/capacity'
import { getDemandSeries } from '../../shared/demandSeries'

// Shift set covering formulation (Savage et al., CJEM 2014):
//
//   S        = menu of allowable shift patterns, each (start_hour, length_hours)
//   x[s]     = integer count of attendings assigned to pattern s
//   d[h]     = target demand at hour h
//   c        = attending capacity for the area (pph[area], the supervision
//              ceiling) -- NOT solo throughput. Main/ERU attendings
//              realistically never see patients alone (their "Own" PPH is
//              intentionally near-zero), so sizing this pass off solo
//              throughput would demand far more attendings than the
//              schedule actually needs once residents/PAs are layered in
//              afterward (a later phase) -- the ceiling is what one
//              attending's staffed team can actually handle, which is the
//              right number to scaffold against.
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

// Capacity beyond demand -- e.g. two identical 09:00-17:00 blocks instead of
// staggering one to 11:00-19:00 costs the same and covers the same peak, but
// leaves more unnecessary surplus sitting at 9am. Weighted small enough
// (a fraction of one hour's labor cost) that it only ever breaks ties
// between options with equal cost and equal coverage -- it must never be
// worth trading real hours or coverage to shave surplus.
function surplusSeries(shifts, demandSeries, c) {
  return Array.from({ length: 24 }, (_, h) => Math.max(0, capacityAt(shifts, h, c) - (demandSeries[h] ?? 0)))
}

// How far a shift's busiest hour (by raw demand, not remaining deficit --
// a fixed fact about the day, not something that shifts during
// construction) sits from that shift's own midpoint. A provider walking in
// right as their busiest hour begins has no runway to pick up those
// patients before also needing to start dispositioning them before signing
// out; centering it gives ramp-up time before and wind-down time after.
// Computed post-construction (local search only) rather than as a greedy
// tiebreak: a candidate window that structurally straddles the day's peak
// looks "centered" on every construction step regardless of how many times
// it's already been picked, which just reintroduces needless clustering.
function shiftCenteringPenalty(shift, demandSeries) {
  const startHour = shift.startMins / 60
  const length = (shift.endMins - shift.startMins) / 60
  let peakOffset = 0, peakDemand = -Infinity
  for (let i = 0; i < length; i++) {
    const h = Math.floor(startHour + i) % 24
    const d = demandSeries[h] ?? 0
    if (d > peakDemand) { peakDemand = d; peakOffset = i }
  }
  return Math.abs((peakOffset + 0.5) - length / 2)
}

// Returns [primary, surplus, centering] instead of one scalar: cost/coverage
// must always dominate, surplus must always dominate centering, and folding
// all three into one weighted sum lets a strong-enough centering gain
// outbid a surplus improvement (that happened in testing -- it undid the
// staggered-start fix above by drifting a shift back to a clustered
// position for slightly better centering). isBetterObjective below compares
// these lexicographically instead, so a lower-priority term can only ever
// break a tie left by the ones before it.
function objectiveValue(shifts, demandSeries, c, costPerHour) {
  const laborCost = shifts.reduce((sum, s) => sum + (s.endMins - s.startMins) / 60 * costPerHour, 0)
  const uncovered = uncoveredSeries(shifts, demandSeries, c).reduce((a, b) => a + b, 0)
  // Sum of SQUARES, not a plain sum: two configurations spending the same
  // total surplus hours can tie exactly on a plain sum regardless of
  // whether that surplus is spread thin across the day or piled onto one
  // hour (confirmed in testing -- a staggered vs. clustered pair of shifts
  // came out identical on total surplus). Squaring penalizes a single
  // concentrated spike more than the same total spread evenly, which is
  // what "don't overbook one hour just to reach a later peak" actually
  // means.
  const surplus = surplusSeries(shifts, demandSeries, c).reduce((sum, v) => sum + v * v, 0)
  const centering = shifts.reduce((sum, s) => sum + shiftCenteringPenalty(s, demandSeries), 0)
  return [laborCost + M_UNCOVERED_PENALTY * uncovered, surplus, centering]
}

function isBetterObjective(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return true
    if (a[i] > b[i] + 1e-9) return false
  }
  return false
}

// Greedy: repeatedly add whichever pattern closes the most weighted deficit
// per dollar, until no deficit remains, no pattern can help within
// constraints, or (if hourBudget is set) the budget is exhausted -- stopping
// early on budget naturally maximizes coverage under that budget, since
// greedy always picks the best-value move first.
//
// Ties (equal deficit-closed-per-dollar) are broken toward whichever
// candidate leaves less total surplus across the hours it covers -- without
// this, two patterns that close the same peak equally well are
// indistinguishable to the ratio alone, and greedy keeps re-picking the
// same earliest-in-menu pattern (e.g. stacking two 09:00-17:00 blocks)
// instead of staggering one later to hug a rising demand curve more
// closely. This never overrides the ratio itself -- it only decides between
// otherwise-equal options.
//
// Early in the build, several start hours can tie on BOTH ratio and
// resulting surplus (nothing's overbooked yet either way) -- a remaining
// tie is broken toward the LATER start hour, so the first commitments lean
// toward covering the middle of the day rather than exhausting the
// earliest pattern first and forcing a second one at the same hour later.
// (A "center the peak within the shift" tiebreak was tried here instead,
// but a window that structurally straddles the demand peak looks
// well-centered on every iteration regardless of how many times it's
// already been picked -- it reintroduced the exact clustering this
// tiebreak chain exists to prevent. Peak-centering is applied later, as a
// small term in local search's objective instead, so it polishes the
// final shift placements without fighting construction order.)
function greedyCover(shifts, demandSeries, patterns, constraints, c, day, costPerHour, hourBudget) {
  let hoursUsed = shifts.reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
  let guard = 0
  while (guard++ < GREEDY_ITERATION_CAP) {
    let best = null
    let bestRatio = 0
    let bestSurplus = Infinity
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
      const surplusAfter = hrs.reduce((sum, h) => {
        const newCap = capacityAt(shifts, h, c) + c
        return sum + Math.max(0, newCap - (demandSeries[h] ?? 0))
      }, 0)
      const ratioTied = Math.abs(ratio - bestRatio) <= 1e-9
      const surplusTied = Math.abs(surplusAfter - bestSurplus) <= 1e-9
      const isBetter = ratio > bestRatio + 1e-9
        || (ratioTied && surplusAfter < bestSurplus - 1e-9)
        || (ratioTied && surplusTied && best != null && pattern.start > best.start)
      if (isBetter) { bestRatio = ratio; best = pattern; bestSurplus = surplusAfter }
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
        if (isBetterObjective(obj, currentObj)) {
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
  const c = pph[area] ?? 0
  const costPerHour = constraints.costPerHour ?? 250
  const allowedLengths = [...new Set(patterns.map(p => p.length))]

  let shifts = []
  shifts = greedyCover(shifts, demandSeries, patterns, constraints, c, day, costPerHour, constraints.hourBudget)
  shifts = satisfyMinConcurrent(shifts, patterns, constraints, day, constraints.hourBudget)
  shifts = localSearch(shifts, demandSeries, allowedLengths, constraints, c, costPerHour)

  const uncovered = uncoveredSeries(shifts, demandSeries, c).map(v => parseFloat(v.toFixed(3)))
  const objective = objectiveValue(shifts, demandSeries, c, costPerHour)[0]

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
//
// `reusableAreaTeams` is this area's already-created overflow teams (from
// an earlier group/day in the same generate run, or a prior run), in
// creation order -- they fill lane slots ahead of minting a new "Generated
// Team N", so a multi-group generate (e.g. weekday/Saturday/Sunday
// templates) doesn't mint a fresh set of overflow teams per group.
// `allExistingNames` is every team name currently known (any area, any
// source) purely to avoid a naming collision when minting a brand new
// "Generated Team N" -- e.g. a name left over from an earlier generate run
// that was never accepted/discarded, or a team the user created by hand.
export function assignTeams(shifts, area, reusableAreaTeams = [], allExistingNames = []) {
  const namedTeams = [...(AREA_NAMED_TEAMS[area] ?? []), ...reusableAreaTeams.map(t => t.name)]
  const baseCount = (AREA_NAMED_TEAMS[area] ?? []).length
  const sorted = [...shifts].sort((a, b) => a.startMins - b.startMins)
  const lanes = [] // [{ name, shifts: [] }]
  const newTeams = []
  let extraCount = reusableAreaTeams.length

  for (const shift of sorted) {
    // Among lanes that can take this shift without overlapping, prefer the
    // one whose most recent shift ends closest to this one's start --
    // ideally touching (gap 0) -- so the same team's shifts land back to
    // back for a handoff instead of an unrelated pair sharing a lane with
    // an idle gap between them just because both happened to fit somewhere.
    const openLanes = lanes.filter(l => !l.shifts.some(s => shiftsOverlap(s, shift)))
    let lane = null
    let bestGap = Infinity
    for (const l of openLanes) {
      const lastEnd = Math.max(...l.shifts.map(s => s.endMins))
      const gap = shift.startMins - lastEnd
      if (gap >= 0 && gap < bestGap) { lane = l; bestGap = gap }
    }
    // Overnight-spanning shifts can make "gap" come out negative even
    // though shiftsOverlap() correctly found no real conflict -- fall back
    // to the first open lane rather than minting an unneeded new team.
    if (!lane) lane = openLanes[0]
    if (!lane) {
      const idx = lanes.length
      let name = namedTeams[idx]
      if (!name) {
        do {
          extraCount++
          name = `Generated Team ${extraCount}`
        } while (allExistingNames.includes(name))
        newTeams.push({ name, color: GENERATOR_COLORS[(idx - baseCount) % GENERATOR_COLORS.length], area: AREA_LABEL[area] })
      }
      lane = { name, shifts: [] }
      lanes.push(lane)
    }
    lane.shifts.push(shift)
    shift.team = lane.name
  }

  return { shifts: sorted, newTeams }
}
