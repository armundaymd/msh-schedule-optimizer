// Is the attending allocation sensitive to the (uncertain) ERU cross-cover
// throughput-credit assumption? Whole ED, today's 624 attending h/week.
//   npm run analyze:crosscover
// Writes analysis/reports/cross-cover-sensitivity.md (+ .json).
//
// Credit assumptions (shared/operationalCoverage.js crossCoverCredit):
//   A  CONSERVATIVE   no throughput credit
//   B  CURRENT_RATIO  headroom × 0.8/2.1 (the earlier, unvalidated behaviour)
//   C  CUSTOM         illustrative midpoint: half of ERU resident/PA capacity
//                     eligible, same headroom factor as B
// Structural settings (each solved under A, B and C):
//   keep — current ERU dedicated coverage kept as a hard rule; Main
//          cross-covers the rest (ERU hours are then fixed by the rule)
//   flex — ERU dedicated coverage left to the optimizer; Main cross-covers
//          whenever ERU has no attending (shows whether ERU allocation moves)
// Both: Main ≥ 1 attending 24/7, FastTrack closed 01:00–07:00, ERU ≤ 1 attending at a time.
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { scopeAreas } from '../src/shared/areas'
import { teamArea } from '../src/shared/capacity'
import {
  CROSS_COVER_CREDIT, DEFAULT_OPERATIONAL_COVERAGE, cloneCoverageConfig, operationalCoverageSummary, withCrossCoverCredit,
} from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { applyPlanResult, buildPlanInstance } from '../src/shared/staffingPlan'
import { compareStructures, planStructure } from '../src/shared/sensitivity'
import { planPatterns } from '../src/v3/utils/patterns'
import { scheduleMetrics } from '../validation/compare'
import { loadCurrentSchedule, loadDemand } from './realData'
import { solveInstance, solverAvailable } from './solver'
import { relaxRequirements } from './coverageConfigs'
import { renderCrossCoverReport } from './crossCoverSensitivityReport'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const solver = solverAvailable()

export const CREDIT_ASSUMPTIONS = [
  { key: 'A', label: 'A · Conservative (no credit)', credit: { mode: CROSS_COVER_CREDIT.CONSERVATIVE } },
  { key: 'B', label: 'B · Ceiling ratio 0.8/2.1 (unvalidated)', credit: { mode: CROSS_COVER_CREDIT.CURRENT_RATIO } },
  { key: 'C', label: 'C · Illustrative midpoint', credit: { mode: CROSS_COVER_CREDIT.CUSTOM, residentCreditFraction: 0.5, headroomFactor: DEFAULT_PPH.eru / DEFAULT_PPH.main } },
]

