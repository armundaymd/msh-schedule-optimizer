// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { AREA_LABEL, SCOPE_LABEL } from './areas'
import { analyzeScope } from './scopeAnalysis'
import { coverageGrid, classifyNet, groupRuns, formatRange, shortAreasAt } from './coverageInsights'

// Week-level coverage: analyzeScope() run once per day, plus the per-cell,
// per-hour, and per-day summaries a weekly heatmap needs. No capacity or
// demand maths lives here — every number comes from analyzeScope(), and
// every status from coverageInsights.js.
//
// A "layer" picks which numbers a cell reports:
//   'all'  — the scope as a whole: the aggregate net, with the aggregate
//            status ('masked' when the total is covered but an area is short)
//   <area> — one component area of the scope, e.g. 'main'
// For a single-area scope the two are identical.

// A cell counts as short when its layer status is 'deficit' or 'masked' —
// local understaffing counts even where the total looks covered.
export function isShortStatus(status) {
  return status === 'deficit' || status === 'masked'
}

// days: ordered day names; shiftsForDay(day) -> that day's shifts.
// deficitTolerance: 0 (raw, default) for metrics; screens pass the DISPLAY
// tolerance (coverageInsights.js DISPLAY_DEFICIT_TOLERANCE_PPH) so a
// shortfall that rounds to 0.0 PPH is not shown as short.
export function analyzeWeek({ days, shiftsForDay, demand, pph, customTeams = [], scope, target = 'mean', coverage = null, deficitTolerance = 0 }) {
  const perDay = days.map(day => {
    const analysis = analyzeScope({ shifts: shiftsForDay(day), demand, pph, customTeams, scope, day, target, coverage })
    return { day, analysis, grid: coverageGrid(analysis, { deficitTolerance }) }
  })
  return { scope, areas: perDay[0]?.analysis.areas ?? [], days: perDay, coverage, deficitTolerance }
}

// The same week re-classified under another deficit tolerance (e.g. the
// DISPLAY tolerance for a week built raw by schedulePlanMetrics). Nets and
// demand/capacity are untouched; only statuses change.
export function withDeficitTolerance(week, deficitTolerance) {
  return { ...week, deficitTolerance, days: week.days.map(d => ({ ...d, grid: coverageGrid(d.analysis, { deficitTolerance }) })) }
}

// Everything about one day/hour cell, for colour, tooltip, and aria-label.
export function weekCell(week, dayIndex, hour, layer = 'all') {
  const { day, analysis, grid } = week.days[dayIndex]
  const row = analysis.hours[hour]
  const areas = analysis.areas.map(area => ({
    area,
    demand: row.byArea[area].demand,
    capacity: row.byArea[area].capacity,
    net: row.byArea[area].net,
    status: grid.byArea[area].status[hour],
  }))
  if (layer === 'all') {
    return {
      day, hour, layer,
      demand: row.demand, capacity: row.capacity, net: row.net,
      status: grid.aggregate.status[hour],
      shortAreas: shortAreasAt(row, analysis.areas, week.deficitTolerance ?? 0), areas,
    }
  }
  const a = row.byArea[layer]
  return {
    day, hour, layer,
    demand: a.demand, capacity: a.capacity, net: a.net,
    status: classifyNet(a.demand, a.capacity, week.deficitTolerance ?? 0),
    shortAreas: grid.byArea[layer].status[hour] === 'deficit' ? [layer] : [],
    areas,
  }
}

// Per hour of day: on how many of the week's days that hour is short / has
// excess, in the given layer. Answers "consistently understaffed when?".
export function weekHourSummary(week, layer = 'all') {
  return Array.from({ length: 24 }, (_, hour) => {
    let shortDays = 0, excessDays = 0
    week.days.forEach((_, i) => {
      const { status } = weekCell(week, i, hour, layer)
      if (isShortStatus(status)) shortDays++
      else if (status === 'excess') excessDays++
    })
    return { hour, shortDays, excessDays }
  })
}

// Per day: how many hours are short / have excess, in the given layer.
export function weekDaySummary(week, layer = 'all') {
  return week.days.map((d, i) => {
    let shortHours = 0, excessHours = 0
    for (let h = 0; h < 24; h++) {
      const { status } = weekCell(week, i, h, layer)
      if (isShortStatus(status)) shortHours++
      else if (status === 'excess') excessHours++
    }
    return { day: d.day, shortHours, excessHours }
  })
}

// Hour ranges that are short (or have excess) on at least `minDays` of the
// week's days, merged into ranges like coverageInsights' daily insights.
// Short patterns name the areas driving them, by how many day-hours in the
// range each area was short.
// Returns [{ kind: 'short' | 'excess', hours, startHour, endHour,
//            minDays, maxDays, dayHours, areaCounts: [{ area, count }], message }]
// ordered short before excess, then by dayHours (how many day-hour cells
// the range covers) descending — the most significant range first.
export const CONSISTENT_MIN_DAYS = 4

export function consistentPatterns(week, { layer = 'all', minDays = CONSISTENT_MIN_DAYS } = {}) {
  const summary = weekHourSummary(week, layer)
  const n = week.days.length
  const name = layer === 'all' ? SCOPE_LABEL[week.scope] ?? week.areas.map(a => AREA_LABEL[a]).join(' + ') : AREA_LABEL[layer]
  const patterns = []

  function daysText(lo, hi) {
    return lo === hi ? `${lo} of ${n} days` : `${lo}–${hi} of ${n} days`
  }

  for (const kind of ['short', 'excess']) {
    const countOf = h => (kind === 'short' ? summary[h].shortDays : summary[h].excessDays)
    for (const run of groupRuns(h => (countOf(h) >= minDays ? kind : null))) {
      const counts = run.hours.map(countOf)
      const lo = Math.min(...counts), hi = Math.max(...counts)
      const areaCounts = []
      if (kind === 'short') {
        const areas = layer === 'all' ? week.areas : [layer]
        for (const area of areas) {
          let count = 0
          for (const h of run.hours) {
            week.days.forEach(d => { if (d.grid.byArea[area].status[h] === 'deficit') count++ })
          }
          if (count > 0) areaCounts.push({ area, count })
        }
        areaCounts.sort((a, b) => b.count - a.count)
      }
      const drivers = kind === 'short' && layer === 'all' && week.areas.length > 1 && areaCounts.length
        ? ` (short in ${areaCounts.map(a => `${AREA_LABEL[a.area]} ${a.count}×`).join(', ')})`
        : ''
      const what = kind === 'short' ? 'is short' : 'has excess capacity'
      patterns.push({
        kind, hours: run.hours,
        startHour: run.hours[0], endHour: (run.hours[run.hours.length - 1] + 1) % 24,
        minDays: lo, maxDays: hi, dayHours: counts.reduce((a, b) => a + b, 0), areaCounts,
        message: `${name} ${what} ${formatRange(run.hours)} on ${daysText(lo, hi)}${drivers}.`,
      })
    }
  }
  return patterns.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'short' ? -1 : 1) || b.dayHours - a.dayHours || a.startHour - b.startHour
  )
}
