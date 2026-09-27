// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { AREA_LABEL, scopeAreas } from './areas'

// Single accessor for a team's 24-hour demand series, replacing the
// `?? overall` fallback that used to be duplicated in CapacityChart,
// SummaryStatsBar, and twice in optimizer.js.
//
// target: 'mean' | 'p50' | 'p75' | 'p90'
// Fallback chain: requested percentile for that DOW, then that percentile
// overall, then the mean for that DOW, then the mean overall, then a
// 24-zero array. Never throws.
export function getDemandSeries(demand, team, day, target = 'mean') {
  const teamDemand = demand?.[team]
  if (!teamDemand) return Array(24).fill(0)

  if (target !== 'mean') {
    const p = target
    const byDow = teamDemand.pct?.by_dow?.[day]?.[p]
    if (byDow) return byDow
    const overall = teamDemand.pct?.overall?.[p]
    if (overall) return overall
  }

  const meanByDow = teamDemand.by_dow?.[day]
  if (meanByDow) return meanByDow
  const meanOverall = teamDemand.overall
  if (meanOverall) return meanOverall

  return Array(24).fill(0)
}

// True when `demand` carries percentile data at all (production will lack
// this until the pipeline is re-run there — see known trap #4).
export function hasPercentiles(demand) {
  if (!demand) return false
  return Object.values(demand).some(teamDemand => teamDemand?.pct?.overall != null)
}

// Hourly demand for a scope (scope key, area key, or array of area keys):
// the sum of each component area's series at the same target. Summing
// means is exact; summing percentiles is an approximation (the p90 of a sum
// is not the sum of p90s) — it overstates combined demand slightly, which is
// the conservative direction for staffing.
export function getScopeDemandSeries(demand, scope, day, target = 'mean') {
  const total = Array(24).fill(0)
  for (const area of scopeAreas(scope)) {
    const series = getDemandSeries(demand, AREA_LABEL[area], day, target)
    for (let h = 0; h < 24; h++) total[h] += series[h] ?? 0
  }
  return total
}
