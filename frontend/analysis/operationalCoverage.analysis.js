// Real-data comparison: current schedule vs the unconstrained attending
// allocator vs the operationally constrained allocator, Whole ED, today's
// attending hours. Everything except the operational coverage layer is held
// at the sensitivity study's baseline (Main ceiling 2.1, mean demand,
// current start times x 8/10/12 h, standard search).
//   npm run analyze:coverage
// Writes analysis/reports/operational-coverage.md (+ .json).
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AREA_LABEL, scopeAreas } from '../src/shared/areas'
import { teamArea } from '../src/shared/capacity'
import { getDemandSeries } from '../src/shared/demandSeries'
import {
  DEFAULT_OPERATIONAL_COVERAGE, cloneCoverageConfig, operationalCoverageSummary, requirementLabels,
} from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { applyPlanResult, buildPlanInstance } from '../src/shared/staffingPlan'
import { planStructure } from '../src/shared/sensitivity'
import { PLAN_START_MODES, planPatterns } from '../src/v3/utils/patterns'
import { scheduleMetrics } from '../validation/compare'
import { DEMAND_JSON, SCHEDULE_CSV, loadCurrentSchedule, loadDemand } from './realData'
import { describeSolver, solveInstance, solverAvailable } from './solver'
import { renderCoverageReport } from './operationalCoverageReport'
import { relaxRequirements } from './coverageConfigs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const solver = solverAvailable()

describe('operational coverage comparison (real data)', () => {
  it.skipIf(!solver.ok)('writes the report', () => {
    const demand = loadDemand()
    const current = loadCurrentSchedule()
    const currentFor = d => current.filter(s => s.day === d)
    const scope = 'wholeEd'
    const areas = scopeAreas(scope)
    const pph = DEFAULT_PPH
    const target = 'mean'
    const coverage = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    const patterns = planPatterns('current', [8, 10, 12])
    const budget = DAYS.reduce((t, d) => t + currentFor(d)
      .filter(s => s.role_type === 'Attending' && areas.includes(teamArea(s.team, [])))
      .reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0)

    function plan(label, cov, effort = 'standard') {
      const { instance, context } = buildPlanInstance({
        days: DAYS, shiftsForDay: currentFor, customTeams: [], pph, demand, target, scope,
        patterns, weeklyBudgetHours: budget, effort, coverage: cov,
      })
      const result = solveInstance(instance)
      if (!result.hours) throw new Error(`${label}: ${result.status} — ${result.message}`)
      expect(result.hours.total).toBeLessThanOrEqual(budget + 1e-9)
      const { proposedByDay, newTeams, plannedByDay } = applyPlanResult(result, context, [])
      return {
        label, shiftsForDay: d => proposedByDay[d], customTeams: newTeams, plannedByDay,
        solver: { status: result.status, gap: result.stats.relativeGap, seconds: result.stats.solveSeconds, hours: result.hours, effort },
      }
    }

    const eruFlexible = relaxRequirements(coverage, ['eru'])
    const schedules = [
      { key: 'current', label: 'Current schedule', shiftsForDay: currentFor, customTeams: [] },
      { key: 'unconstrained', ...plan('Unconstrained allocator', null) },
      { key: 'eruFlexible', ...plan('ERU dedicated hours left to the optimizer (Main cross-covers)', eruFlexible) },
      { key: 'constrained', ...plan('Operationally constrained allocator', coverage) },
    ]
    // Search sensitivity: the same two cross-coverage plans at 3x the search budget.
    const thorough = {
      constrained: plan('Constrained (thorough search)', coverage, 'thorough'),
      eruFlexible: plan('ERU flexible (thorough search)', eruFlexible, 'thorough'),
    }

    const ctx = { days: DAYS, demand, pph, scope, target }
    const score = s => {
      // Throughput: one capacity model for every schedule — Main
      // cross-covers ERU whenever ERU has no attending of its own.
      s.metrics = scheduleMetrics({ ...ctx, coverage: eruFlexible }, s)
      s.coverageUse = operationalCoverageSummary({ week: s.metrics.week, days: DAYS, shiftsForDay: s.shiftsForDay, customTeams: s.customTeams })
      // Compliance: the configured operational rules.
      const rules = scheduleMetrics({ ...ctx, coverage }, s)
      s.operational = operationalCoverageSummary({ week: rules.week, days: DAYS, shiftsForDay: s.shiftsForDay, customTeams: s.customTeams })
      // Legacy: no cross-coverage credit (as in the sensitivity report).
      s.legacy = scheduleMetrics(ctx, s)
      s.structure = planStructure({ days: DAYS, shiftsForDay: s.shiftsForDay, customTeams: s.customTeams, scope })
    }
    for (const s of schedules) score(s)
    for (const s of Object.values(thorough)) score(s)

    // Hard-rule check on the constrained plan: no hard rule is broken.
    const constrained = schedules.find(s => s.key === 'constrained')
    for (const a of areas) expect(constrained.operational[a].requiredShortfallHours).toBe(0)

    const observedDemand = Object.fromEntries(areas.map(a => {
      let weekly = 0
      for (const day of DAYS) weekly += getDemandSeries(demand, AREA_LABEL[a], day, target).reduce((x, y) => x + y, 0)
      return [a, weekly]
    }))
    const report = {
      when: new Date().toISOString(), scope, budget, target,
      menu: `${PLAN_START_MODES.current.label.toLowerCase()} (${PLAN_START_MODES.current.starts.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}) × 8/10/12 h`,
      coverage, eruFlexible, thorough, requirements: Object.fromEntries(areas.map(a => [a, requirementLabels(coverage, a)])),
      observed: { sources: [SCHEDULE_CSV, DEMAND_JSON], nDays: demand.Main?.n_days ?? null, demand: observedDemand, shiftCount: current.length },
      assumptions: { pph, solver: describeSolver() },
      schedules,
    }
    mkdirSync(path.join(HERE, 'reports'), { recursive: true })
    const out = path.join(HERE, 'reports', 'operational-coverage')
    writeFileSync(`${out}.md`, renderCoverageReport(report))
    writeFileSync(`${out}.json`, JSON.stringify({
      when: report.when, scope, budget, target, coverage,
      schedules: schedules.map(s => ({
        key: s.key, label: s.label, solver: s.solver ?? null,
        hoursByArea: s.structure.hoursByArea, all: s.metrics.all, byArea: s.metrics.byArea,
        legacy: { all: s.legacy.all, byArea: s.legacy.byArea }, operational: s.operational, coverageUse: s.coverageUse,
        worst: s.metrics.periods.slice(0, 8),
      })),
    }, null, 2))
    console.log(`\nOperational coverage report: ${out}.md`)
  }, 900_000)
})
