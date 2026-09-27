// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { scopeAreas } from './areas'
import { shiftCoversHour, teamArea } from './capacity'
import { coverageGrid, groupRuns } from './coverageInsights'
import { analyzeWeek } from './weekCoverage'

// Sensitivity analysis around the attending resource allocator: re-run the
// same allocation with one assumption changed, then compare what the plans
// recommend and how each would fare if a different assumption were true.
// Pure functions only — running the solver is the caller's job
// (frontend/analysis/). Nothing here changes a configured default.

// Each parameter: how to apply one tested value to the model inputs
// ({ pph, target }) and the values to test by default. Values are
// "reasonable nearby" alternatives, not a combinatorial sweep.
const RESIDENT_KEYS = ['pgy1', 'pgy2', 'pgy3', 'pgy4', 'offService']
const PA_KEYS = ['pa', 'fasttrackPa', 'fasttrackPaWithAttending']
const scaleKeys = (pph, keys, m) => ({ ...pph, ...Object.fromEntries(keys.filter(k => pph[k] != null).map(k => [k, pph[k] * m])) })
// A ceiling can't be below solo throughput (the PPH sliders enforce the same).
const setCeiling = (pph, area, v) => ({ ...pph, [area]: v, [`${area}Own`]: Math.min(pph[`${area}Own`] ?? v, v) })

export const SENSITIVITY_PARAMETERS = {
  mainCeiling: {
    label: 'Main attending supervision ceiling', short: 'Main PPH', keys: ['main'], unit: 'patients/hr per attending',
    values: [1.9, 2.0, 2.1, 2.2, 2.3], format: v => v.toFixed(1),
    baseline: inputs => inputs.pph.main,
    apply: (inputs, v) => ({ ...inputs, pph: setCeiling(inputs.pph, 'main', v) }),
  },
  fasttrackCeiling: {
    label: 'Fast Track attending supervision ceiling', short: 'Fast Track PPH', keys: ['fasttrack'], unit: 'patients/hr per attending',
    values: [3.1, 3.3, 3.5, 3.7, 3.9], format: v => v.toFixed(1),
    baseline: inputs => inputs.pph.fasttrack,
    apply: (inputs, v) => ({ ...inputs, pph: setCeiling(inputs.pph, 'fasttrack', v) }),
  },
  eruCeiling: {
    label: 'ERU attending supervision ceiling', short: 'ERU PPH', keys: ['eru'], unit: 'patients/hr per attending',
    values: [0.6, 0.7, 0.8, 0.9, 1.0], format: v => v.toFixed(1),
    baseline: inputs => inputs.pph.eru,
    apply: (inputs, v) => ({ ...inputs, pph: setCeiling(inputs.pph, 'eru', v) }),
  },
  residentProductivity: {
    label: 'Resident productivity (all levels)', short: 'Resident PPH', keys: RESIDENT_KEYS, unit: 'x current resident PPH',
    values: [0.8, 0.9, 1.0, 1.1, 1.2], format: v => `x${v.toFixed(1)}`,
    baseline: () => 1,
    apply: (inputs, v) => ({ ...inputs, pph: scaleKeys(inputs.pph, RESIDENT_KEYS, v) }),
  },
  paProductivity: {
    label: 'PA/extender productivity', short: 'PA PPH', keys: PA_KEYS, unit: 'x current PA PPH',
    values: [0.8, 0.9, 1.0, 1.1, 1.2], format: v => `x${v.toFixed(1)}`,
    baseline: () => 1,
    apply: (inputs, v) => ({ ...inputs, pph: scaleKeys(inputs.pph, PA_KEYS, v) }),
  },
  demandTarget: {
    label: 'Demand target', short: 'Target', keys: [], unit: 'hourly demand statistic',
    values: ['mean', 'p50', 'p75', 'p90'], format: v => v,
    baseline: inputs => inputs.target,
    apply: (inputs, v) => ({ ...inputs, target: v }),
  },
}

// A plan's attending structure, keyed by AREA (team names are arbitrary
// labels — "Plan Main 2" in one run is the same shift as "Red" in another).
export function planStructure({ days, shiftsForDay, customTeams = [], scope }) {
  const areas = scopeAreas(scope)
  const shifts = new Map() // `${area}|${day}|${startHour}|${lengthH}` -> count
  const onDuty = Object.fromEntries(areas.map(a => [a, Object.fromEntries(days.map(d => [d, Array(24).fill(0)]))]))
  const hoursByArea = Object.fromEntries(areas.map(a => [a, 0]))
  for (const day of days) {
    for (const s of shiftsForDay(day)) {
      if (s.role_type !== 'Attending') continue
      const area = teamArea(s.team, customTeams)
      if (!areas.includes(area)) continue
      const key = `${area}|${day}|${s.startMins / 60}|${(s.endMins - s.startMins) / 60}`
      shifts.set(key, (shifts.get(key) ?? 0) + 1)
      hoursByArea[area] += (s.endMins - s.startMins) / 60
      for (let h = 0; h < 24; h++) if (shiftCoversHour(s, h)) onDuty[area][day][h] += 1
    }
  }
  return { days, areas, shifts, onDuty, hoursByArea, totalHours: Object.values(hoursByArea).reduce((a, b) => a + b, 0) }
}

