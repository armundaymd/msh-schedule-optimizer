// One-parameter sensitivity sweep of the attending resource allocator on the
// committed real data. Everything except the swept parameter is held fixed.
//   npm run analyze:sensitivity                          (Main ceiling 1.9-2.3)
//   SENS_PARAM=eruCeiling npm run analyze:sensitivity
//   SENS_PARAM=demandTarget SENS_VALUES=mean,p75 npm run analyze:sensitivity
// Writes analysis/reports/sensitivity-<param>.md (+ .json).
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { scopeAreas } from '../src/shared/areas'
import { teamArea } from '../src/shared/capacity'
import { getDemandSeries } from '../src/shared/demandSeries'
import { DEFAULT_PPH } from '../src/shared/pph'
import { SENSITIVITY_PARAMETERS, compareStructures, crossEvaluate, planStructure, robustness } from '../src/shared/sensitivity'
import { AREA_LABEL } from '../src/shared/areas'
import { applyPlanResult, buildPlanInstance } from '../src/shared/staffingPlan'
import { analyzeWeek } from '../src/shared/weekCoverage'
import { PLAN_START_MODES, planPatterns } from '../src/v3/utils/patterns'
import { scheduleMetrics, unattendedHours } from '../validation/compare'
import { DEMAND_JSON, SCHEDULE_CSV, loadCurrentSchedule, loadDemand } from './realData'
import { describeSolver, solveInstance, solverAvailable } from './solver'
import { renderSensitivityReport } from './sensitivityReport'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const PARAM_KEY = process.env.SENS_PARAM ?? 'mainCeiling'
const param = SENSITIVITY_PARAMETERS[PARAM_KEY]

function parseValues() {
  if (!process.env.SENS_VALUES) return param.values
  return process.env.SENS_VALUES.split(',').map(x => (PARAM_KEY === 'demandTarget' ? x.trim() : Number(x)))
}

const solver = solverAvailable()

