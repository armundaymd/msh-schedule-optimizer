// SHARED between the Staffing Planner UI and the analysis runs, so both
// answer the attending staffing question the same way.
//
// ATTENDING staffing planning, from several directions:
//   budget       — "Where should at most X attending-h/week go?"
//   target       — "Fewest attending-h reaching X% modeled coverage?"
//   maxUnmet     — "Fewest attending-h keeping unmet <= X patient-h/week?"
//   minPractical — "Without a budget, what would this model ask for?"
//                  least achievable unmet, then the fewest hours within a
//                  tolerance of it, then the best placement of those hours
//   frontier     — best allocation at each of a series of budgets, and
//                  the marginal value of each step
//   requirement  — fewest hours with no area-hour short by more than X
//                  patients/hr (the planner's original "estimate" mode)
// Attending hours are the only decision variable. Residents/PAs keep their
// schedule, team, level and routing; they enter only through each team's
// capacity table (capacity.js). No patient demand moves between areas.
//
// "Modeled coverage" = served / demand, where served = min(demand, modeled
// capacity) per AREA-hour (never pooled). It is not observed throughput;
// unmet patient-hours are not wait times; a calculated staffing level is not
// a clinical staffing requirement.

import { scopeAreas } from './areas'
import { shiftCoversHour, teamArea } from './capacity'
import { EXCESS_MIN_FRACTION, EXCESS_MIN_PPH, groupRuns } from './coverageInsights'
import { applyPlanResult, buildPlanInstance, capacityCrossCheck, schedulePlanMetrics, WEEKS_PER_YEAR } from './staffingPlan'
import { diagnoseBottlenecks } from './bottlenecks'

export const PLANNING_MODES = {
  budget: { label: 'Fixed attending hours', solverMode: 'budget', question: 'Where should at most X attending-hours/week be deployed?' },
  target: { label: 'Target modeled coverage', solverMode: 'target', question: 'What is the least attending staffing reaching X% modeled coverage?' },
  maxUnmet: { label: 'Maximum modeled unmet demand', solverMode: 'target', question: 'What is the least attending staffing keeping modeled unmet demand at or below X patient-hours/week?' },
  minPractical: { label: 'Minimum practical requirement', solverMode: 'min_practical', question: 'Without assuming a budget, what attending coverage would this model request?' },
  frontier: { label: 'Resource frontier', solverMode: 'budget', question: 'How much does each additional block of attending-hours reduce modeled unmet demand?' },
  requirement: { label: 'Max shortfall per hour', solverMode: 'requirement', question: 'What is the least attending staffing with no area-hour short by more than X patients/hr?' },
}
export const PLANNING_MODE_ORDER = ['budget', 'target', 'maxUnmet', 'minPractical', 'frontier']

// Planner inputs added for these modes. Defaults are editable starting
// points, not recommendations. Coverage targets are in percent.
export const DEFAULT_PLANNER_INPUTS = Object.freeze({
  planningMode: 'budget',
  targetCoveragePct: 95,
  maxUnmetPph: 75,
  areaTargets: Object.freeze({ main: null, fasttrack: null, eru: null }), // percent or null
  practicalTolerancePct: 0.5,
  frontier: Object.freeze({ min: 600, max: 750, step: 25, explicit: '' }),
  // FTE/cost translation: nothing is assumed until the user enters values.
  units: Object.freeze({ clinicalHoursPerFte: null, hourlyRate: null }),
})

// Solver fields for a planning mode (the instance's mode + target fields).
export function planningFields(inputs) {
  const mode = inputs.planningMode ?? 'budget'
  const areaTargetCoverage = {}
  for (const [a, v] of Object.entries(inputs.areaTargets ?? {})) {
    if (v != null && v !== '' && Number.isFinite(Number(v))) areaTargetCoverage[a] = Number(v) / 100
  }
  switch (mode) {
    case 'target':
      return { mode: 'target', targetCoverage: Number(inputs.targetCoveragePct) / 100, areaTargetCoverage }
    case 'maxUnmet':
      return { mode: 'target', maxUnmetPph: Number(inputs.maxUnmetPph), areaTargetCoverage }
    case 'minPractical':
      return { mode: 'min_practical', practicalTolerancePct: Number(inputs.practicalTolerancePct) }
    case 'requirement':
      return { mode: 'requirement' }
    default:
      return { mode: 'budget' }
  }
}

