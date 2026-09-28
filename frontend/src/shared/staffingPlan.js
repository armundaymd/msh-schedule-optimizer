// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { AREAS, AREA_LABEL, scopeAreas, teamsInArea } from './areas'
import { attendingCapacity, extenderCapacity, shiftCoversHour, teamArea, teamCapacityForTeam } from './capacity'
import { getDemandSeries } from './demandSeries'
import { DISPLAY_DEFICIT_TOLERANCE_PPH, EXCESS_MIN_FRACTION, EXCESS_MIN_PPH } from './coverageInsights'
import {
  COVERAGE_MODE, areaMaxAttendings, attendingsInArea, blocksDedicatedPlacement, coverageGrid, crossCoverApplies,
  crossCoverCreditParams, effectiveShifts, fixedIntakeClosed, intakeCutoffsOf, intakeLookahead, operationalCoverageSummary, requirementLabels,
  validateCoverageConfig,
} from './operationalCoverage'
import { analyzeWeek } from './weekCoverage'

// Staffing resource allocation — the frontend half. The backend solver
// (staffing/ on the server, OR-Tools CP-SAT) is rule-agnostic: every
// clinical rule stays here, in the same shared modules the rest of the app
// uses. This module
//   1. builds the solver instance: demand per area-hour (getDemandSeries),
//      and for every team "slot" a CAPACITY TABLE — patients/hr with n
//      attendings on at that hour — computed by capacity.js's own
//      teamCapacityForTeam, with that team's real residents/PAs;
//   2. turns the solver's shifts back into a proposed schedule;
//   3. measures current vs proposed with analyzeWeek (same as the heatmap).
//
// What is re-planned: attending shifts in the scope's areas, except locked
// ones. Residents/PAs, locked attendings, and every shift outside the scope
// are kept exactly as they are.
//
// Operational coverage (optional `coverage`, see operationalCoverage.js) is
// applied BEFORE the objective, as hard structure:
//   REQUIRED_DEDICATED -> minCoverage (sum of the area's attendings >= min)
//   CROSS_COVERED, CLOSED -> no new dedicated attendings (slot maxAttendings
//                         = locked), so no shift may reach into those hours
//   cross-coverage     -> instance.crossCover: throughput credited under the
//                         area's explicit cross-cover credit assumption
//                         (none by default; solver mirrors crossCoverHour)
// Area attending MAXIMUMS (maxAttendingsByArea; ERU = 1, structural) apply
// whether or not the coverage rules are on: slot limits are capped and the
// solver gets a per-hour area maximum.
// RESIDENT SUPERVISION (confirmed operational rule, hard): a resident on a
// clinical team may only work while that team has a supervising attending.
// For every existing team slot, `minAttendings[d][h]` = 1 whenever a
// resident operates on that team at that hour — after staff routing, so a
// routed resident is supervised on the team it works on, never on its
// recorded team. Residents stay fixed inputs; attendings on OTHER teams
// (including planner-added new teams) never supervise them. The one
// exemption is explicit cross-coverage: in a CROSS_COVERED hour the covering
// area's attendings are responsible and supervise the area's residents, so
// the covering area must then have at least one attending (minCoverage). In a
// FLEXIBLE hour with a covering area, cross-coverage applies only while the
// area has NO attending of its own, so the slot gets
// `supervisedUnlessUncovered[d][h]` = 1: this team has an attending, OR the
// area has none at all (and the covering area, which must have one, supervises).
// An attending on another team of the area never counts.
// PAs/APPs are not covered by this rule (their capacity rules are unchanged).
// Demand is never moved: every area keeps its own historical series.

export const WEEKS_PER_YEAR = 52 // matches the app's "Yearly hrs (x52)"
export const DEFAULT_MAX_PER_TEAM = 1 // attendings at once on an existing team
export const DEFAULT_MAX_FLEX = 3 // attendings at once in an area's new-team pool
export const SEVERE_DEFICIT_PPH = 2 // matches the solver's severe tier (> 2 PPH)
// Demand at or above this with no attending on counts as unattended demand.
export const UNATTENDED_DEMAND_PPH = 0.1