describe('cross-cover credit sensitivity (real data)', () => {
  it.skipIf(!solver.ok)('writes the report', () => {
    const demand = loadDemand()
    const current = loadCurrentSchedule()
    const currentFor = d => current.filter(s => s.day === d)
    const scope = 'wholeEd'
    const areas = scopeAreas(scope)
    const pph = DEFAULT_PPH
    const target = 'mean'
    const patterns = planPatterns('current', [8, 10, 12])
    const budget = DAYS.reduce((t, d) => t + currentFor(d)
      .filter(s => s.role_type === 'Attending' && areas.includes(teamArea(s.team, [])))
      .reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0)

    const base = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    const structures = {
      keep: { label: 'Current ERU dedicated coverage kept (hard rule)', config: base },
      flex: { label: 'ERU dedicated coverage left to the optimizer', config: relaxRequirements(base, ['eru']) },
    }
    const ctx = { days: DAYS, demand, pph, scope, target }

    function score(schedule, config) {
      const metrics = scheduleMetrics({ ...ctx, coverage: config }, schedule)
      const op = operationalCoverageSummary({ week: metrics.week, days: DAYS, shiftsForDay: schedule.shiftsForDay, customTeams: schedule.customTeams })
      return { metrics, op }
    }

    function plan(config, effort) {
      const { instance, context } = buildPlanInstance({
        days: DAYS, shiftsForDay: currentFor, customTeams: [], pph, demand, target, scope,
        patterns, weeklyBudgetHours: budget, effort, coverage: config,
      })
      const result = solveInstance(instance)
      if (!result.hours) throw new Error(`${result.status}: ${result.message}`)
      expect(result.hours.total).toBeLessThanOrEqual(budget + 1e-9)
      const { proposedByDay, newTeams, plannedByDay } = applyPlanResult(result, context, [])
      const schedule = { shiftsForDay: d => proposedByDay[d], customTeams: newTeams, plannedByDay }
      return {
        ...schedule, solver: { status: result.status, gap: result.stats.relativeGap, effort },
        structure: planStructure({ days: DAYS, shiftsForDay: schedule.shiftsForDay, customTeams: newTeams, scope }),
      }
    }

    const runs = []
    for (const [sKey, st] of Object.entries(structures)) {
      for (const a of CREDIT_ASSUMPTIONS) {
        const config = withCrossCoverCredit(st.config, a.credit)
        const std = plan(config, 'standard')
        const thr = plan(config, 'thorough')
        runs.push({
          structure: sKey, assumption: a.key, label: `${st.label} — ${a.label}`, config,
          plan: { ...std, ...score(std, config) },
          thorough: { ...thr, ...score(thr, config) },
        })
      }
    }

    // ERU never stacked, hard rules always met.
    for (const r of runs) {
      for (const p of [r.plan, r.thorough]) {
        for (const d of DAYS) for (const on of Object.values(p.structure.onDuty.eru[d])) expect(on).toBeLessThanOrEqual(1)
        if (r.structure === 'keep') expect(p.op.eru.requiredShortfallHours).toBe(0)
      }
    }

    // Structure changes: across assumptions (same structure, same effort),
    // and the search-noise baseline (same assumption, standard vs thorough).
    const byKey = (s, a) => runs.find(r => r.structure === s && r.assumption === a)
    const comparisons = []
    for (const s of Object.keys(structures)) {
      for (const [x, y] of [['A', 'B'], ['A', 'C'], ['B', 'C']]) {
        comparisons.push({ structure: s, pair: `${x} vs ${y}`, effort: 'standard', ...compareStructures(byKey(s, x).plan.structure, byKey(s, y).plan.structure) })
        comparisons.push({ structure: s, pair: `${x} vs ${y}`, effort: 'thorough', ...compareStructures(byKey(s, x).thorough.structure, byKey(s, y).thorough.structure) })
      }
      for (const a of CREDIT_ASSUMPTIONS) {
        comparisons.push({ structure: s, pair: `${a.key}: standard vs thorough`, effort: 'noise', ...compareStructures(byKey(s, a.key).plan.structure, byKey(s, a.key).thorough.structure) })
      }
    }

    // Every plan (thorough) scored under every assumption, with Main
    // cross-covering ERU whenever ERU has no attending.
    const current_ = { shiftsForDay: currentFor, customTeams: [], structure: planStructure({ days: DAYS, shiftsForDay: currentFor, scope }) }
    const crossScore = []
    const candidates = [{ label: 'Current schedule', schedule: current_ }, ...runs.map(r => ({ label: `${r.structure}/${r.assumption}`, schedule: r.thorough }))]
    for (const c of candidates) {
      crossScore.push({
        label: c.label,
        byAssumption: Object.fromEntries(CREDIT_ASSUMPTIONS.map(a => {
          const { metrics } = score(c.schedule, withCrossCoverCredit(structures.flex.config, a.credit))
          return [a.key, metrics.all.deficit]
        })),
      })
    }
    const currentByAssumption = Object.fromEntries(CREDIT_ASSUMPTIONS.map(a => [a.key, score(current_, withCrossCoverCredit(base, a.credit))]))

    const report = {
      when: new Date().toISOString(), budget, target, pph, structures, assumptions: CREDIT_ASSUMPTIONS,
      runs, comparisons, crossScore, current: { ...current_, byAssumption: currentByAssumption },
    }
    mkdirSync(path.join(HERE, 'reports'), { recursive: true })
    const out = path.join(HERE, 'reports', 'cross-cover-sensitivity')
    writeFileSync(`${out}.md`, renderCrossCoverReport(report))
    writeFileSync(`${out}.json`, JSON.stringify({
      when: report.when, budget, structures: Object.fromEntries(Object.entries(structures).map(([k, v]) => [k, v.label])),
      assumptions: CREDIT_ASSUMPTIONS,
      runs: runs.map(r => ({
        structure: r.structure, assumption: r.assumption,
        standard: { hoursByArea: r.plan.structure.hoursByArea, all: r.plan.metrics.all, byArea: r.plan.metrics.byArea, solver: r.plan.solver },
        thorough: { hoursByArea: r.thorough.structure.hoursByArea, all: r.thorough.metrics.all, byArea: r.thorough.metrics.byArea, solver: r.thorough.solver },
      })),
      comparisons, crossScore,
    }, null, 2))
  }, 1_800_000)
})
