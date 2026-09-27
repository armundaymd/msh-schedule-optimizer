// Adapters that run each schedule-producing engine on a synthetic scenario
// exactly the way the app does, and return a uniform "run" for the
// invariant checks and the report.
//
//   generator — v2/utils/generator.js (greedy + local search), one area at a
//               time, merged into the day the way App.handleGenerate does.
//   allocator — the staffing planner: shared/staffingPlan.js builds the
//               instance, the real OR-Tools solver (python -m staffing)
//               solves it, applyPlanResult rebuilds the schedule.

import { AREA_LABEL, scopeAreas, teamsInArea } from '../src/shared/areas'
import { shiftCoversHour } from '../src/shared/capacity'
import { applyPlanResult, buildPlanInstance } from '../src/shared/staffingPlan'
import { generateSchedule, assignTeams, applyGeneratedAttendings } from '../src/v3/utils/generator'
import { solveInstance as solve, solverAvailable } from '../analysis/solver'

// ConstraintsPanel's per-area defaults for the generator.
export const GENERATOR_MAX_CONCURRENT = { main: 3, fasttrack: 1, eru: 1 }

export { solverAvailable }

function hoursOf(shifts) {
  return shifts.reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)
}

export function runGenerator(sc) {
  const areas = scopeAreas(sc.scope)
  let customTeams = [...sc.customTeams]
  const schedule = {}, generated = {}, claimed = { capacity: {}, uncovered: {} }, reported = { hours: 0 }
  for (const day of sc.days) {
    let dayShifts = sc.currentFor(day)
    generated[day] = []
    for (const area of areas) {
      const c = sc.pph[area] ?? 0
      const result = generateSchedule({
        demand: sc.demandJson, target: 'mean', day, area, patterns: sc.patterns, pph: sc.pph,
        constraints: {
          minConcurrent: sc.generator?.minConcurrent?.[area] ?? 0,
          maxConcurrent: sc.generator?.maxConcurrent?.[area] ?? GENERATOR_MAX_CONCURRENT[area],
          overnightMin: 0, overnightHours: [], costPerHour: 250,
          hourBudget: sc.generator?.hourBudget ?? null,
        },
      })
      const { shifts, newTeams } = assignTeams(result.shifts, area, [], customTeams.map(t => t.name))
      customTeams = [...customTeams, ...newTeams]
      // Same merge as App.handleGenerate: the area's attendings are replaced,
      // residents/PAs kept.
      dayShifts = applyGeneratedAttendings(dayShifts, shifts.map(s => ({ ...s, day })), teamsInArea(area, customTeams))
      generated[day].push(...shifts)
      reported.hours += Object.values(result.patternCounts).reduce((t, p) => t + p.count * p.length, 0)
      claimed.capacity[area] ??= []
      claimed.uncovered[area] ??= []
      claimed.capacity[area].push(Array.from({ length: 24 }, (_, h) => shifts.filter(s => shiftCoversHour(s, h)).length * c))
      claimed.uncovered[area].push(result.uncovered)
    }
    schedule[day] = dayShifts
  }
  return {
    engine: 'generator', status: 'ok', schedule, generated, locked: Object.fromEntries(sc.days.map(d => [d, []])),
    customTeams, claimed, reported, budget: sc.generator?.hourBudget ?? null, maxPerTeam: 1,
    generatedHours: sc.days.reduce((t, d) => t + hoursOf(generated[d]), 0),
  }
}

export function runAllocator(sc) {
  const probe = solverAvailable()
  if (!probe.ok) return { engine: 'allocator', status: 'skipped', message: probe.reason }
  const budget = sc.budget ?? 10_000
  const { instance, context } = buildPlanInstance({
    days: sc.days, shiftsForDay: sc.currentFor, customTeams: sc.customTeams, pph: sc.pph, demand: sc.demandJson,
    target: 'mean', scope: sc.scope, patterns: sc.patterns, lockRules: sc.lockRules, minCoverageRules: sc.minRules,
    mode: 'budget', weeklyBudgetHours: budget,
  })
  const result = solve(instance)
  if (!result.hours) return { engine: 'allocator', status: result.status, message: result.message, instance, result }
  const { proposedByDay, newTeams, plannedByDay } = applyPlanResult(result, context, sc.customTeams)
  return {
    engine: 'allocator', status: result.status, message: result.message, instance, result,
    schedule: proposedByDay, generated: plannedByDay, locked: context.lockedByDay,
    customTeams: [...sc.customTeams, ...newTeams],
    claimed: {
      capacity: result.modeledCapacity,
      deficitPphHours: result.objective.deficitPphHours,
      excessPphHours: result.objective.excessPphHours,
    },
    reported: { hours: result.hours.optimized, lockedHours: result.hours.locked, total: result.hours.total },
    budget, maxPerTeam: 1,
    generatedHours: sc.days.reduce((t, d) => t + hoursOf(plannedByDay[d]), 0),
  }
}

export { AREA_LABEL }