// Budget entered per year or per week -> weekly hours used by the solver,
// unrounded. The solver enforces it in half-hours rounding DOWN and reports
// any remainder rather than hiding it.
export function weeklyBudget(amount, period) {
  const hours = Number(amount) || 0
  const weeklyHours = period === 'annual' ? hours / WEEKS_PER_YEAR : hours
  return { weeklyHours, annualHours: weeklyHours * WEEKS_PER_YEAR }
}

function startHour(shift) {
  return Math.floor(shift.startMins / 60) % 24
}

// A lock rule keeps an area's CURRENT attending shifts that start within
// [fromHour, toHour) (circular; from === to means all day) unchanged.
export function isLockedShift(shift, area, customTeams, lockRules) {
  if (shift.role_type !== 'Attending') return false
  if (teamArea(shift.team, customTeams) !== area) return false
  const h = startHour(shift)
  return lockRules.some(r => {
    if (r.area !== area) return false
    if (r.fromHour === r.toHour) return true
    return r.fromHour < r.toHour
      ? h >= r.fromHour && h < r.toHour
      : h >= r.fromHour || h < r.toHour
  })
}

function inWindow(h, fromHour, toHour) {
  if (fromHour === toHour) return true
  return fromHour < toHour ? h >= fromHour && h < toHour : h >= fromHour || h < toHour
}

function syntheticAttendings(team, hour, n) {
  return Array.from({ length: n }, () => ({
    team, role_type: 'Attending', resident_level: null, startMins: hour * 60, endMins: hour * 60 + 60,
  }))
}

const FLEX_TEAM = '__plan_flex__'

