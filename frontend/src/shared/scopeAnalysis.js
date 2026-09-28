// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { AREAS, AREA_LABEL, scopeAreas } from './areas'
import { teamCapacity } from './capacity'
import { getDemandSeries } from './demandSeries'
import { crossCoverHour, effectiveShifts, operationalAreaCapacity, unsupervisedExtenderCapacity } from './operationalCoverage'

// Demand vs capacity for a scope, hour by hour, keeping BOTH the aggregate
// and every component area's own result.
//
// Capacity does not transfer between areas (Main demand can only be met by
// Main capacity — PHASE 2, 2.1), so a combined scope's aggregate net can hide
// a real shortfall: Main -4 and ERU +4 aggregate to 0. `componentDeficitHours`
// is therefore the deficit set to act on; `aggregateDeficitHours` is the
// pooled view, for display only.
//
// Returns {
//   scope, areas,
//   hours: [{ hour, demand, capacity, net, limitingNet, shortAreas,
//             byArea: { [area]: { demand, capacity, net } } }],
//   aggregateDeficitHours,   // hours where summed demand > summed capacity
//   componentDeficitHours,   // hours where ANY component area is short
//   deficitHoursByArea,      // { [area]: [hours] }
// }
// `limitingNet` is the aggregate net unless some component area is short,
// in which case it is the most-short component's net — a single per-hour
// number that never reads as covered when an area isn't.
// For a single-area scope all of these reduce to that area's own numbers.
//
// `coverage` (optional, shared/operationalCoverage.js config) switches this
// from the AS-SCHEDULED view to the OPERATIONAL one — the single
// authoritative operational-capacity calculation used by the staffing
// planner, its heatmap, allocator scoring and the analysis reports:
//   - staff routing: each hour uses effectiveShifts() (residents/PAs counted
//     where they operationally work, e.g. FastTrack overnight staff in Main);
//   - intake cutoffs: a team closed to NEW patients (Blue from 20:00,
//     FastTrack from midnight, tool-added teams in their last 3 h) adds no
//     capacity against demand in those hours;
//   - cross-coverage: responsibility + supervision, and the configured
//     throughput credit added to the covered area's capacity;
//   - every byArea entry carries `coverage` (rule, how the hour was covered).
// Demand is never moved between areas. Without `coverage` capacity is
// exactly capacity.js's teamCapacity on the schedule as recorded.
export function analyzeScope({ shifts, demand, pph, customTeams = [], scope, day, target = 'mean', coverage = null }) {
  const areas = scopeAreas(scope)
  const series = {}
  const demandFor = area => (series[area] ??= getDemandSeries(demand, AREA_LABEL[area], day, target))
  const demandByArea = Object.fromEntries(areas.map(area => [area, demandFor(area)]))

  const hours = []
  const aggregateDeficitHours = []
  const componentDeficitHours = []
  const deficitHoursByArea = Object.fromEntries(areas.map(a => [a, []]))

  for (let h = 0; h < 24; h++) {
    const byArea = {}
    const shortAreas = []
    let totalDemand = 0, totalCapacity = 0, worstComponentNet = Infinity
    // Every area is evaluated (not only the scope's) so an out-of-scope
    // area drawing on the same covering headroom is accounted for.
    const on = coverage ? effectiveShifts(shifts, coverage, day, h) : shifts
    const cc = coverage ? crossCoverHour({ shifts: on, pph, customTeams, config: coverage, day, hour: h, areas: AREAS, demandFor }) : null
    for (const area of areas) {
      const d = demandByArea[area][h] ?? 0
      // Operational view: intake cutoffs apply (teams closed to new patients add nothing).
      const own = coverage
        ? operationalAreaCapacity({ on, pph, customTeams, area, day, hour: h, config: coverage })
        : teamCapacity(on, pph, customTeams, area, h)
      const x = cc?.[area]
      const c = own + (x?.credit ?? 0)
      const net = c - d
      byArea[area] = { demand: d, capacity: c, net }
      if (x) {
        byArea[area].coverage = {
          mode: x.rule.mode, minAttendings: x.rule.minAttendings, coveredBy: x.rule.coveredBy,
          ownAttendings: x.ownAttendings, crossCovered: x.active,
          crossCoverCredit: x.credit, crossCoverCreditMode: x.creditMode, supervisedByCovering: x.supervised,
          unsupervisedExtender: x.active ? 0 : unsupervisedExtenderCapacity(on, pph, customTeams, area, h),
        }
      }
      totalDemand += d
      totalCapacity += c
      if (d > c) {
        shortAreas.push(area)
        deficitHoursByArea[area].push(h)
      }
      worstComponentNet = Math.min(worstComponentNet, net)
    }
    const net = totalCapacity - totalDemand
    if (totalDemand > totalCapacity) aggregateDeficitHours.push(h)
    if (shortAreas.length > 0) componentDeficitHours.push(h)
    hours.push({
      hour: h, demand: totalDemand, capacity: totalCapacity, net,
      limitingNet: shortAreas.length > 0 ? worstComponentNet : net,
      shortAreas, byArea,
    })
  }

  return { scope, areas, hours, aggregateDeficitHours, componentDeficitHours, deficitHoursByArea }
}