// Area targets only for areas in the instance.
function scopedPlanning(planning, areas) {
  if (!planning.areaTargetCoverage) return planning
  const areaTargetCoverage = Object.fromEntries(Object.entries(planning.areaTargetCoverage).filter(([a]) => areas.includes(a)))
  return { ...planning, areaTargetCoverage }
}

// ── Frontier budgets ─────────────────────────────────────────────────────────
export const MAX_FRONTIER_POINTS = 40

// min..max by step, plus explicit values ("600, 624, 700" or an array),
// plus `include` (e.g. today's hours). Sorted, de-duplicated, capped.
export function frontierBudgets({ min, max, step, explicit = '', include = [] } = {}) {
  const out = new Set()
  const lo = Number(min), hi = Number(max), st = Number(step)
  if (Number.isFinite(lo) && Number.isFinite(hi) && st > 0 && hi >= lo) {
    for (let b = lo; b <= hi + 1e-9 && out.size < MAX_FRONTIER_POINTS; b += st) out.add(Math.round(b * 100) / 100)
  }
  const extra = Array.isArray(explicit) ? explicit : String(explicit ?? '').split(/[\s,;]+/)
  for (const v of [...extra, ...include]) {
    const n = Number(v)
    if (v !== '' && Number.isFinite(n) && n >= 0) out.add(Math.round(n * 100) / 100)
  }
  return [...out].sort((a, b) => a - b).slice(0, MAX_FRONTIER_POINTS)
}

// ── Plan summary (app scoring — the authoritative model) ─────────────────────

// Coverage, unmet, excess and hours per area and overall, from
// schedulePlanMetrics (analyzeWeek: the same scoring as the heatmap).
export function summarizePlan(metrics, shiftsForDay, customTeams = []) {
  const { week } = metrics
  const blank = () => ({ demand: 0, served: 0, unmet: 0, excess: 0, attendingHours: 0, coverage: 1, maxOnDuty: 0 })
  const byArea = Object.fromEntries(week.areas.map(a => [a, blank()]))
  const periods = []
  week.days.forEach(({ day, analysis }) => {
    const att = shiftsForDay(day).filter(s => s.role_type === 'Attending')
    for (const a of week.areas) {
      const m = byArea[a]
      const row = h => analysis.hours[h].byArea[a]
      for (let h = 0; h < 24; h++) {
        const { demand: d, capacity: c } = row(h)
        m.demand += d
        m.served += Math.min(d, c)
        m.unmet += Math.max(0, d - c)
        m.excess += Math.max(0, c - d - Math.max(EXCESS_MIN_PPH, EXCESS_MIN_FRACTION * d))
        const on = att.filter(s => teamArea(s.team, customTeams) === a && shiftCoversHour(s, h)).length
        m.maxOnDuty = Math.max(m.maxOnDuty, on)
      }
      for (const run of groupRuns(h => (row(h).demand > row(h).capacity + 1e-9 ? 'short' : null))) {
        const total = run.hours.reduce((t, h) => t + row(h).demand - row(h).capacity, 0)
        const peakHour = run.hours.reduce((b, h) => (row(h).demand - row(h).capacity > row(b).demand - row(b).capacity ? h : b), run.hours[0])
        periods.push({ area: a, day, hours: run.hours, total, peakHour, peak: row(peakHour).demand - row(peakHour).capacity })
      }
      m.attendingHours = metrics.byArea[a].attendingHours
    }
  })
  const all = blank()
  for (const m of Object.values(byArea)) {
    m.coverage = m.demand > 0 ? m.served / m.demand : 1
    for (const k of ['demand', 'served', 'unmet', 'excess', 'attendingHours']) all[k] += m[k]
  }
  all.coverage = all.demand > 0 ? all.served / all.demand : 1
  periods.sort((x, y) => y.total - x.total)
  return { all, byArea, worst: periods.slice(0, 5) }
}

