// SHARED — why modeled deficits remain in a plan.
//
// For every area-hour with unmet demand, asks what would add capacity THERE
// under the plan's own constraints, and labels the limiting factor(s):
//   ATTENDING      another attending could be added (team/pool and area
//                  limits allow it), would add capacity, and some permitted
//                  shift covering the hour puts most of that capacity
//                  against unmet demand — more attending hours would help
//   RESIDENT_APP   an attending on duty has supervision headroom (or, in
//                  FastTrack, a PA works solo): one more PA would add
//                  capacity WITHOUT another attending. Nothing is added —
//                  this only says where the resident/APP roster binds
//   OPERATIONAL    a configured rule blocks another attending: the area is
//                  closed or cross-covered, it is at its maximum (ERU: one
//                  attending), or every team slot and the new-team pool is full
//   SHIFT_STRUCTURE another attending would add capacity at this hour, but
//                  no permitted shift covering it fits the limits, or the best
//                  one would put less than `utilizationThreshold` of its added
//                  capacity against unmet demand (the rest is surplus)
//   MODEL          none of the above: neither another attending nor another
//                  resident/PA adds modeled capacity here
// Several labels can apply to one hour; none is forced to be the only one.
// Marginal attending capacity comes from the solver instance's capacity
// tables (built by capacity.js); the extra-PA test uses capacity.js directly
// on the plan's shifts (with staff routing). Nothing here changes a plan.

import { AREA_LABEL } from './areas'
import { activeTeamsInArea, attendingCountForTeam, teamCapacityForTeam } from './capacity'
import { formatHour, formatRange } from './coverageInsights'
import { COVERAGE_MODE, effectiveShifts, fixedIntakeClosed } from './operationalCoverage'

export const BOTTLENECK = {
  ATTENDING: 'ATTENDING',
  RESIDENT_APP: 'RESIDENT_APP',
  OPERATIONAL: 'OPERATIONAL',
  SHIFT_STRUCTURE: 'SHIFT_STRUCTURE',
  MODEL: 'MODEL',
}
export const BOTTLENECK_ORDER = ['ATTENDING', 'RESIDENT_APP', 'OPERATIONAL', 'SHIFT_STRUCTURE', 'MODEL']
export const BOTTLENECK_LABEL = {
  ATTENDING: 'Attending-limited',
  RESIDENT_APP: 'Resident/APP-limited',
  OPERATIONAL: 'Operational-rule-limited',
  SHIFT_STRUCTURE: 'Shift-structure-limited',
  MODEL: 'Little modeled benefit',
}

// Share of an added attending's capacity that must meet unmet demand for a
// shift to count as a reasonable use of hours (the rest would be surplus).
export const DEFAULT_UTILIZATION_THRESHOLD = 0.5
const EPS = 1e-6

const hoursOf = p => Array.from({ length: p.length }, (_, i) => (p.start + i) % 24)

// Hourly start grid with the same lengths as `patterns` (the "expanded"
// shift structure used for comparison).
export function hourlyPatterns(patterns) {
  const lengths = [...new Set(patterns.map(p => p.length))]
  return lengths.flatMap(length => Array.from({ length: 24 }, (_, start) => ({ start, length })))
}