// A plan counts as MATERIALLY different from another when more than this
// share of its attending-hours sit at a different area/day/hour.
export const MATERIAL_CHANGE_SHARE = 0.1

export function compareStructures(a, b) {
  let shared = 0, union = 0
  for (const key of new Set([...a.shifts.keys(), ...b.shifts.keys()])) {
    const x = a.shifts.get(key) ?? 0, y = b.shifts.get(key) ?? 0
    shared += Math.min(x, y)
    union += Math.max(x, y)
  }
  // Attending-hours placed differently: half the L1 distance of the
  // on-duty profiles (an hour moved from 10:00 to 14:00 counts once).
  let l1 = 0
  for (const area of a.areas) for (const day of a.days) for (let h = 0; h < 24; h++) {
    l1 += Math.abs(a.onDuty[area][day][h] - (b.onDuty[area]?.[day]?.[h] ?? 0))
  }
  const movedHours = l1 / 2
  const movedShare = movedHours / Math.max(1, a.totalHours, b.totalHours)
  return {
    sharedShifts: shared,
    shiftJaccard: union ? shared / union : 1,
    movedHours, movedShare,
    material: movedShare > MATERIAL_CHANGE_SHARE,
  }
}

function runsFor(areas, days, test) {
  const out = []
  for (const area of areas) for (const day of days) {
    for (const run of groupRuns(h => (test(area, day, h) ? 'y' : null))) out.push({ area, day, hours: run.hours })
  }
  return out
}

// variants: [{ value, structure, week }] — week = analyzeWeek of that plan
//   under ITS OWN assumption.
// current: { structure, weeks: [analyzeWeek of the current schedule under
//   each variant's assumption, same order] }
export function robustness({ variants, current, stableShare = 0.8 }) {
  const { days, areas } = current.structure
  const n = variants.length
  const everyVariant = f => variants.every(f)

  const alwaysAdds = runsFor(areas, days, (a, d, h) =>
    everyVariant(v => v.structure.onDuty[a][d][h] > current.structure.onDuty[a][d][h]))
  const alwaysRemoves = runsFor(areas, days, (a, d, h) =>
    everyVariant(v => v.structure.onDuty[a][d][h] < current.structure.onDuty[a][d][h]))

  // Coverage status (deficit / adequate / excess) per week, day, area, hour.
  const grids = new Map()
  const statusOf = (week, a, d, h) => {
    if (!grids.has(week)) grids.set(week, Object.fromEntries(week.days.map(x => [x.day, coverageGrid(x.analysis)])))
    return grids.get(week)[d].byArea[a].status[h]
  }
  const currentShortEverywhere = runsFor(areas, days, (a, d, h) => current.weeks.every(w => statusOf(w, a, d, h) === 'deficit'))
  const currentExcessEverywhere = runsFor(areas, days, (a, d, h) => current.weeks.every(w => statusOf(w, a, d, h) === 'excess'))
  const planShortEverywhere = runsFor(areas, days, (a, d, h) => variants.every(v => statusOf(v.week, a, d, h) === 'deficit'))
  const planExcessEverywhere = runsFor(areas, days, (a, d, h) => variants.every(v => statusOf(v.week, a, d, h) === 'excess'))

  // Shifts (area, day, start, length) in every / most plans, with the
  // number of copies they have in common.
  const keys = new Set(variants.flatMap(v => [...v.structure.shifts.keys()]))
  const stableShifts = [], commonShifts = []
  for (const key of keys) {
    const counts = variants.map(v => v.structure.shifts.get(key) ?? 0)
    const present = counts.filter(c => c > 0).length
    const [area, day, start, length] = key.split('|')
    const item = { area, day, start: Number(start), length: Number(length), inPlans: present, copies: Math.min(...counts.filter(c => c > 0)) }
    if (present === n) stableShifts.push(item)
    else if (present / n >= stableShare) commonShifts.push(item)
  }

  // How much each area's total allocation swings across assumptions.
  const areaHourRange = Object.fromEntries(areas.map(a => {
    const hs = variants.map(v => v.structure.hoursByArea[a])
    return [a, { min: Math.min(...hs), max: Math.max(...hs), current: current.structure.hoursByArea[a] }]
  }))

  return { alwaysAdds, alwaysRemoves, currentShortEverywhere, currentExcessEverywhere, planShortEverywhere, planExcessEverywhere, stableShifts, commonShifts, areaHourRange }
}

// Unmet demand (summed per area, never pooled) and coverage of each
// schedule if each assumption were true. Rows: schedules; columns: assumptions.
export function crossEvaluate({ days, demand, scope, schedules, assumptions }) {
  return schedules.map(sch => assumptions.map(asm => {
    const week = analyzeWeek({ days, shiftsForDay: sch.shiftsForDay, demand, pph: asm.pph, customTeams: sch.customTeams, scope, target: asm.target })
    let d = 0, served = 0, unmet = 0
    for (const { analysis } of week.days) for (const row of analysis.hours) for (const a of week.areas) {
      const x = row.byArea[a]
      d += x.demand; served += Math.min(x.demand, x.capacity); unmet += Math.max(0, x.demand - x.capacity)
    }
    return { unmet, coveragePct: d > 0 ? (100 * served) / d : 100 }
  }))
}