// ── One solve + app scoring ──────────────────────────────────────────────────

// Solve one planning question and score the result with the app's model.
// `solve(instance)` returns (or resolves to) the solver result — the HTTP
// endpoint in the UI, `python -m staffing` in the analysis runs.
// Resolves to a plan: { ok, result, instance, context, proposedByDay,
// proposedFor, newTeams, plannedByDay, after, summary, crossCheck,
// bottlenecks } — or { ok: false, result, bestAchievable? } when no plan
// exists (bestAchievable: the least-unmet plan, scored and diagnosed, so an
// infeasible target can still be explained).
export async function planAndScore({
  days, shiftsForDay, customTeams = [], pph, demand, target, scope, patterns, coverage = null,
  lockRules = [], minCoverageRules = [], maxAttendingsByArea, effort = 'standard', maxPerTeam, maxFlex,
  inputs = {}, weeklyBudgetHours = null, allowedDeficitPph = 0, hint = [], solve, diagnose = true,
  expandedPatterns = null,
}) {
  const planning = planningFields(inputs)
  const { mode, ...fields } = planning
  const built = buildPlanInstance({
    days, shiftsForDay, customTeams, pph, demand, target, scope, patterns, lockRules, minCoverageRules,
    mode, weeklyBudgetHours: mode === 'budget' ? weeklyBudgetHours : null, allowedDeficitPph, effort, coverage,
    ...(maxAttendingsByArea ? { maxAttendingsByArea } : {}),
    ...(maxPerTeam != null ? { maxPerTeam } : {}), ...(maxFlex != null ? { maxFlex } : {}),
    planning: scopedPlanning(fields, scopeAreas(scope)), hint,
  })
  const { instance, context } = built
  const result = await solve(instance)
  const score = shifts => scorePlan({ result: { ...result, shifts }, instance, context, days, customTeams, pph, demand, target, scope, coverage, patterns, expandedPatterns, diagnose })
  if (!result.hours) {
    const best = result.planning?.bestAchievablePlan
    return { ok: false, result, instance, context, bestAchievable: best ? score(best) : null }
  }
  return { ok: true, ...score(result.shifts), result, instance, context }
}

function scorePlan({ result, instance, context, days, customTeams, pph, demand, target, scope, coverage, patterns, expandedPatterns, diagnose }) {
  const { proposedByDay, newTeams, plannedByDay } = applyPlanResult(result, context, customTeams)
  const proposedFor = d => proposedByDay[d]
  const teams = [...customTeams, ...newTeams]
  const after = schedulePlanMetrics({ days, shiftsForDay: proposedFor, customTeams: teams, demand, pph, scope, target, coverage })
  const summary = summarizePlan(after, proposedFor, teams)
  const plan = { proposedByDay, proposedFor, newTeams, plannedByDay, after, summary }
  if (result.modeledCapacity && Object.keys(result.modeledCapacity).length) plan.crossCheck = capacityCrossCheck(result, after.week)
  if (diagnose) {
    plan.bottlenecks = diagnoseBottlenecks({
      instance, shifts: result.shifts, week: after.week, shiftsForDay: proposedFor, customTeams: teams, pph, coverage,
      patterns, expandedPatterns,
    })
  }
  return plan
}

// ── Resource frontier ────────────────────────────────────────────────────────

