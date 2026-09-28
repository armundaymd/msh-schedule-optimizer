// Attending resource frontier: how much ATTENDING coverage does this ED need
// under the configured demand, productivity and operational assumptions?
//   npm run analyze:frontier                 (solves everything, ~30–60 min)
//   RENDER_ONLY=1 npm run analyze:frontier   (re-renders the .md from the .json)
// Writes analysis/reports/attending-resource-frontier.md (+ .json).
//
// Residents/PAs are fixed inputs throughout; attending hours are the only
// decision variable. Every plan is scored with the app's model
// (shared/attendingPlanner.js summarizePlan -> analyzeWeek).
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AREA_LABEL, scopeAreas } from '../src/shared/areas'
import { attendingCountForTeam, teamArea } from '../src/shared/capacity'
import { getDemandSeries } from '../src/shared/demandSeries'
import {
  crossCoverApplies, DEFAULT_OPERATIONAL_COVERAGE, ERU_SCENARIO_PRESETS, attendingsInArea, dedicatedWindowFeasibility, describeCrossCoverCredit,
  effectiveShifts, eruScenarioConfig, operationalCoverageSummary, resolveCoverage,
} from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { DEFAULT_MAX_FLEX, buildPlanInstance, schedulePlanMetrics } from '../src/shared/staffingPlan'
import { frontierRows, planAndScore, runFrontier, summarizePlan } from '../src/shared/attendingPlanner'
import { hourlyPatterns } from '../src/shared/bottlenecks'
import { planPatterns } from '../src/v3/utils/patterns'
import { DEMAND_JSON, REPO_ROOT, SCHEDULE_CSV, loadCurrentSchedule, loadDemand } from './realData'
import { describeSolver, solveInstance, solverAvailable } from './solver'
import { renderFrontierReport } from './attendingResourceFrontierReport'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'reports', process.env.SMOKE ? '_smoke-frontier' : 'attending-resource-frontier')
// The previous run's results (copy the old .json here before re-running) — compared in the report.
const PREVIOUS = path.join(HERE, 'reports', 'attending-resource-frontier.previous.json')
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const renderOnly = !!process.env.RENDER_ONLY
const solver = renderOnly ? { ok: true } : solverAvailable()

// ── Analysis configuration (edit freely) ─────────────────────────────────────
export const CONFIG = {
  currentBudget: 624,
  frontier: { min: 500, max: 900, step: 25, include: [624] },
  // Coarser frontiers for the comparisons (shift structure, ERU policy).
  comparisonBudgets: [550, 600, 624, 650, 700, 750, 800, 850],
  targets: [90, 92.5, 95, 97.5, 99],
  maxUnmet: [100, 75, 50],
  areaTargetExamples: [
    { label: 'Overall ≥ 95%, Main ≥ 95%, FastTrack ≥ 92% (ERU by its policy)', targetCoveragePct: 95, areaTargets: { main: 95, fasttrack: 92 } },
  ],
  practicalTolerances: [0.5, 0.25, 1.0],   // first = primary
  eruPolicies: ['current', 'coreDaytime', 'allDay'],
  // FTE/cost translation for THIS REPORT ONLY — configured here, not a
  // clinical FTE definition or an institutional cost. Replace with local values.
  units: { clinicalHoursPerFteOptions: [1400, 1600, 1800], primaryFteHours: 1600, illustrativeRate: 250 },
  effort: { primary: 'thorough', robustness: 'standard' },
}
// SMOKE=1: a tiny, quick run to check the pipeline end to end.
if (process.env.SMOKE) {
  Object.assign(CONFIG, {
    frontier: { min: 600, max: 650, step: 25, include: [624] }, comparisonBudgets: [600, 650], targets: [95, 99], maxUnmet: [75],
    practicalTolerances: [0.5], effort: { primary: 'quick', robustness: 'quick' },
  })
}

