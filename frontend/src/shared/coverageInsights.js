// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { AREA_LABEL, SCOPE_LABEL } from './areas'

// Deterministic coverage classification and plain-language insights, derived
// purely from an analyzeScope() result (shared/scopeAnalysis.js). Nothing
// here computes capacity or demand — it only interprets the per-hour nets.
//
// Principle: good total coverage must not mask local understaffing. The
// aggregate of a combined scope is always reported alongside its areas, and
// an hour where the aggregate looks fine but an area is short is its own
// status ('masked') rather than 'adequate'.

// Hour statuses:
//   'deficit'  — demand > capacity (the same definition as every existing
//                overflow/deficit count in the app)
//   'adequate' — covered, without a meaningful surplus
//   'excess'   — surplus of at least EXCESS_MIN_PPH AND at least
//                EXCESS_MIN_FRACTION of demand (so 4.0 vs 3.0 is excess but
//                10.5 vs 9.5 is not). These thresholds are judgement calls,
//                not measurements — tune here.
//   'masked'   — aggregate rows only: the pooled total is not in deficit but
//                at least one component area is.
export const EXCESS_MIN_PPH = 1
export const EXCESS_MIN_FRACTION = 0.25

// DISPLAY tolerance — presentation only. Screens show values to 0.1 PPH, so
// a shortfall below 0.05 PPH reads as "0.0" and must not be coloured or
// listed as a deficit. Screens pass this as `deficitTolerance`; every
// default below is 0 (the raw rule: any demand > capacity is a deficit),
// which is what capacity maths, Auto-optimize, the staffing planner's
// metrics, the solver and the analysis reports keep using. Raw values stay
// in the hover text.
export const DISPLAY_DEFICIT_TOLERANCE_PPH = 0.05

// deficitTolerance 0: deficit whenever demand > capacity (raw).
// deficitTolerance > 0: deficit only when the shortfall is >= the tolerance;
// a smaller shortfall is shown as 'adequate' (covered).
export function classifyNet(demand, capacity, deficitTolerance = 0) {
  const shortfall = demand - capacity
  if (deficitTolerance > 0 ? shortfall >= deficitTolerance - 1e-12 : shortfall > 0) return 'deficit'
  const surplus = capacity - demand
  if (surplus >= EXCESS_MIN_PPH && surplus >= EXCESS_MIN_FRACTION * demand) return 'excess'
  return 'adequate'
}

// True when an hour is short in the raw maths but below the display tolerance.
export function isBelowDisplayTolerance(demand, capacity, deficitTolerance = DISPLAY_DEFICIT_TOLERANCE_PPH) {
  return demand > capacity && demand - capacity < deficitTolerance - 1e-12
}

// Areas short at an analyzeScope() hour row under `deficitTolerance`
// (0 = the row's own raw shortAreas).
export function shortAreasAt(row, areas, deficitTolerance = 0) {
  if (!(deficitTolerance > 0)) return row.shortAreas
  return areas.filter(a => classifyNet(row.byArea[a].demand, row.byArea[a].capacity, deficitTolerance) === 'deficit')
}

// Status of an analyzeScope() hour row's pooled total.
function aggregateStatus(row, areas, deficitTolerance = 0) {
  const status = classifyNet(row.demand, row.capacity, deficitTolerance)
  return status !== 'deficit' && shortAreasAt(row, areas, deficitTolerance).length > 0 ? 'masked' : status
}

// Per-hour status grid for rendering: one aggregate row plus one row per
// component area, each { net: number[24], status: string[24] }.
// Screens pass { deficitTolerance: DISPLAY_DEFICIT_TOLERANCE_PPH }.
export function coverageGrid(analysis, { deficitTolerance = 0 } = {}) {
  const aggregate = { net: [], status: [] }
  const byArea = Object.fromEntries(analysis.areas.map(a => [a, { net: [], status: [] }]))
  for (const row of analysis.hours) {
    aggregate.net.push(row.net)
    aggregate.status.push(aggregateStatus(row, analysis.areas, deficitTolerance))
    for (const area of analysis.areas) {
      const a = row.byArea[area]
      byArea[area].net.push(a.net)
      byArea[area].status.push(classifyNet(a.demand, a.capacity, deficitTolerance))
    }
  }
  return { aggregate, byArea }
}