describe(`sensitivity: ${PARAM_KEY}`, () => {
  it.skipIf(!param || !solver.ok)('runs the sweep and writes the report', () => {
    const demand = loadDemand()
    const current = loadCurrentSchedule()
    const currentFor = d => current.filter(s => s.day === d)
    const scope = 'wholeEd'
    const areas = scopeAreas(scope)
    const base = { pph: DEFAULT_PPH, target: 'mean' }
    const fixed = {
      scope, target: base.target, effort: 'standard',
      patterns: planPatterns('current', [8, 10, 12]),
      menu: `${PLAN_START_MODES.current.label.toLowerCase()} (${PLAN_START_MODES.current.starts.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}) × 8/10/12 h`,
      budget: DAYS.reduce((t, d) => t + currentFor(d)
        .filter(s => s.role_type === 'Attending' && areas.includes(teamArea(s.team, [])))
        .reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0),
    }
    const values = parseValues()
    const baselineValue = param.baseline(base)

    const variants = values.map(value => {
      const inputs = param.apply(base, value)
      const { instance, context } = buildPlanInstance({
        days: DAYS, shiftsForDay: currentFor, customTeams: [], pph: inputs.pph, demand, target: inputs.target, scope,
        patterns: fixed.patterns, weeklyBudgetHours: fixed.budget, effort: fixed.effort,
      })
      const result = solveInstance(instance)
      if (!result.hours) throw new Error(`${param.short} ${value}: solver ${result.status} — ${result.message}`)
      expect(result.hours.total).toBeLessThanOrEqual(fixed.budget + 1e-9)
      const { proposedByDay, newTeams } = applyPlanResult(result, context, [])
      const plan = { label: `Plan @ ${value}`, shiftsForDay: d => proposedByDay[d], customTeams: newTeams }
      const ctx = { days: DAYS, demand, pph: inputs.pph, scope, target: inputs.target }
      return {
        value, label: param.format(value), isBaseline: value === baselineValue, inputs, plan,
        metrics: scheduleMetrics(ctx, plan),
        unattended: unattendedHours(ctx, plan),
        structure: planStructure({ days: DAYS, shiftsForDay: plan.shiftsForDay, customTeams: newTeams, scope }),
        week: analyzeWeek({ days: DAYS, shiftsForDay: plan.shiftsForDay, demand, pph: inputs.pph, customTeams: newTeams, scope, target: inputs.target }),
        solver: { status: result.status, gap: result.stats.relativeGap, seconds: result.stats.solveSeconds },
      }
    })

    const baseVariant = variants.find(v => v.isBaseline) ?? variants[0]
    for (const v of variants) {
      v.vsBaseline = compareStructures(baseVariant.structure, v.structure)
      v.shiftCount = [...v.structure.shifts.values()].reduce((a, b) => a + b, 0)
    }

    const cur = { label: 'Today', shiftsForDay: currentFor, customTeams: [] }
    const currentStructure = planStructure({ days: DAYS, shiftsForDay: currentFor, scope })
    const currentWeeks = variants.map(v => analyzeWeek({ days: DAYS, shiftsForDay: currentFor, demand, pph: v.inputs.pph, scope, target: v.inputs.target }))
    const currentMetrics = variants.map(v => scheduleMetrics({ days: DAYS, demand, pph: v.inputs.pph, scope, target: v.inputs.target }, cur))

    const robust = robustness({ variants, current: { structure: currentStructure, weeks: currentWeeks } })
    const cross = crossEvaluate({
      days: DAYS, demand, scope,
      schedules: [cur, ...variants.map(v => v.plan)],
      assumptions: variants.map(v => v.inputs),
    })

    // Observed inputs, straight from the data.
    const observedDemand = Object.fromEntries(areas.map(a => {
      let weekly = 0, peak = { v: -1 }, low = { v: Infinity }
      for (const day of DAYS) getDemandSeries(demand, AREA_LABEL[a], day, base.target).forEach((v, h) => {
        weekly += v
        if (v > peak.v) peak = { v, h, day }
        if (v < low.v) low = { v, h, day }
      })
      return [a, { weekly, peak, low }]
    }))
    const byRole = current.reduce((m, s) => ({ ...m, [s.role_type]: (m[s.role_type] ?? 0) + 1 }), {})
    const attendingHours = Object.fromEntries(areas.map(a => [a, currentStructure.hoursByArea[a]]))

    const report = {
      when: new Date().toISOString(), param: { ...param, key: PARAM_KEY }, fixed, variants,
      current: { metricsByVariant: currentMetrics }, robust, cross,
      observed: {
        sources: [SCHEDULE_CSV, DEMAND_JSON], target: base.target, nDays: demand.Main?.n_days ?? null,
        demand: observedDemand, shiftCount: current.length, byRole, attendingHours,
        attendingTotal: Object.values(attendingHours).reduce((a, b) => a + b, 0),
      },
      assumptions: { pph: baseVariant.inputs.pph, solver: describeSolver() },
    }
    // The configured default must be untouched by the sweep.
    expect(DEFAULT_PPH).toEqual(base.pph)

    mkdirSync(path.join(HERE, 'reports'), { recursive: true })
    const out = path.join(HERE, 'reports', `sensitivity-${PARAM_KEY}`)
    writeFileSync(`${out}.md`, renderSensitivityReport(report))
    writeFileSync(`${out}.json`, JSON.stringify({
      param: PARAM_KEY, fixed: { ...fixed, patterns: undefined }, when: report.when,
      variants: variants.map(v => ({
        value: v.value, solver: v.solver, vsBaseline: v.vsBaseline, unattended: v.unattended,
        hoursByArea: v.structure.hoursByArea, byArea: v.metrics.byArea, all: v.metrics.all,
      })),
      cross,
    }, null, 2))
    console.log(`\nSensitivity report: ${out}.md`)
  }, 600_000)

  it.skipIf(!!param)(`unknown SENS_PARAM "${PARAM_KEY}"`, () => {
    throw new Error(`Unknown SENS_PARAM "${PARAM_KEY}". Options: ${Object.keys(SENSITIVITY_PARAMETERS).join(', ')}`)
  })
})