describe('Attending resource frontier (real data)', () => {
  it.skipIf(!solver.ok)('writes the report', async () => {
    if (renderOnly) {
      if (!existsSync(`${OUT}.json`)) throw new Error('No saved results: run without RENDER_ONLY first.')
      writeFileSync(`${OUT}.md`, renderFrontierReport(JSON.parse(readFileSync(`${OUT}.json`, 'utf8'))))
      return
    }
    const demand = loadDemand()
    const current = loadCurrentSchedule()
    const currentFor = d => current.filter(s => s.day === d)
    const scope = 'wholeEd'
    const areas = scopeAreas(scope)
    const pph = DEFAULT_PPH
    const target = 'mean'
    const structures = { current: planPatterns('current', [8, 10, 12]), expanded: planPatterns('any', [8, 10, 12]) }
    const configs = Object.fromEntries(CONFIG.eruPolicies.map(k => [k, eruScenarioConfig(DEFAULT_OPERATIONAL_COVERAGE, k)]))
    const t0 = Date.now()
    const log = msg => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`)

    const nonAtt = f => DAYS.flatMap(d => f(d).filter(s => s.role_type !== 'Attending').map(s => `${d}|${s.team}|${s.role_detail}|${s.resident_level}|${s.startMins}|${s.endMins}`)).sort()
    const baselineNonAtt = nonAtt(currentFor)

    // fallback: a plan that is also valid here (e.g. the current-menu plan
    // under the expanded menu, which contains every current pattern). If the
    // bounded search does worse than it, the fallback is kept and flagged.
    // withoutSupervision: CONTROL solve with the resident-supervision rule
    // removed from the instance, to measure what the rule changes (never
    // used for any reported result other than that control).
    // withoutIntakeCutoffs: CONTROL solve with the intake cutoffs switched off.
    async function plan({ eru = 'current', structure = 'current', effort = CONFIG.effort.primary, inputs, budget = null, hint = [], fallback = null, withoutSupervision = false, withoutIntakeCutoffs = false }) {
      const coverage = withoutIntakeCutoffs ? { ...configs[eru], intakeCutoffs: { teams: [], extraTeamsHoursBeforeEnd: 0 } } : configs[eru]
      const p = await planAndScore({
        days: DAYS, shiftsForDay: currentFor, customTeams: [], pph, demand, target, scope, patterns: structures[structure],
        expandedPatterns: hourlyPatterns(structures[structure]), coverage, effort, inputs, weeklyBudgetHours: budget, hint,
        solve: inst => solveInstance(withoutSupervision ? stripSupervision(inst) : inst),
      })
      if (p.ok) check(p, coverage, budget, { supervision: !withoutSupervision })
      // Target / unmet / minimum-practical plans are minimum-hour solutions:
      // the plan uses exactly the hours the minimum-hours stage found.
      if (p.ok && ['target', 'maxUnmet', 'minPractical'].includes(inputs.planningMode)) {
        expect(Math.abs(p.result.hours.total - p.result.planning.hoursRequired)).toBeLessThan(1e-6)
        invariants.minimumHourPlans++
        if (p.result.planning.hoursProven) invariants.minimumHoursProven++
      }
      if (fallback?.ok && worseThan(p, fallback)) {
        return { ...fallback, fellBack: true, searchResult: p.ok ? { hours: p.result.hours.total, objective: p.result.stats?.objectiveValue, unmet: p.summary.all.unmet } : { status: p.result.status } }
      }
      return p
    }
    function worseThan(p, fb) {
      if (!p.ok) return true
      const cap = p.result.planning?.capsPph?.['*']
      if (cap != null && fb.result.objective.unmetPphHours > cap + 1e-9) return false   // fallback misses this run's cap
      if (p.result.planning?.hoursRequired != null) return p.result.hours.total > fb.result.hours.total + 1e-9
      return (p.result.stats?.objectiveValue ?? Infinity) > (fb.result.stats?.objectiveValue ?? Infinity) + 1e-6
    }
    // Invariants on every plan.
    function check(p, coverage, budget, { supervision = true } = {}) {
      if (budget != null) expect(p.result.hours.total).toBeLessThanOrEqual(budget + 1e-9)
      for (const d of DAYS) {
        for (let h = 0; h < 24; h++) {
          const eruOn = p.proposedFor(d).filter(s => s.role_type === 'Attending' && teamArea(s.team, p.newTeams) === 'eru' && coversHour(s, h)).length
          expect(eruOn).toBeLessThanOrEqual(1)
        }
      }
      const op = operationalCoverageSummary({ week: p.after.week, days: DAYS, shiftsForDay: p.proposedFor, customTeams: p.newTeams })
      for (const a of areas) expect(op[a].requiredShortfallHours).toBe(0)
      expect(nonAtt(p.proposedFor)).toEqual(baselineNonAtt)
      expect(p.crossCheck).toBeLessThan(0.02)
      // Resident supervision (hard): every resident operating on a team (after
      // routing) has that team's attending on — or, in an explicitly
      // cross-covered hour, the covering area has an attending on.
      const unsup = unsupervisedResidentHours(p, coverage)
      if (supervision) expect(unsup).toBe(0)
      // Demand is each area's own series (nothing moved or pooled).
      for (const a of p.instance.areas) {
        DAYS.forEach((d, di) => expect(a.demand[di]).toEqual(getDemandSeries(demand, AREA_LABEL[a.key], d, target).map(v => v ?? 0)))
      }
      // No pooling: overall unmet is the sum of each area's own unmet.
      expect(Math.abs(p.summary.all.unmet - Object.values(p.summary.byArea).reduce((t, m) => t + m.unmet, 0))).toBeLessThan(1e-6)
      if (supervision) invariants.plans++
      else invariants.controlUnsupervisedResidentHours = unsup
      p.op = op
      void coverage
    }

    const invariants = { plans: 0, minimumHourPlans: 0, minimumHoursProven: 0, frontierObjectiveIncreases: 0, frontierUnmetIncreases: [], controlUnsupervisedResidentHours: null }
    function unsupervisedResidentHours(p, coverage) {
      let n = 0
      for (const d of DAYS) {
        const list = p.proposedFor(d)
        for (let h = 0; h < 24; h++) {
          const on = coverage ? effectiveShifts(list, coverage, d, h) : list
          for (const team of new Set(on.filter(s => s.role_type === 'Resident' && coversHour(s, h)).map(s => s.team))) {
            const area = teamArea(team, p.newTeams)
            const rule = coverage ? resolveCoverage(coverage, area, d, h) : null
            if (rule && crossCoverApplies(rule, attendingsInArea(on, p.newTeams, area, h))) { if (attendingsInArea(on, p.newTeams, rule.coveredBy, h) < 1) n++; continue }
            if (attendingCountForTeam(on, team, h) < 1) n++
          }
        }
      }
      return n
    }
    function monotonic(points) {
      let prev = null
      for (const pt of points) {
        if (!pt.plan.ok) continue
        if (prev) {
          const obj = pt.plan.result.stats?.objectiveValue, pobj = prev.plan.result.stats?.objectiveValue
          if (obj > pobj + 1e-6) invariants.frontierObjectiveIncreases++
          expect(obj).toBeLessThanOrEqual(pobj + 1e-6)
          const du = pt.plan.summary.all.unmet - prev.plan.summary.all.unmet
          if (du > 1e-6) invariants.frontierUnmetIncreases.push({ from: prev.budget, to: pt.budget, increase: du })
        }
        prev = pt
      }
      return points
    }

    // Hard-rule floor: the fewest attending-hours the hard rules alone need,
    // with and without resident supervision (budget 0 → the infeasibility
    // diagnosis reports the requirement).
    const supervisionFloor = {}
    for (const [k, strip] of [['with', false], ['without', true]]) {
      const { instance } = buildPlanInstance({
        days: DAYS, shiftsForDay: currentFor, customTeams: [], pph, demand, target, scope, patterns: structures.current,
        coverage: configs.current, mode: 'budget', weeklyBudgetHours: 0, maxFlex: DEFAULT_MAX_FLEX, effort: 'thorough',
      })
      const r = solveInstance(strip ? stripSupervision(instance) : instance)
      supervisionFloor[k] = { requiredHours: r.diagnosis?.requiredHours ?? null, byArea: r.diagnosis?.byArea ?? null, message: r.message }
    }
    const supervisedTeamHours = (() => {
      const { instance } = buildPlanInstance({ days: DAYS, shiftsForDay: currentFor, customTeams: [], pph, demand, target, scope, patterns: structures.current, coverage: configs.current, mode: 'budget', weeklyBudgetHours: 624 })
      return Object.fromEntries(instance.areas.map(a => [a.key, a.slots.reduce((t, sl) => t + (sl.minAttendings ?? []).flat().reduce((x, v) => x + v, 0), 0)]))
    })()

    // ── Current schedule as recorded ─────────────────────────────────────────
    const curMetrics = schedulePlanMetrics({ days: DAYS, shiftsForDay: currentFor, customTeams: [], demand, pph, scope, target, coverage: configs.current })
    const currentScored = summarizePlan(curMetrics, currentFor, [])

    // ── A. Baseline 624, Current ERU ─────────────────────────────────────────
    log('baseline')
    const baseline = {
      thorough: await plan({ inputs: { planningMode: 'budget' }, budget: CONFIG.currentBudget }),
      standard: await plan({ inputs: { planningMode: 'budget' }, budget: CONFIG.currentBudget, effort: 'standard' }),
      // CONTROL: same solve without the resident-supervision rule.
      withoutSupervision: await plan({ inputs: { planningMode: 'budget' }, budget: CONFIG.currentBudget, withoutSupervision: true }),
      // CONTROL: same solve without the intake cutoffs (supervision on).
      withoutIntakeCutoffs: await plan({ inputs: { planningMode: 'budget' }, budget: CONFIG.currentBudget, withoutIntakeCutoffs: true }),
    }

    // ── B. Frontier (primary + robustness) ───────────────────────────────────
    const budgets = frontierList(CONFIG.frontier)
    async function frontier(opts, list, fallbackAt = null) {
      return runFrontier({
        budgets: list,
        solveAt: (budget, hint) => {
          const fb = fallbackAt?.(budget)
          return plan({ ...opts, inputs: { planningMode: 'budget' }, budget, hint: fb?.ok ? fb.result.shifts : hint, fallback: fb })
        },
        onProgress: ({ index, total, budget }) => log(`frontier ${opts.eru ?? 'current'}/${opts.structure ?? 'current'}/${opts.effort ?? CONFIG.effort.primary} ${index + 1}/${total} @ ${budget}`),
      })
    }
    const primary = monotonic(await frontier({}, budgets))
    const standardFrontier = monotonic(await frontier({ effort: CONFIG.effort.robustness }, budgets))
    // Cold (no warm start) thorough solves at a few points, to show what warm starts change.
    const cold = {}
    for (const b of [600, 624, 700]) cold[b] = await plan({ inputs: { planningMode: 'budget' }, budget: b })

    // ── C. Targets ────────────────────────────────────────────────────────────
    async function targetsFor(opts, fallbacks = null) {
      const out = []
      for (const [i, t] of CONFIG.targets.entries()) {
        log(`target ${t}% ${JSON.stringify(opts)}`)
        const fb = fallbacks?.[i]?.plan
        out.push({ targetPct: t, plan: await plan({ ...opts, inputs: { planningMode: 'target', targetCoveragePct: t }, hint: fb?.ok ? fb.result.shifts : [], fallback: fb }) })
      }
      return out
    }
    const targets = await targetsFor({})
    const maxUnmet = []
    for (const u of CONFIG.maxUnmet) { log(`max unmet ${u}`); maxUnmet.push({ maxUnmet: u, plan: await plan({ inputs: { planningMode: 'maxUnmet', maxUnmetPph: u } }) }) }
    const areaTargets = []
    for (const ex of CONFIG.areaTargetExamples) { log(`area targets ${ex.label}`); areaTargets.push({ ...ex, plan: await plan({ inputs: { planningMode: 'target', ...ex } }) }) }

    // ── D. Minimum practical ─────────────────────────────────────────────────
    async function practicalFor(opts, tolerances = CONFIG.practicalTolerances, fallbacks = null) {
      const out = []
      for (const [i, tol] of tolerances.entries()) {
        log(`min practical ${tol} ${JSON.stringify(opts)}`)
        const fb = fallbacks?.[i]?.plan
        out.push({ tolerancePct: tol, plan: await plan({ ...opts, inputs: { planningMode: 'minPractical', practicalTolerancePct: tol }, hint: fb?.ok ? fb.result.shifts : [], fallback: fb }) })
      }
      return out
    }
    const practical = await practicalFor({})

    // ── F. Expanded shift structure ──────────────────────────────────────────
    const currentFrontier = await frontier({}, CONFIG.comparisonBudgets)   // same budgets as the comparisons
    const currentAt = b => currentFrontier.find(p => p.budget === b)?.plan
    const expanded = {
      frontier: await frontier({ structure: 'expanded' }, CONFIG.comparisonBudgets, currentAt),
      currentFrontier,
      targets: await targetsFor({ structure: 'expanded' }, targets),
      practical: await practicalFor({ structure: 'expanded' }, [CONFIG.practicalTolerances[0]], practical),
    }

    // ── G. ERU policy sensitivity ────────────────────────────────────────────
    const eru = {}
    for (const k of CONFIG.eruPolicies) {
      const fit = dedicatedWindowFeasibility(configs[k], 'eru', DAYS, structures.current)
      if (fit && !fit.feasible) { eru[k] = { infeasible: true, fit }; continue }
      eru[k] = {
        fit,
        frontier: k === 'current' ? expanded.currentFrontier : await frontier({ eru: k }, CONFIG.comparisonBudgets),
        targets: k === 'current' ? targets : await targetsFor({ eru: k }),
        practical: k === 'current' ? [practical[0]] : await practicalFor({ eru: k }, [CONFIG.practicalTolerances[0]]),
      }
    }
    // Extended evening under the expanded menu (infeasible with today's starts).
    const extFit = {
      current: dedicatedWindowFeasibility(eruScenarioConfig(DEFAULT_OPERATIONAL_COVERAGE, 'extendedEvening'), 'eru', DAYS, structures.current),
      expanded: dedicatedWindowFeasibility(eruScenarioConfig(DEFAULT_OPERATIONAL_COVERAGE, 'extendedEvening'), 'eru', DAYS, structures.expanded),
    }
    log('done solving')

    // ── Serialise ────────────────────────────────────────────────────────────
    const data = {
      when: new Date().toISOString(), config: CONFIG, target, pph, scope,
      solverInfo: describeSolver(), elapsedSeconds: (Date.now() - t0) / 1000,
      structures: Object.fromEntries(Object.entries(structures).map(([k, v]) => [k, { starts: [...new Set(v.map(p => p.start))], lengths: [...new Set(v.map(p => p.length))], patterns: v.length }])),
      eruPresets: Object.fromEntries(CONFIG.eruPolicies.map(k => [k, ERU_SCENARIO_PRESETS[k]])),
      crossCoverCredit: describeCrossCoverCredit(configs.current.areas.eru.crossCoverCredit, pph),
      staffRouting: configs.current.staffRouting,
      coverageRules: {
        main: DEFAULT_OPERATIONAL_COVERAGE.areas.main, fasttrack: DEFAULT_OPERATIONAL_COVERAGE.areas.fasttrack,
      },
      observed: {
        sources: [SCHEDULE_CSV, DEMAND_JSON], nDays: demand.Main?.n_days ?? null, snapshot: snapshotSummary(),
        demand: Object.fromEntries(areas.map(a => [a, DAYS.reduce((t, d) => t + getDemandSeries(demand, AREA_LABEL[a], d, target).reduce((x, y) => x + y, 0), 0)])),
        attendingHours: Object.fromEntries(areas.map(a => [a, DAYS.reduce((t, d) => t + currentFor(d).filter(s => s.role_type === 'Attending' && teamArea(s.team, []) === a).reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0)])),
        byRole: current.reduce((m, s) => ({ ...m, [s.role_type]: (m[s.role_type] ?? 0) + 1 }), {}),
        currentScored: compactSummary(currentScored),
      },
      baseline: { thorough: brief(baseline.thorough, true), standard: brief(baseline.standard), withoutSupervision: brief(baseline.withoutSupervision, true), withoutIntakeCutoffs: brief(baseline.withoutIntakeCutoffs, true) },
      intakeCutoffs: configs.current.intakeCutoffs ?? null,
      blueShifts: [...new Set(current.filter(x => x.team === 'Blue').map(x => `${x.role_type} ${x.start_time}–${x.end_time}`))].sort(),
      supervision: { floor: supervisionFloor, supervisedTeamHours, invariants },
      previous: existsSync(PREVIOUS) ? previousBrief(JSON.parse(readFileSync(PREVIOUS, 'utf8'))) : null,
      frontier: { primary: frontierBrief(primary), standard: frontierBrief(standardFrontier), cold: Object.fromEntries(Object.entries(cold).map(([b, p]) => [b, brief(p)])) },
      targets: targets.map(t => ({ targetPct: t.targetPct, ...brief(t.plan, true) })),
      maxUnmet: maxUnmet.map(t => ({ maxUnmet: t.maxUnmet, ...brief(t.plan) })),
      areaTargets: areaTargets.map(t => ({ label: t.label, targetCoveragePct: t.targetCoveragePct, areaTargets: t.areaTargets, ...brief(t.plan) })),
      practical: practical.map(t => ({ tolerancePct: t.tolerancePct, ...brief(t.plan, true) })),
      expanded: {
        frontier: frontierBrief(expanded.frontier), currentFrontier: frontierBrief(expanded.currentFrontier),
        targets: expanded.targets.map(t => ({ targetPct: t.targetPct, ...brief(t.plan) })),
        practical: expanded.practical.map(t => ({ tolerancePct: t.tolerancePct, ...brief(t.plan, true) })),
      },
      eru: Object.fromEntries(Object.entries(eru).map(([k, v]) => [k, v.infeasible ? { infeasible: true, fit: v.fit } : {
        fit: v.fit, frontier: frontierBrief(v.frontier),
        targets: v.targets.map(t => ({ targetPct: t.targetPct, ...brief(t.plan) })),
        practical: v.practical.map(t => ({ tolerancePct: t.tolerancePct, ...brief(t.plan) })),
      }])),
      extendedEveningFit: extFit,
    }
    mkdirSync(path.join(HERE, 'reports'), { recursive: true })
    writeFileSync(`${OUT}.json`, JSON.stringify(data, null, 1))
    writeFileSync(`${OUT}.md`, renderFrontierReport(data))
  }, 7_200_000)
})

// The instance with the resident-supervision rule removed (control solves only).
function stripSupervision(inst) {
  return {
    ...inst,
    areas: inst.areas.map(a => ({
      ...a,
      requirementLabels: (a.requirementLabels ?? []).filter(l => !l.startsWith('Resident supervision')),
      slots: a.slots.map(sl => { const out = { ...sl }; delete out.minAttendings; return out }),
    })),
  }
}

// data/processed/summary.json: what the committed demand snapshot covers.
function snapshotSummary() {
  try {
    const sm = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data/processed/summary.json'), 'utf8'))
    return { encounters: sm.total_encounters, dateRange: sm.date_range, days: sm.unique_days }
  } catch { return null }
}

// The key numbers of an earlier run, for the before/after comparison.
function previousBrief(prev) {
  const b = prev.baseline?.thorough
  const hoursBy = (x, a) => x?.summary?.byArea?.[a]?.attendingHours ?? null
  return {
    when: prev.when,
    observed: { nDays: prev.observed?.nDays ?? null, snapshot: prev.observed?.snapshot ?? null },
    hadSupervision: !!prev.supervision,
    hadIntakeCutoffs: !!prev.intakeCutoffs,
    blueShifts: prev.blueShifts ?? null,
    baseline: b && { hoursByArea: { main: hoursBy(b, 'main'), fasttrack: hoursBy(b, 'fasttrack'), eru: hoursBy(b, 'eru') },
      coverage: b.summary.all.coverage, unmet: b.summary.all.unmet, unmetByArea: Object.fromEntries(Object.entries(b.summary.byArea).map(([a, m]) => [a, m.unmet])) },
    targets: (prev.targets ?? []).map(t => ({ targetPct: t.targetPct, ok: t.ok, hours: t.hours?.total ?? null, best: t.planning?.bestAchievable?.coverage ?? null })),
    practical: (prev.practical ?? []).map(t => ({ tolerancePct: t.tolerancePct, ok: t.ok, hours: t.hours?.total ?? null, coverage: t.summary?.all?.coverage ?? null, best: t.planning?.bestAchievable?.coverage ?? null })),
    frontier: (prev.frontier?.primary ?? []).map(r => ({ budget: r.budget, feasible: r.feasible, hours: r.hours, unmet: r.unmet, coverage: r.coverage, unmetByArea: r.unmetByArea })),
    eru: Object.fromEntries(Object.entries(prev.eru ?? {}).map(([k, v]) => [k, v.infeasible ? { infeasible: true } : {
      frontier: (v.frontier ?? []).map(r => ({ budget: r.budget, feasible: r.feasible, unmet: r.unmet, coverage: r.coverage })),
      targets: (v.targets ?? []).map(t => ({ targetPct: t.targetPct, ok: t.ok, hours: t.hours?.total ?? null })),
      practical: (v.practical ?? []).map(t => ({ ok: t.ok, hours: t.hours?.total ?? null })),
    }])),
  }
}

function coversHour(s, h) {
  const a = h * 60, b = a + 60
  if (s.endMins <= 1440) return s.startMins < b && s.endMins > a
  return s.startMins < b || a < s.endMins - 1440
}

// Grid points within 5 h of an included budget are dropped (624 vs 625).
function frontierList({ min, max, step, include = [] }) {
  const out = new Set(include)
  for (let b = min; b <= max; b += step) if (!include.some(x => x !== b && Math.abs(x - b) < 5)) out.add(b)
  return [...out].sort((a, b) => a - b)
}

function compactSummary(s) {
  const area = m => ({ demand: m.demand, served: m.served, unmet: m.unmet, excess: m.excess, coverage: m.coverage, attendingHours: m.attendingHours, maxOnDuty: m.maxOnDuty })
  return { all: area(s.all), byArea: Object.fromEntries(Object.entries(s.byArea).map(([a, m]) => [a, area(m)])), worst: s.worst }
}

function bottleneckBrief(b) {
  if (!b) return null
  return { total: b.total, byLabel: b.byLabel, byCombination: b.byCombination, byArea: b.byArea, runs: b.runs.slice(0, 12) }
}

// Compact, JSON-safe view of a plan.
function brief(p, detail = false) {
  if (!p.ok) {
    return {
      ok: false, status: p.result.status, message: p.result.message, planning: planningBrief(p.result.planning),
      bestAchievable: p.bestAchievable ? { summary: compactSummary(p.bestAchievable.summary), bottlenecks: bottleneckBrief(p.bestAchievable.bottlenecks) } : null,
    }
  }
  const planned = Object.values(p.plannedByDay).flat()
  const out = {
    ok: true, status: p.result.status, message: p.result.message, gap: p.result.stats?.relativeGap ?? null,
    fellBack: !!p.fellBack, searchResult: p.searchResult ?? null,
    seconds: p.result.stats?.solveSeconds ?? null, objective: p.result.stats?.objectiveValue ?? null,
    hours: p.result.hours, solverView: p.result.objective, planning: planningBrief(p.result.planning),
    summary: compactSummary(p.summary), crossCheck: p.crossCheck,
    shiftCount: planned.length, distinctStarts: [...new Set(planned.map(s => s.start_time))].sort(),
    shiftMix: planned.reduce((m, s) => { const k = `${s.start_time}+${(s.endMins - s.startMins) / 60}h`; m[k] = (m[k] ?? 0) + 1; return m }, {}),
    eruDedicated: p.op?.eru?.hoursDedicated ?? null, eruCrossCovered: p.op?.eru?.hoursCrossCovered ?? null,
    bottlenecks: bottleneckBrief(p.bottlenecks),
  }
  if (detail) {
    out.plannedByDay = Object.fromEntries(Object.entries(p.plannedByDay).map(([d, list]) => [d, list.map(s => ({ team: s.team, start: s.start_time, end: s.end_time }))]))
    out.onDutyByHour = onDuty(p)
  }
  return out
}

// Mean attendings on duty per area and hour of day, over the week.
function onDuty(p) {
  const out = {}
  for (const d of DAYS) {
    for (const s of p.proposedFor(d).filter(x => x.role_type === 'Attending')) {
      const a = teamArea(s.team, p.newTeams)
      out[a] ??= Array(24).fill(0)
      for (let h = 0; h < 24; h++) if (coversHour(s, h)) out[a][h] += 1 / DAYS.length
    }
  }
  return out
}

function planningBrief(pl) {
  if (!pl || !Object.keys(pl).length) return null
  const { bestAchievablePlan, ...rest } = pl
  void bestAchievablePlan
  return rest
}

function frontierBrief(points) {
  const rows = frontierRows(points)
  return points.map((pt, i) => ({ ...rows[i], plan: pt.plan.ok ? brief(pt.plan) : null, searchObjective: pt.searchObjective ?? null }))
}