// Solves each budget in ascending order, warm-starting from the previous
// point's plan (feasible at any larger budget). If the search returns a
// WORSE objective than that plan — possible because each point is a
// bounded search, not a proof — the previous plan is carried forward, so
// the frontier never gets worse with more hours. Carried points are marked.
//   solveAt(budget, hintShifts) -> Promise<plan from planAndScore>
export async function runFrontier({ budgets, solveAt, onProgress = () => {}, tolerance = 1e-6 }) {
  const sorted = [...budgets].sort((a, b) => a - b)
  const points = []
  let prev = null
  for (const [i, budget] of sorted.entries()) {
    onProgress({ index: i, total: sorted.length, budget })
    let plan = await solveAt(budget, prev?.result?.shifts ?? [])
    let point = { budget, plan, carriedForward: false }
    if (plan.ok && prev?.ok) {
      const obj = plan.result.stats?.objectiveValue ?? Infinity
      const prevObj = prev.result.stats?.objectiveValue ?? Infinity
      if (obj > prevObj + tolerance) {
        point = { budget, plan: prev, carriedForward: true, carriedFrom: points.at(-1).budget, searchObjective: obj }
        plan = prev
      }
    }
    points.push(point)
    if (plan.ok) prev = plan
  }
  return points
}

// Frontier table rows: one per point, with allocation and outcomes.
export function frontierRows(points) {
  return points.map(({ budget, plan, carriedForward, carriedFrom }) => {
    if (!plan.ok) return { budget, feasible: false, status: plan.result?.status, message: plan.result?.message }
    const s = plan.summary
    return {
      budget, feasible: true, carriedForward, carriedFrom,
      hours: plan.result.hours.total,
      hoursByArea: Object.fromEntries(Object.entries(s.byArea).map(([a, m]) => [a, m.attendingHours])),
      coverage: s.all.coverage, unmet: s.all.unmet, excess: s.all.excess,
      coverageByArea: Object.fromEntries(Object.entries(s.byArea).map(([a, m]) => [a, m.coverage])),
      unmetByArea: Object.fromEntries(Object.entries(s.byArea).map(([a, m]) => [a, m.unmet])),
      maxOnDuty: Object.fromEntries(Object.entries(s.byArea).map(([a, m]) => [a, m.maxOnDuty])),
      worst: s.worst,
      status: plan.result.status, gap: plan.result.stats?.relativeGap ?? null,
      objective: plan.result.stats?.objectiveValue ?? null,
    }
  })
}

// Marginal benefit between consecutive FEASIBLE rows. `noise` (patient-h):
// differences smaller than the search uncertainty are flagged, not ranked.
// Rate = modeled unmet reduction per additional budgeted attending-hour.
export function marginalRows(rows, { noise = 0 } = {}) {
  const ok = rows.filter(r => r.feasible)
  return ok.slice(1).map((r, i) => {
    const p = ok[i]
    const added = r.budget - p.budget
    const reduction = p.unmet - r.unmet
    return {
      from: p.budget, to: r.budget, addedHours: added, addedUsedHours: r.hours - p.hours,
      unmetReduction: reduction,
      coveragePoints: 100 * (r.coverage - p.coverage),
      byArea: Object.fromEntries(Object.keys(r.unmetByArea).map(a => [a, p.unmetByArea[a] - r.unmetByArea[a]])),
      perHour: added > 0 ? reduction / added : null,
      withinNoise: Math.abs(reduction) < noise,
    }
  })
}

// Where the frontier flattens, as FACTS about consecutive steps, plus a
// descriptive knee: the feasible point farthest from the straight line
// between the first and last points (unmet vs hours). The knee is a
// geometric description, NOT a recommended staffing level.
export function diminishingReturns(rows, { noise = 0 } = {}) {
  const marg = marginalRows(rows, { noise })
  const facts = marg.map(m => ({
    ...m,
    text: `Adding ${fmt(m.addedHours, 0)} h (${fmt(m.from, 0)} → ${fmt(m.to, 0)}) reduced modeled unmet demand by ${fmt(m.unmetReduction)} patient-h/week`
      + (m.perHour != null ? ` (${fmt(m.perHour, 2)} per added attending-hour)` : '')
      + (m.withinNoise ? ' — within search uncertainty' : ''),
  }))
  const ok = rows.filter(r => r.feasible)
  let knee = null
  if (ok.length >= 3) {
    const a = ok[0], b = ok.at(-1)
    const dx = b.budget - a.budget, dy = b.unmet - a.unmet
    const len = Math.hypot(dx, dy) || 1
    // Normalise both axes to [0,1] so units don't decide the knee.
    const nx = x => (x - a.budget) / (dx || 1), ny = y => (y - a.unmet) / (dy || 1)
    let best = -1
    for (const r of ok.slice(1, -1)) {
      const d = Math.abs(ny(r.unmet) - nx(r.budget)) / Math.SQRT2
      if (d > best) { best = d; knee = { budget: r.budget, unmet: r.unmet, distance: d } }
    }
    if (len === 0) knee = null
  }
  // Largest single drop in the per-hour rate between neighbouring steps.
  let flattening = null
  for (let i = 1; i < marg.length; i++) {
    if (marg[i - 1].perHour == null || marg[i].perHour == null) continue
    const drop = marg[i - 1].perHour - marg[i].perHour
    if (!flattening || drop > flattening.drop) flattening = { at: marg[i].from, drop, before: marg[i - 1], after: marg[i] }
  }
  return { facts, knee, flattening }
}

