// ERU dedicated-coverage scenarios: each scenario FIXES when ERU has its own
// attending; the allocator places the REST of the same Whole ED budget.
//   npm run analyze:eru
// Writes analysis/reports/eru-coverage-scenarios.md (+ .json).
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AREA_LABEL, scopeAreas } from '../src/shared/areas'
import { teamArea } from '../src/shared/capacity'
import { getDemandSeries } from '../src/shared/demandSeries'
import {
  DEFAULT_OPERATIONAL_COVERAGE, ERU_SCENARIO_PRESETS, cloneCoverageConfig, dedicatedWindowFeasibility,
  operationalCoverageSummary, routedShifts, unroutedClosedAreaShifts, withEruDedicatedCoverage,
} from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { applyPlanResult, buildPlanInstance, capacityCrossCheck } from '../src/shared/staffingPlan'
import { planStructure } from '../src/shared/sensitivity'
import { planPatterns } from '../src/v3/utils/patterns'
import { scheduleMetrics } from '../validation/compare'
import { DEMAND_JSON, SCHEDULE_CSV, loadCurrentSchedule, loadDemand } from './realData'
import { describeSolver, solveInstance, solverAvailable } from './solver'
import { renderEruScenarioReport } from './eruCoverageScenariosReport'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const solver = solverAvailable()
const W = (fromHour, toHour) => ({ fromHour, toHour })
const WEEKEND_CURRENT = ERU_SCENARIO_PRESETS.current.weekend

// Main comparison: the four requested scenarios (presets in
// shared/operationalCoverage.js — editable there and in the planner).
export const MAIN_SCENARIOS = ['current', 'coreDaytime', 'extendedEvening', 'allDay']

// Marginal curve: coherent windows, weekday window extended step by step,
// weekend held at today's 11:00–19:00 except the 24/7 point. Edit freely.
export const CURVE_POINTS = [
  { key: 'none', label: 'No dedicated ERU (reference anchor only — not a proposed policy)', weekday: null, weekend: null },
  { key: 'wd0917', label: 'Weekdays 09–17', weekday: W(9, 17), weekend: WEEKEND_CURRENT },
  { key: 'coreDaytime', label: 'Core daytime: weekdays 09–19', weekday: W(9, 19), weekend: WEEKEND_CURRENT },
  { key: 'wd0921', label: 'Weekdays 09–21', weekday: W(9, 21), weekend: WEEKEND_CURRENT },
  { key: 'extendedEvening', label: 'Extended evening: weekdays 09–23', weekday: W(9, 23), weekend: WEEKEND_CURRENT },
  { key: 'wd0723', label: 'Weekdays 07–23 (same 16 h as current, earlier)', weekday: W(7, 23), weekend: WEEKEND_CURRENT },
  { key: 'current', label: 'Current: weekdays 09–01', weekday: W(9, 1), weekend: WEEKEND_CURRENT },
  { key: 'wd0905', label: 'Weekdays 09–05', weekday: W(9, 5), weekend: WEEKEND_CURRENT },
  { key: 'allDay', label: '24/7 (every day)', weekday: W(0, 0), weekend: W(0, 0) },
]