// instance: the solver instance the plan was built from; shifts: planned
// attending shifts [{ area, slot, day, start, length }]; week: analyzeWeek of
// the plan; shiftsForDay: the plan's full schedule (for the extra-PA test).
export function diagnoseBottlenecks({
  instance, shifts, week, shiftsForDay, customTeams = [], pph, coverage = null,
  patterns = instance.patterns, expandedPatterns = null,
  minUnmet = 0.01, utilizationThreshold = DEFAULT_UTILIZATION_THRESHOLD,
}) {
  const days = instance.days
  const expanded = expandedPatterns ?? hourlyPatterns(patterns)
  // n[area/slot][d][h]: attendings on each slot in the plan.
  const n = {}
  for (const a of instance.areas) for (const s of a.slots) n[`${a.key}/${s.id}`] = s.locked.map(row => [...row])
  for (const s of shifts ?? []) {
    const d = days.indexOf(s.day)
    const row = n[`${s.area}/${s.slot}`]?.[d]
    if (!row) continue
    for (const h of hoursOf(s)) row[h] += 1
  }

  const items = []
  instance.areas.forEach(area => {
    const inWeek = week.areas.includes(area.key)
    if (!inWeek) return
    days.forEach((day, d) => {
      const rowOf = h => week.days[d].analysis.hours[h].byArea[area.key]
      const unmet = Array.from({ length: 24 }, (_, h) => Math.max(0, rowOf(h).demand - rowOf(h).capacity))
      const areaN = Array.from({ length: 24 }, (_, h) => area.slots.reduce((t, s) => t + n[`${area.key}/${s.id}`][d][h], 0))
      const areaMax = h => area.maxCoverage?.[d]?.[h] ?? Infinity
      // Can slot s take one more attending at hour h? (team/pool AND area max)
      const addable = (s, h) => n[`${area.key}/${s.id}`][d][h] + 1 <= s.maxAttendings[d][h] && areaN[h] + 1 <= areaMax(h)
      const gain = (s, h) => {
        const k = n[`${area.key}/${s.id}`][d][h]
        return addable(s, h) ? (s.capacity[d][h][k + 1] ?? s.capacity[d][h][k]) - s.capacity[d][h][k] : 0
      }
      // Best permitted shift through hour h on slot s: share of its added
      // capacity that meets unmet demand, and unmet reduced per attending-hour.
      const bestShift = (s, h, menu) => {
        let best = null
        for (const p of menu) {
          const hs = hoursOf(p)
          if (!hs.includes(h) || !hs.every(x => addable(s, x))) continue
          const potential = hs.reduce((t, x) => t + gain(s, x), 0)
          const benefit = hs.reduce((t, x) => t + Math.min(gain(s, x), unmet[x]), 0)
          const util = potential > EPS ? benefit / potential : 0
          if (!best || benefit / p.length > best.perHour + EPS) best = { pattern: p, util, perHour: benefit / p.length, benefit }
        }
        return best
      }

      for (let h = 0; h < 24; h++) {
        if (unmet[h] <= minUnmet) continue
        const mode = area.coverageMode?.[d]?.[h] ?? COVERAGE_MODE.FLEXIBLE
        const labels = new Set()
        const why = {}

        // Operational: can any slot take another attending at all?
        const gains = area.slots.map(s => ({ slot: s, g: gain(s, h) }))
        const anyAddable = area.slots.some(s => addable(s, h))
        if (mode === COVERAGE_MODE.CLOSED || mode === COVERAGE_MODE.CROSS_COVERED) {
          labels.add(BOTTLENECK.OPERATIONAL)
          why.operational = mode === COVERAGE_MODE.CLOSED ? 'closed' : 'crossCovered'
        } else if (areaN[h] + 1 > areaMax(h)) {
          labels.add(BOTTLENECK.OPERATIONAL)
          why.operational = 'areaMax'
          why.areaMax = areaMax(h)
        } else if (!anyAddable) {
          labels.add(BOTTLENECK.OPERATIONAL)
          why.operational = 'teamMax'
        }

        // Another attending: gain, and whether a permitted shift uses it well.
        const helpful = gains.filter(x => x.g > EPS)
        if (helpful.length) {
          let best = null, bestExp = null
          for (const x of helpful) {
            const b = bestShift(x.slot, h, patterns)
            if (b && (!best || b.perHour > best.perHour)) best = { ...b, x }
            const e = bestShift(x.slot, h, expanded)
            if (e && (!bestExp || e.perHour > bestExp.perHour)) bestExp = e
          }
          const top = best ? best.x : helpful.reduce((m, x) => (x.g > m.g ? x : m), helpful[0])
          why.attending = {
            gain: top.g, slot: top.slot.id, newTeam: !!top.slot.flex, noAttending: areaN[h] === 0,
            bestShift: best && { start: best.pattern.start, length: best.pattern.length, utilization: best.util, perHour: best.perHour },
            expanded: bestExp && { start: bestExp.pattern.start, length: bestExp.pattern.length, utilization: bestExp.util, perHour: bestExp.perHour },
          }
          if (!best) {
            labels.add(BOTTLENECK.SHIFT_STRUCTURE)
            why.structure = 'noFit'
          } else if (best.util < utilizationThreshold) {
            labels.add(BOTTLENECK.SHIFT_STRUCTURE)
            why.structure = 'lowUtilization'
          } else {
            labels.add(BOTTLENECK.ATTENDING)
          }
        }

        // One more PA on a team in the area (capacity.js, routed shifts).
        const pa = mode === COVERAGE_MODE.CLOSED ? { gain: 0 }
          : extraPaGain({ shifts: shiftsForDay(day), coverage, day, h, area: area.key, customTeams, pph, slots: area.slots })
        if (pa.gain > EPS) {
          labels.add(BOTTLENECK.RESIDENT_APP)
          why.residentApp = pa
        }
        if (!labels.size) labels.add(BOTTLENECK.MODEL)

        const item = {
          area: area.key, day, hour: h, demand: rowOf(h).demand, capacity: rowOf(h).capacity, unmet: unmet[h],
          labels: BOTTLENECK_ORDER.filter(l => labels.has(l)), why,
        }
        item.text = explain(item, pph)
        items.push(item)
      }
    })
  })
  return summarizeBottlenecks(items)
}