// Hours short under `deficitTolerance`: any area (the count screens show as
// overflow / short hours) and per area.
export function deficitHours(analysis, { deficitTolerance = 0 } = {}) {
  const anyArea = []
  const byArea = Object.fromEntries(analysis.areas.map(a => [a, []]))
  for (const row of analysis.hours) {
    const short = shortAreasAt(row, analysis.areas, deficitTolerance)
    if (short.length) anyArea.push(row.hour)
    for (const a of short) byArea[a].push(row.hour)
  }
  return { anyArea, byArea }
}

// Aggregate + per-area values and statuses at one hour — the "Whole ED -3.4
// | Main -2.7 | ..." readout.
export function hourSnapshot(analysis, hour, { deficitTolerance = 0 } = {}) {
  const row = analysis.hours[hour]
  return {
    hour,
    aggregate: { net: row.net, status: aggregateStatus(row, analysis.areas, deficitTolerance) },
    areas: analysis.areas.map(area => ({
      area,
      net: row.byArea[area].net,
      status: classifyNet(row.byArea[area].demand, row.byArea[area].capacity, deficitTolerance),
    })),
  }
}

// The hour to show when nothing is hovered: the most-short hour (by the
// most-short component), or the first hour of the day if nothing is short.
export function worstHour(analysis) {
  let best = 0
  for (const row of analysis.hours) {
    if (row.limitingNet < analysis.hours[best].limitingNet) best = row.hour
  }
  return best
}

export function formatHour(h) {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`
}

export function formatPph(n) {
  const v = Math.abs(n) < 0.05 ? 0 : n
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`
}

// Group hours 0..23 into runs of consecutive hours sharing the same non-null
// key. Hours are circular (a day template wraps: overnight shifts cover the
// early-morning hours of the same day), so a run ending at 23 merges with
// one starting at 0. Returns [{ key, hours: [h...] }] with `hours` in order.
export function groupRuns(keyForHour) {
  const runs = []
  let current = null
  for (let h = 0; h < 24; h++) {
    const key = keyForHour(h)
    if (key == null) { current = null; continue }
    if (current && current.key === key) current.hours.push(h)
    else { current = { key, hours: [h] }; runs.push(current) }
  }
  if (runs.length > 1) {
    const first = runs[0], last = runs[runs.length - 1]
    if (first.hours[0] === 0 && last.hours[last.hours.length - 1] === 23 && first.key === last.key) {
      last.hours.push(...first.hours)
      runs.shift()
    }
  }
  return runs
}

// "at 18:00", "from 17:00–20:00" (end exclusive), or "all day".
export function formatRange(hours) {
  if (hours.length >= 24) return 'all day'
  if (hours.length === 1) return `at ${formatHour(hours[0])}`
  return `from ${formatHour(hours[0])}–${formatHour(hours[hours.length - 1] + 1)}`
}

function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function extremeHour(hours, netAt, pick) {
  return hours.reduce((best, h) => (pick(netAt(h), netAt(best)) ? h : best), hours[0])
}

const KIND_ORDER = { 'masked-deficit': 0, deficit: 1, 'aggregate-deficit': 2, excess: 3 }