describe('ERU coverage scenarios (real data)', () => {
  it.skipIf(!solver.ok)('writes the report', () => {
    const demand = loadDemand()
    const current = loadCurrentSchedule()
    const currentFor = d => current.filter(s => s.day === d)
    const scope = 'wholeEd'
    const areas = scopeAreas(scope)
    const pph = DEFAULT_PPH
    const target = 'mean'
    const patterns = planPatterns('current', [8, 10, 12])
    const budget = 624
    const base = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    const ctx = { days: DAYS, demand, pph, scope, target }

    const score = (schedule, config) => {
      const metrics = scheduleMetrics({ ...ctx, coverage: config }, schedule)
      const op = operationalCoverageSummary({ week: metrics.week, days: DAYS, shiftsForDay: schedule.shiftsForDay, customTeams: schedule.customTeams })
      return { metrics, op, structure: planStructure({ days: DAYS, shiftsForDay: schedule.shiftsForDay, customTeams: schedule.customTeams, scope }) }
    }

    function solve(config, effort) {
      const { instance, context } = buildPlanInstance({
        days: DAYS, shiftsForDay: currentFor, customTeams: [], pph, demand, target, scope, patterns,
        weeklyBudgetHours: budget, effort, coverage: config,
      })
      const result = solveInstance(instance)
      if (!result.hours) return { infeasible: true, status: result.status, message: result.message }
      const { proposedByDay, newTeams, plannedByDay } = applyPlanResult(result, context, [])
      const schedule = { shiftsForDay: d => proposedByDay[d], customTeams: newTeams, plannedByDay }
      const s = score(schedule, config)
      return {
        ...schedule, ...s, hours: result.hours,
        solver: { status: result.status, gap: result.stats.relativeGap, seconds: result.stats.solveSeconds, effort },
        crossCheck: capacityCrossCheck(result, s.metrics.week),
      }
    }

    const cache = {}
    function point(p) {
      if (cache[p.key]) return cache[p.key]
      const preset = ERU_SCENARIO_PRESETS[p.key]
      const config = withEruDedicatedCoverage(base, { weekday: p.weekday, weekend: p.weekend, name: preset?.short ?? p.label, basis: p.key === 'current' ? 'current-schedule' : 'scenario' })
      const fit = dedicatedWindowFeasibility(config, 'eru', DAYS, patterns)
      const out = { ...p, preset, config, fit }
      if (fit && !fit.feasible) {
        out.infeasible = true
        // Confirm the solver refuses it too (never silently violates).
        const r = solve(config, 'quick')
        out.solverRefused = !!r.infeasible
        out.solverMessage = r.message
      } else {
        out.standard = solve(config, 'standard')
        out.thorough = solve(config, 'thorough')
      }
      cache[p.key] = out
      return out
    }

    const scenarios = MAIN_SCENARIOS.map(k => point(CURVE_POINTS.find(p => p.key === k)))
    const curve = CURVE_POINTS.map(point)

    // Invariants on every feasible plan.
    const nonAtt = f => DAYS.flatMap(d => f(d).filter(s => s.role_type !== 'Attending').map(s => `${d}|${s.team}|${s.role_detail}|${s.startMins}|${s.endMins}`)).sort()
    for (const p of curve.filter(x => !x.infeasible)) {
      for (const r of [p.standard, p.thorough]) {
        expect(r.infeasible).toBeFalsy()
        expect(r.hours.total).toBeLessThanOrEqual(budget + 1e-9)
        for (const d of DAYS) for (const on of r.structure.onDuty.eru[d]) expect(on).toBeLessThanOrEqual(1)
        for (const a of areas) expect(r.op[a].requiredShortfallHours).toBe(0)
        expect(nonAtt(r.shiftsForDay)).toEqual(nonAtt(currentFor))
        expect(r.crossCheck).toBeLessThan(0.02)
      }
    }

    // Staff routing: what it changes on today's schedule.
    const noRouting = cloneCoverageConfig(base); delete noRouting.staffRouting
    const cur = { shiftsForDay: currentFor, customTeams: [] }
    const routing = {
      rules: base.staffRouting,
      routed: routedShifts(base, DAYS, currentFor),
      unroutedWith: unroutedClosedAreaShifts(base, DAYS, currentFor),
      unroutedWithout: unroutedClosedAreaShifts(noRouting, DAYS, currentFor),
      currentWith: score(cur, base),
      currentWithout: score(cur, noRouting),
      // Current-coverage plan re-solved without routing (thorough), for robustness.
      planWithout: solve(withEruDedicatedCoverage(noRouting, { weekday: W(9, 1), weekend: WEEKEND_CURRENT, name: 'Current', basis: 'current-schedule' }), 'thorough'),
    }

    const observed = {
      sources: [SCHEDULE_CSV, DEMAND_JSON], nDays: demand.Main?.n_days ?? null,
      demand: Object.fromEntries(areas.map(a => [a, DAYS.reduce((t, d) => t + getDemandSeries(demand, AREA_LABEL[a], d, target).reduce((x, y) => x + y, 0), 0)])),
      attendingHours: Object.fromEntries(areas.map(a => [a, DAYS.reduce((t, d) => t + currentFor(d).filter(s => s.role_type === 'Attending' && teamArea(s.team, []) === a).reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0)])),
      byRole: current.reduce((m, s) => ({ ...m, [s.role_type]: (m[s.role_type] ?? 0) + 1 }), {}),
    }
    const report = {
      when: new Date().toISOString(), budget, target, pph, base, patterns, scenarios, curve, routing, observed,
      currentScored: routing.currentWith, solverInfo: describeSolver(),
    }
    mkdirSync(path.join(HERE, 'reports'), { recursive: true })
    const out = path.join(HERE, 'reports', 'eru-coverage-scenarios')
    writeFileSync(`${out}.md`, renderEruScenarioReport(report))
    const brief = r => (r && !r.infeasible ? {
      hoursByArea: r.structure.hoursByArea, all: r.metrics.all, byArea: r.metrics.byArea, solver: r.solver,
      eru: { dedicated: r.op.eru.hoursDedicated, crossCovered: r.op.eru.hoursCrossCovered },
    } : null)
    writeFileSync(`${out}.json`, JSON.stringify({
      when: report.when, budget, target,
      points: curve.map(p => ({ key: p.key, label: p.label, weekday: p.weekday, weekend: p.weekend, infeasible: !!p.infeasible, minEruHours: p.fit?.minHours ?? null, standard: brief(p.standard), thorough: brief(p.thorough) })),
    }, null, 2))
  }, 3_600_000)
})