// Largest capacity gain from one more PA on any team in the area at hour h.
function extraPaGain({ shifts, coverage, day, h, area, customTeams, pph, slots }) {
  const on = coverage ? effectiveShifts(shifts, coverage, day, h) : shifts
  const teams = new Set(activeTeamsInArea(on, customTeams, area, h))
  for (const s of slots) if (!s.flex) teams.add(s.id)
  let best = { gain: 0 }
  for (const team of teams) {
    // A team closed to new patients this hour gains nothing from another PA.
    if (coverage && fixedIntakeClosed(coverage, team, day, h)) continue
    const before = teamCapacityForTeam(on, pph, area, team, h)
    const pa = { team, role_type: 'PA', role_detail: 'PA', resident_level: null, startMins: h * 60, endMins: h * 60 + 60 }
    const g = teamCapacityForTeam([...on, pa], pph, area, team, h) - before
    if (g > best.gain + EPS) {
      const att = attendingCountForTeam(on, team, h)
      best = { gain: g, team, attendings: att, solo: att === 0 }
    }
  }
  return best
}

const pct = x => `${Math.round(100 * x)}%`
const f2 = x => Number(x).toFixed(2)

// Plain-language reason(s) for one deficit hour.
export function explain(item, pph = {}) {
  const A = AREA_LABEL[item.area] ?? item.area
  const out = []
  const w = item.why
  if (w.operational === 'closed') out.push(`${A} is closed at this hour under the configured rules; its recorded demand has no staffing path.`)
  if (w.operational === 'crossCovered') out.push(`${A} is cross-covered here: the scenario permits no dedicated ${A} attending at this hour, and the cross-cover credit assumption decides how much of its demand counts as served.`)
  if (w.operational === 'areaMax') out.push(`${A} already has its maximum of ${w.areaMax} attending${w.areaMax === 1 ? '' : 's'} on (structural rule).`)
  if (w.operational === 'teamMax') out.push(`Every ${A} team and the new-team pool is at its attending limit.`)
  if (w.attending) {
    const where = w.attending.newTeam ? 'a new team' : w.attending.slot
    const base = `Another ${A} attending on ${where} would add ${f2(w.attending.gain)} patients/hr${w.attending.noAttending ? ` (no ${A} attending is on at this hour)` : ''}`
    if (w.structure === 'noFit') {
      out.push(`${base}, but no permitted shift covering this hour fits within the attending limits of every hour it spans.`)
    } else if (w.structure === 'lowUtilization') {
      const b = w.attending.bestShift
      out.push(`${base}, but the best permitted shift (${formatHour(b.start)}+${b.length}h) would put only ${pct(b.utilization)} of that capacity against unmet demand (${f2(b.perHour)} patient-h per attending-hour); the rest would be surplus.`)
    } else {
      const b = w.attending.bestShift
      out.push(`${base}; a permitted shift (${formatHour(b.start)}+${b.length}h) would reduce unmet demand by ${f2(b.perHour)} patient-h per attending-hour. More attending hours would help here.`)
    }
    const e = w.attending.expanded, b = w.attending.bestShift
    if (e && (!b || e.perHour > b.perHour + 0.05)) {
      out.push(`With hourly start times, a ${formatHour(e.start)}+${e.length}h shift would reach ${pct(e.utilization)} use (${f2(e.perHour)} per attending-hour).`)
    }
  }
  if (w.residentApp) {
    const r = w.residentApp
    out.push(r.solo
      ? `One more ${r.team} PA working solo would add ${f2(r.gain)} patients/hr without an attending (assumed solo productivity ${pph.fasttrackPa ?? '—'}/hr).`
      : `${r.team}'s attending${r.attendings === 1 ? ' has' : 's have'} supervision headroom: one more PA (assumed ${pph.pa ?? '—'}/hr) would add ${f2(r.gain)} patients/hr without another attending.`)
  }
  if (!out.length) out.push('Neither another attending nor another resident/PA adds modeled capacity here.')
  return out.join(' ')
}