// Actionable, deterministic insights for a scope. Each insight:
//   { id, kind, tone, area, areas, hours, startHour, endHour, peakHour, peakNet, message }
//   kind: 'deficit'           — one area is short (per area)
//         'masked-deficit'    — combined only: aggregate not short, but the
//                               listed areas are
//         'aggregate-deficit' — combined only: the pooled total is short
//         'excess'            — one area has excess capacity (per area)
//   tone: 'deficit' | 'masked' | 'excess' — for colouring only
// Sorted most-actionable first: masked deficits, area deficits, aggregate
// deficits, then excess; ties by start hour, then area order.
export function buildCoverageInsights(analysis, { deficitTolerance = 0 } = {}) {
  const { areas, hours: rows } = analysis
  const combined = areas.length > 1
  const scopeName = SCOPE_LABEL[analysis.scope] ?? areas.map(a => AREA_LABEL[a]).join(' + ')
  const grid = coverageGrid(analysis, { deficitTolerance })
  const shortAt = h => areas.filter(a => grid.byArea[a].status[h] === 'deficit')
  const insights = []

  function push(kind, tone, run, extra) {
    insights.push({
      id: `${kind}-${extra.area ?? extra.areas?.join('+') ?? 'all'}-${run.hours[0]}`,
      kind, tone,
      area: null, areas: [],
      hours: run.hours,
      startHour: run.hours[0],
      endHour: (run.hours[run.hours.length - 1] + 1) % 24,
      ...extra,
    })
  }

  areas.forEach(area => {
    const { net, status } = grid.byArea[area]
    const name = AREA_LABEL[area]
    for (const run of groupRuns(h => (status[h] === 'deficit' ? 'deficit' : null))) {
      const peakHour = extremeHour(run.hours, h => net[h], (a, b) => a < b)
      const peak = run.hours.length === 1
        ? `(${formatPph(net[peakHour])} PPH)`
        : `(worst ${formatPph(net[peakHour])} PPH at ${formatHour(peakHour)})`
      push('deficit', 'deficit', run, {
        area, areas: [area], peakHour, peakNet: net[peakHour],
        message: `${name} has a capacity deficit ${formatRange(run.hours)} ${peak}.`,
      })
    }
    for (const run of groupRuns(h => (status[h] === 'excess' ? 'excess' : null))) {
      const peakHour = extremeHour(run.hours, h => net[h], (a, b) => a > b)
      push('excess', 'excess', run, {
        area, areas: [area], peakHour, peakNet: net[peakHour],
        message: `${name} has excess capacity ${formatRange(run.hours)} (up to ${formatPph(net[peakHour])} PPH).`,
      })
    }
  })

  if (combined) {
    // Keyed by WHICH areas are short, so "Main short" and "Main + ERU short"
    // under an adequate total are reported as separate ranges.
    const maskedRuns = groupRuns(h => (grid.aggregate.status[h] === 'masked' ? shortAt(h).join('+') : null))
    for (const run of maskedRuns) {
      const shortAreas = run.key.split('+')
      const worstNetAt = h => Math.min(...shortAreas.map(a => rows[h].byArea[a].net))
      const peakHour = extremeHour(run.hours, worstNetAt, (a, b) => a < b)
      const names = shortAreas.map(a => AREA_LABEL[a])
      push('masked-deficit', 'masked', run, {
        areas: shortAreas, peakHour, peakNet: worstNetAt(peakHour),
        message: `${scopeName} aggregate coverage is adequate ${formatRange(run.hours)}, but ${joinNames(names)} ${names.length > 1 ? 'remain' : 'remains'} below demand.`,
      })
    }

    const { net } = grid.aggregate
    for (const run of groupRuns(h => (grid.aggregate.status[h] === 'deficit' ? 'deficit' : null))) {
      const peakHour = extremeHour(run.hours, h => net[h], (a, b) => a < b)
      const peak = run.hours.length === 1
        ? `(${formatPph(net[peakHour])} PPH)`
        : `(worst ${formatPph(net[peakHour])} PPH at ${formatHour(peakHour)})`
      push('aggregate-deficit', 'deficit', run, {
        areas: [...areas], peakHour, peakNet: net[peakHour],
        message: `${scopeName} aggregate is below demand ${formatRange(run.hours)} ${peak}.`,
      })
    }
  }

  return insights.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.startHour - b.startHour
    || areas.indexOf(a.areas[0]) - areas.indexOf(b.areas[0])
  )
}