// ── FTE / cost translation ───────────────────────────────────────────────────

// Uses ONLY the values given: no clinical FTE definition or rate is assumed.
// fte / cost are null until clinicalHoursPerFte / hourlyRate are set.
// Cost is an illustrative planning estimate, not institutional cost.
export function planningUnits(weeklyHours, { clinicalHoursPerFte = null, hourlyRate = null, weeksPerYear = WEEKS_PER_YEAR } = {}) {
  const annual = weeklyHours * weeksPerYear
  const perFte = Number(clinicalHoursPerFte)
  const rate = Number(hourlyRate)
  return {
    weekly: weeklyHours,
    annual,
    fte: clinicalHoursPerFte != null && clinicalHoursPerFte !== '' && perFte > 0 ? annual / perFte : null,
    cost: hourlyRate != null && hourlyRate !== '' && rate > 0 ? annual * rate : null,
    clinicalHoursPerFte: perFte > 0 ? perFte : null,
    hourlyRate: rate > 0 ? rate : null,
    weeksPerYear,
  }
}

// ── Settings persistence (scenario save / restore) ───────────────────────────

const PLANNER_KEYS = [
  'mode', 'planningMode', 'amount', 'period', 'allowedDeficit', 'scope', 'target', 'startMode', 'lengths',
  'lockRules', 'minRules', 'effort', 'coverage', 'useCoverage', 'eruScenario', 'compareCurrentEru',
  'targetCoveragePct', 'maxUnmetPph', 'areaTargets', 'practicalTolerancePct', 'frontier', 'units',
  'maxFlex', 'diagnose',
]

// The planner settings as saved with a scenario: plain JSON, known keys only.
export function serializePlannerSettings(settings) {
  const out = {}
  for (const k of PLANNER_KEYS) if (settings[k] !== undefined) out[k] = settings[k]
  return JSON.parse(JSON.stringify(out))
}

// Saved settings merged over `defaults`; unknown keys and invalid values
// fall back to the defaults, so older scenarios still open.
export function restorePlannerSettings(saved, defaults) {
  const s = { ...defaults }
  if (!saved || typeof saved !== 'object') return s
  for (const k of PLANNER_KEYS) if (saved[k] !== undefined) s[k] = structuredClone(saved[k])
  // Scenarios saved before planning modes: mode 'requirement' was the estimate mode.
  if (saved.planningMode === undefined && saved.mode === 'requirement') s.planningMode = 'requirement'
  if (!PLANNING_MODES[s.planningMode]) s.planningMode = defaults.planningMode ?? 'budget'
  s.mode = s.planningMode === 'requirement' ? 'requirement' : 'budget'
  s.areaTargets = { ...DEFAULT_PLANNER_INPUTS.areaTargets, ...(s.areaTargets ?? {}) }
  s.frontier = { ...DEFAULT_PLANNER_INPUTS.frontier, ...(s.frontier ?? {}) }
  s.units = { ...DEFAULT_PLANNER_INPUTS.units, ...(s.units ?? {}) }
  if (!Array.isArray(s.lengths) || !s.lengths.length) s.lengths = defaults.lengths
  return s
}

function fmt(n, d = 1) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}