// Totals: unmet patient-hours per label (overlapping — an hour with two
// labels counts under both), per exact label combination (sums to the
// total), per area; and the largest contiguous runs for display.
export function summarizeBottlenecks(items) {
  const total = items.reduce((t, i) => t + i.unmet, 0)
  const byLabel = Object.fromEntries(BOTTLENECK_ORDER.map(l => [l, 0]))
  const byCombination = {}
  const byArea = {}
  for (const i of items) {
    for (const l of i.labels) byLabel[l] += i.unmet
    const key = i.labels.join('+')
    byCombination[key] = (byCombination[key] ?? 0) + i.unmet
    const a = (byArea[i.area] ??= { unmet: 0, byLabel: Object.fromEntries(BOTTLENECK_ORDER.map(l => [l, 0])) })
    a.unmet += i.unmet
    for (const l of i.labels) a.byLabel[l] += i.unmet
  }
  // Runs: same area/day/label set, consecutive hours.
  const runs = []
  for (const i of items) {
    const last = runs.at(-1)
    const key = i.labels.join('+')
    if (last && last.area === i.area && last.day === i.day && last.key === key && last.hours.at(-1) === i.hour - 1) {
      last.hours.push(i.hour); last.unmet += i.unmet; last.items.push(i)
    } else {
      runs.push({ area: i.area, day: i.day, key, labels: i.labels, hours: [i.hour], unmet: i.unmet, items: [i] })
    }
  }
  for (const r of runs) {
    const worst = r.items.reduce((b, x) => (x.unmet > b.unmet ? x : b), r.items[0])
    r.peak = worst.unmet   // worst hour's unmet (patients/hr), for display filtering
    r.text = `${AREA_LABEL[r.area] ?? r.area} ${r.day} ${formatRange(r.hours)}: ${r.unmet.toFixed(1)} patient-h short. ${worst.text}`
    delete r.items
  }
  runs.sort((x, y) => y.unmet - x.unmet)
  return { total, byLabel, byCombination, byArea, items, runs }
}