// Builds { instance, context }. `instance` is POSTed to /api/staffing-plan;
// `context` is what applyPlanResult needs to rebuild the schedule.
// mode: 'budget' | 'requirement' | 'target' | 'min_practical' (solver modes;
// see attendingPlanner.js). `planning` carries the target / tolerance fields
// ({ targetCoverage, maxUnmetPph, areaTargetCoverage, areaMaxUnmetPph,
// practicalTolerancePct }); `hint` = shifts from a neighbouring solve.
export function buildPlanInstance({
  days, shiftsForDay, customTeams = [], pph, demand, target = 'mean', scope,
  patterns, lockRules = [], minCoverageRules = [],
  mode = 'budget', weeklyBudgetHours = null, allowedDeficitPph = 0,
  maxPerTeam = DEFAULT_MAX_PER_TEAM, maxFlex = DEFAULT_MAX_FLEX,
  effort = 'standard', coverage = null, maxAttendingsByArea = areaMaxAttendings(coverage),
  planning = {}, hint = [],
}) {
  const areas = scopeAreas(scope)
  if (coverage) {
    const errors = validateCoverageConfig(coverage, customTeams)
    if (errors.length) throw new Error(`Operational coverage config is invalid: ${errors.join(' ')}`)
  }
  // [dayIndex][hour] resolved rule per area (every area: cross-coverage can
  // involve areas outside the scope).
  const grids = coverage ? Object.fromEntries(AREAS.map(a => [a, coverageGrid(coverage, a, days)])) : null
  const blocked = (area, di, h) => !!grids && blocksDedicatedPlacement(grids[area][di][h].mode)
  const keptByDay = {}
  const lockedByDay = {}
  let lockedHours = 0

  for (const day of days) {
    const shifts = shiftsForDay(day)
    keptByDay[day] = []
    lockedByDay[day] = []
    for (const s of shifts) {
      const area = teamArea(s.team, customTeams)
      const replanned = s.role_type === 'Attending' && areas.includes(area)
      if (!replanned) { keptByDay[day].push(s); continue }
      if (isLockedShift(s, area, customTeams, lockRules)) {
        keptByDay[day].push(s)
        lockedByDay[day].push(s)
        lockedHours += (s.endMins - s.startMins) / 60
      }
    }
  }

  // Resident supervision. residentsOn(team, day, h): residents operating on
  // `team` at h (staff routing applied when a coverage config is given).
  const operating = (day, h) => (coverage ? effectiveShifts(keptByDay[day], coverage, day, h) : keptByDay[day])
  const residentsOn = (team, day, h) => operating(day, h).filter(s => s.role_type === 'Resident' && s.team === team && shiftCoversHour(s, h)).length
  const crossCoveredAt = (area, di, h) => !!grids && grids[area][di][h].mode === COVERAGE_MODE.CROSS_COVERED
  const flexCoveredAt = (area, di, h) => !!grids && grids[area][di][h].mode === COVERAGE_MODE.FLEXIBLE && !!grids[area][di][h].coveredBy
  // Covering areas that must have an attending on because a cross-covered
  // area's residents are working: { [coveringArea]: [d][h] 0/1 }.
  const coverSupervision = {}
  for (const area of AREAS) {
    if (!grids) break
    days.forEach((day, di) => {
      for (let h = 0; h < 24; h++) {
        if (!crossCoveredAt(area, di, h) && !flexCoveredAt(area, di, h)) continue
        const by = grids[area][di][h].coveredBy
        if (!by) continue
        const res = operating(day, h).filter(s => s.role_type === 'Resident' && teamArea(s.team, customTeams) === area && shiftCoversHour(s, h)).length
        if (!res) continue
        coverSupervision[by] ??= days.map(() => Array(24).fill(0))
        coverSupervision[by][di][h] = 1
      }
    })
  }

  const slotMeta = {} // `${area}/${slotId}` -> { area, team, flex }
  const instanceAreas = areas.map(area => {
    const teamNames = new Set(teamsInArea(area, customTeams))
    for (const day of days) {
      for (const s of shiftsForDay(day)) {
        if (teamArea(s.team, customTeams) === area) teamNames.add(s.team)
      }
    }

    const slots = [...teamNames].map(team => {
      slotMeta[`${area}/${team}`] = { area, team, flex: false }
      const locked = [], maxAttendings = [], capacity = [], minAttendings = [], unlessUncovered = []
      days.forEach((day, di) => {
        const lockedAtt = lockedByDay[day].filter(s => s.team === team)
        const lockedRow = [], maxRow = [], capRow = [], minRow = [], unlessRow = []
        for (let h = 0; h < 24; h++) {
          // Residents/PAs operating on this team at this hour (staff routing
          // applied when a coverage config is given; attendings never routed).
          const base = (coverage ? effectiveShifts(keptByDay[day], coverage, day, h) : keptByDay[day])
            .filter(s => s.team === team && s.role_type !== 'Attending')
          const nLocked = lockedAtt.filter(s => shiftCoversHour(s, h)).length
          const cap = maxAttendingsByArea[area] ?? Infinity
          const top = Math.max(Math.min(maxPerTeam, cap), nLocked)
          lockedRow.push(nLocked)
          maxRow.push(blocked(area, di, h) ? nLocked : top)
          const res = residentsOn(team, day, h) > 0
          minRow.push(res && !crossCoveredAt(area, di, h) && !flexCoveredAt(area, di, h) ? 1 : 0)
          unlessRow.push(res && flexCoveredAt(area, di, h) ? 1 : 0)
          // Intake cutoff (fixed clock window): the team takes no new patients
          // this hour, so it adds no capacity against demand whatever n is.
          const closed = !!coverage && fixedIntakeClosed(coverage, team, day, h)
          capRow.push(Array.from({ length: top + 1 }, (_, n) =>
            (closed ? 0 : teamCapacityForTeam([...base, ...syntheticAttendings(team, h, n)], pph, area, team, h))))
        }
        locked.push(lockedRow); maxAttendings.push(maxRow); capacity.push(capRow); minAttendings.push(minRow); unlessUncovered.push(unlessRow)
      })
      const look = coverage ? intakeLookahead(coverage, team) : 0
      return {
        id: team, flex: false, locked, maxAttendings, capacity, minAttendings,
        ...(look ? { intakeLookahead: look } : {}),
        ...(unlessUncovered.some(row => row.some(v => v)) ? { supervisedUnlessUncovered: unlessUncovered } : {}),
      }
    })

    // New teams: no residents/PAs. One pooled slot is exact because a team
    // with no extenders has capacity linear in its attendings.
    const flexId = `${area}:flex`
    slotMeta[`${area}/${flexId}`] = { area, team: null, flex: true }
    const flexMax = Math.min(maxFlex, maxAttendingsByArea[area] ?? Infinity)
    const flexRow = h => Array.from({ length: flexMax + 1 }, (_, n) =>
      teamCapacityForTeam(syntheticAttendings(FLEX_TEAM, h, n), pph, area, FLEX_TEAM, h))
    slots.push({
      id: flexId, flex: true,
      locked: days.map(() => Array(24).fill(0)),
      maxAttendings: days.map((_, di) => Array.from({ length: 24 }, (_, h) => (blocked(area, di, h) ? 0 : flexMax))),
      capacity: days.map(() => Array.from({ length: 24 }, (_, h) => flexRow(h))),
      // New teams take no new patients in their last N hours of coverage,
      // unless another new-team attending continues it (planned as one pool;
      // the app scores the resulting teams as the same pool — plannerPool).
      ...(coverage && intakeCutoffsOf(coverage)?.extraTeamsHoursBeforeEnd ? { intakeLookahead: intakeCutoffsOf(coverage).extraTeamsHoursBeforeEnd } : {}),
    })

    const demandRows = days.map(day => getDemandSeries(demand, AREA_LABEL[area], day, target).map(v => v ?? 0))
    return {
      key: area,
      demand: demandRows,
      excessTolerance: demandRows.map(row => row.map(d => Math.max(EXCESS_MIN_PPH, EXCESS_MIN_FRACTION * d))),
      minCoverage: days.map((_, di) => Array.from({ length: 24 }, (_, h) =>
        Math.max(0, grids ? grids[area][di][h].minAttendings : 0, coverSupervision[area]?.[di][h] ?? 0,
          ...minCoverageRules.filter(r => r.area === area && inWindow(h, r.fromHour, r.toHour)).map(r => r.min)))),
      slots,
      supervisionCeilingPph: pph[area] ?? 0,
      requirementLabels: [
        ...(coverage ? requirementLabels(coverage, area) : []),
        ...supervisionLabels(area, slots, coverSupervision[area]),
      ],
      ...(maxAttendingsByArea[area] != null ? { maxCoverage: days.map(() => Array(24).fill(maxAttendingsByArea[area])) } : {}),
      ...(grids ? { coverageMode: grids[area].map(row => row.map(r => r.mode)) } : {}),
    }
  })

  const instance = {
    mode, days, patterns, areas: instanceAreas,
    budgetHours: mode === 'budget' ? weeklyBudgetHours : null,
    lockedHours, allowedDeficitPph, effort, ...planning,
    ...(hint?.length ? { hint: hint.map(({ area, slot, day, start, length }) => ({ area, slot, day, start, length })) } : {}),
    ...(grids ? buildCrossCover({ days, areas, grids, keptByDay, pph, demand, target, customTeams, coverage }) : {}),
  }
  return { instance, context: { days, areas, keptByDay, lockedByDay, lockedHours, slotMeta, coverage } }
}

// Human-readable hard rules the resident-supervision requirement adds to an area.
function supervisionLabels(area, slots, covering) {
  const out = []
  for (const s of slots) {
    const n = (s.minAttendings ?? []).reduce((t, row) => t + row.reduce((a, v) => a + v, 0), 0)
    if (n) out.push(`Resident supervision: ${s.id} needs its own attending whenever its residents work (${n} team-hours/week)`)
    const u = (s.supervisedUnlessUncovered ?? []).reduce((t, row) => t + row.reduce((a, v) => a + v, 0), 0)
    if (u) out.push(`Resident supervision: ${s.id} needs its own attending, or ${AREA_LABEL[area]} no attending at all (cross-covered), whenever its residents work in flexible hours (${u} team-hours/week)`)
  }
  const c = (covering ?? []).reduce((t, row) => t + row.reduce((a, v) => a + v, 0), 0)
  if (c) out.push(`Resident supervision: ${AREA_LABEL[area]} must have an attending while cross-covering an area whose residents are working (${c} h/week)`)
  return out
}

// Cross-coverage inputs for the solver, in AREAS order (the order covered
// areas draw on a shared covering headroom — same as crossCoverHour).
//   crossCover[i] = { area, coveredBy, eligible[d][h], supervised[d][h], headroomFactor }
//     eligible: in-scope area — the rule makes coveredBy responsible when the
//               area has no own attending (the solver checks that);
//               out-of-scope area — cross-coverage is actually active (its
//               attendings are fixed, so this is known now).
//     supervised: the area's CREDITABLE resident/PA capacity (kept shifts) =
//                 residentCreditFraction × capacity, patients/hr.
//     headroomFactor: covered-area patients/hr per unit of covering headroom.
//   Areas whose assumption credits nothing (CONSERVATIVE) get no entry: the
//   solver has nothing to add. Their responsibility is still in the config.
//   coveringAreas[B] = { ceiling[d][h], load[d][h] } for covering areas
//     OUTSIDE the scope (fixed schedule, so their headroom inputs are constant):
//     attendings x ceiling, and the area's own expected demand.
function buildCrossCover({ days, areas, grids, keptByDay, pph, demand, target, customTeams, coverage }) {
  const crossCover = []
  const coveringOut = new Set()
  for (const area of AREAS) {
    const inScope = areas.includes(area)
    const eligible = [], supervised = []
    let any = false
    let coveredBy = null
    days.forEach((day, di) => {
      const eRow = [], sRow = []
      for (let h = 0; h < 24; h++) {
        const rule = grids[area][di][h]
        const kept = effectiveShifts(keptByDay[day], coverage, day, h)
        let ok = !!rule.coveredBy && (rule.mode === COVERAGE_MODE.CROSS_COVERED || rule.mode === COVERAGE_MODE.FLEXIBLE)
        if (ok && !inScope) ok = crossCoverApplies(rule, attendingsInArea(kept, customTeams, area, h))
        if (ok && coveredBy && rule.coveredBy !== coveredBy) {
          throw new Error(`${AREA_LABEL[area]} is cross-covered by more than one area in the week; the planner supports one covering area per covered area.`)
        }
        if (ok) { coveredBy = rule.coveredBy; any = true }
        const fraction = ok ? crossCoverCreditParams(coverage, area, rule.coveredBy, pph).residentCreditFraction : 0
        eRow.push(ok ? 1 : 0)
        sRow.push(ok ? fraction * extenderCapacity(kept, pph, customTeams, area, h) : 0)
      }
      eligible.push(eRow); supervised.push(sRow)
    })
    if (!any) continue
    const { residentCreditFraction, headroomFactor } = crossCoverCreditParams(coverage, area, coveredBy, pph)
    if (!(residentCreditFraction > 0 && headroomFactor > 0)) continue
    crossCover.push({ area, coveredBy, eligible, supervised, headroomFactor })
    if (!areas.includes(coveredBy)) coveringOut.add(coveredBy)
  }
  const coveringAreas = {}
  for (const b of coveringOut) {
    const ceiling = [], load = []
    days.forEach(day => {
      const kept = keptByDay[day]
      const d = getDemandSeries(demand, AREA_LABEL[b], day, target)
      ceiling.push(Array.from({ length: 24 }, (_, h) => attendingCapacity(kept, pph, customTeams, b, h)))
      load.push(Array.from({ length: 24 }, (_, h) => d[h] ?? 0))
    })
    coveringAreas[b] = { ceiling, load }
  }
  return crossCover.length ? { crossCover, coveringAreas } : {}
}

function minsToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`
}

function overlaps(a, b) {
  for (let h = 0; h < 24; h++) if (shiftCoversHour(a, h) && shiftCoversHour(b, h)) return true
  return false
}

const PLAN_COLORS = ['#0d9488', '#ec4899', '#f59e0b', '#6366f1', '#84cc16', '#06b6d4', '#f43f5e', '#64748b']

// Solver result -> { proposedByDay, newTeams, plannedShifts }. Existing-team
// shifts go on that team; flex-pool shifts are packed into the fewest
// non-overlapping new teams per area ("Plan Main 1", ...), reused across days.
export function applyPlanResult(result, context, customTeams = []) {
  const { days, keptByDay, slotMeta } = context
  const taken = new Set(customTeams.map(t => t.name))
  const newTeams = []
  const laneTeams = {} // area -> [team name by lane]
  const planned = Object.fromEntries(days.map(d => [d, []]))
  let seq = 0

  function toShift(s, day, team) {
    const startMins = s.start * 60
    const endMins = (s.start + s.length) * 60
    return {
      id: `plan-${day}-${seq++}`, day, team, role_type: 'Attending', role_detail: 'Attending',
      resident_level: null, start_time: minsToTime(startMins), end_time: minsToTime(endMins),
      startMins, endMins,
    }
  }

  function laneTeam(area, lane) {
    laneTeams[area] ??= []
    while (laneTeams[area].length <= lane) {
      let i = laneTeams[area].length + 1
      let name = `Plan ${AREA_LABEL[area]} ${i}`
      while (taken.has(name)) name = `Plan ${AREA_LABEL[area]} ${++i}`
      taken.add(name)
      const color = PLAN_COLORS[(newTeams.length) % PLAN_COLORS.length]
      // plannerPool: scored as one pool for the intake cutoff (see operationalAreaCapacity);
      // App strips it when a plan is applied, after which each team stands alone.
      newTeams.push({ name, color, area: AREA_LABEL[area], plannerPool: true })
      laneTeams[area].push(name)
    }
    return laneTeams[area][lane]
  }

  const sorted = [...(result.shifts ?? [])].sort((a, b) =>
    days.indexOf(a.day) - days.indexOf(b.day) || a.area.localeCompare(b.area) || a.start - b.start || b.length - a.length)
  for (const s of sorted) {
    const meta = slotMeta[`${s.area}/${s.slot}`]
    if (!meta) continue
    if (!meta.flex) { planned[s.day].push(toShift(s, s.day, meta.team)); continue }
    const draft = toShift(s, s.day, null)
    let lane = 0
    for (;;) {
      const name = laneTeam(s.area, lane)
      if (!planned[s.day].some(o => o.team === name && overlaps(o, draft))) { draft.team = name; break }
      lane++
    }
    planned[s.day].push(draft)
  }

  const proposedByDay = Object.fromEntries(days.map(d => [d, [...keptByDay[d], ...planned[d]]]))
  return { proposedByDay, newTeams, plannedByDay: planned }
}

function attendingHours(shifts) {
  return shifts.filter(s => s.role_type === 'Attending').reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)
}

// Coverage + allocation metrics for one schedule, from analyzeWeek (the same
// analysis the heatmap and chart use). Deficits are per component
// area-hour; `aggregate` is the pooled scope, reported alongside, never
// instead.
export function schedulePlanMetrics({ days, shiftsForDay, customTeams, demand, pph, scope, target, coverage = null }) {
  const week = analyzeWeek({ days, shiftsForDay, demand, pph, customTeams, scope, target, coverage })
  // deficitHours: raw (any demand > capacity) — used by analyses and reports.
  // displayDeficitHours: short by at least the DISPLAY tolerance — what screens show.
  const blank = () => ({ uncoveredPphHours: 0, deficitHours: 0, displayDeficitHours: 0, severeDeficitHours: 0, excessHours: 0, attendingHours: 0, unattendedDemandHours: 0 })
  const byArea = Object.fromEntries(week.areas.map(a => [a, blank()]))
  const aggregate = blank()
  const byDay = {}
  const byHour = Array(24).fill(0) // attending-hours per hour of day, summed over the week

  week.days.forEach(({ day, analysis, grid }) => {
    const shifts = shiftsForDay(day)
    const inScope = shifts.filter(s => s.role_type === 'Attending' && week.areas.includes(teamArea(s.team, customTeams)))
    byDay[day] = attendingHours(inScope)
    const onByArea = Object.fromEntries(week.areas.map(a => [a, Array(24).fill(0)]))
    for (const s of inScope) {
      const a = teamArea(s.team, customTeams)
      byArea[a].attendingHours += (s.endMins - s.startMins) / 60
      for (let h = 0; h < 24; h++) {
        if (shiftCoversHour(s, h)) { byHour[h] += 1; onByArea[a][h] += 1 }
      }
    }
    for (const row of analysis.hours) {
      for (const a of week.areas) {
        const { net, demand: d } = row.byArea[a]
        const m = byArea[a]
        // Patients expected but no attending in the area at all — and no
        // covering area responsible (cross-covered hours are reported in
        // `operational`, separately from dedicated coverage).
        if (d >= UNATTENDED_DEMAND_PPH && onByArea[a][row.hour] === 0 && !row.byArea[a].coverage?.crossCovered) m.unattendedDemandHours++
        if (net < 0) {
          m.uncoveredPphHours += -net
          m.deficitHours++
          if (-net >= DISPLAY_DEFICIT_TOLERANCE_PPH - 1e-12) m.displayDeficitHours++
          if (-net > SEVERE_DEFICIT_PPH) m.severeDeficitHours++
        }
        if (grid.byArea[a].status[row.hour] === 'excess') m.excessHours++
      }
      if (row.net < 0) aggregate.uncoveredPphHours += -row.net
      if (row.demand > row.capacity) aggregate.deficitHours++
      if (row.demand - row.capacity >= DISPLAY_DEFICIT_TOLERANCE_PPH - 1e-12) aggregate.displayDeficitHours++
      if (grid.aggregate.status[row.hour] === 'excess') aggregate.excessHours++
    }
  })
  aggregate.attendingHours = Object.values(byArea).reduce((t, m) => t + m.attendingHours, 0)
  // Component deficits summed (not pooled) — what the optimizer minimises.
  const componentUncoveredPphHours = Object.values(byArea).reduce((t, m) => t + m.uncoveredPphHours, 0)
  const operational = coverage ? operationalCoverageSummary({ week, days, shiftsForDay, customTeams }) : null
  return { week, byArea, aggregate, componentUncoveredPphHours, byDay, byHour, operational }
}

// Largest |solver capacity - capacity.js capacity| over the plan, per
// area-hour. The solver only rounds to 0.01 PPH per slot, so anything
// beyond a few hundredths means the instance and the app disagree.
export function capacityCrossCheck(result, proposedWeek) {
  let worst = 0
  proposedWeek.days.forEach(({ analysis }, d) => {
    for (const area of proposedWeek.areas) {
      const modeled = result.modeledCapacity?.[area]?.[d]
      if (!modeled) continue
      for (let h = 0; h < 24; h++) {
        worst = Math.max(worst, Math.abs(modeled[h] - analysis.hours[h].byArea[area].capacity))
      }
    }
  })
  return worst
}
