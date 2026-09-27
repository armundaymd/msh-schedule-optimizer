// Current schedule vs generated schedules on the committed real data, under
// identical demand assumptions. Writes validation/reports/comparison-report.md.
//   npm run validate
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AREA_LABEL, scopeAreas, teamsInArea } from '../src/shared/areas'
import { attendingCapacityForTeam, teamArea, teamCapacity, teamCapacityForTeam } from '../src/shared/capacity'
import { DEFAULT_PPH } from '../src/shared/pph'
import { applyPlanResult, buildPlanInstance } from '../src/shared/staffingPlan'
import { generateSchedule, assignTeams, applyGeneratedAttendings } from '../src/v3/utils/generator'
import { DEFAULT_PATTERNS, planPatterns } from '../src/v3/utils/patterns'
import { renderComparison, scheduleMetrics, unattendedHours } from './compare'
import { GENERATOR_MAX_CONCURRENT, solverAvailable } from './engines'
import { loadCurrentSchedule, loadDemand } from '../analysis/realData'
import { solveInstance } from '../analysis/solver'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const demand = loadDemand()
const ctx = { days: DAYS, demand, pph: DEFAULT_PPH, scope: 'wholeEd', target: 'mean' }
const current = loadCurrentSchedule()
const currentFor = d => current.filter(s => s.day === d)
const results = []

// The generator exactly as the app runs it with the panel's defaults:
// today's patterns, min 1 / max per-area concurrent, weekday/Sat/Sun
// templates, the area's attendings replaced and residents/PAs kept
// (applyGeneratedAttendings, as App.handleGenerate does).
function generatorSchedule() {
  const groups = [
    { anchor: 'Monday', days: DAYS.slice(0, 5) }, { anchor: 'Saturday', days: ['Saturday'] }, { anchor: 'Sunday', days: ['Sunday'] },
  ]
  let customTeams = []
  const byDay = Object.fromEntries(DAYS.map(d => [d, currentFor(d)]))
  const generatedByDay = Object.fromEntries(DAYS.map(d => [d, []]))
  for (const area of scopeAreas(ctx.scope)) {
    let reusable = []
    for (const g of groups) {
      const res = generateSchedule({
        demand, target: ctx.target, day: g.anchor, area, patterns: DEFAULT_PATTERNS, pph: ctx.pph,
        constraints: { minConcurrent: 1, maxConcurrent: GENERATOR_MAX_CONCURRENT[area], overnightMin: 0, overnightHours: [], costPerHour: 250 },
      })
      const { shifts, newTeams } = assignTeams(res.shifts, area, reusable, customTeams.map(t => t.name))
      customTeams = [...customTeams, ...newTeams]
      reusable = [...reusable, ...newTeams]
      const areaTeams = teamsInArea(area, customTeams)
      for (const day of g.days) {
        const placed = shifts.map(s => ({ ...s, day, id: `${s.id}-${day}` }))
        byDay[day] = applyGeneratedAttendings(byDay[day], placed, areaTeams)
        generatedByDay[day].push(...placed)
      }
    }
  }
  return { label: 'Generator (app defaults)', shiftsForDay: d => byDay[d], customTeams, generatedByDay,
    note: 'Greedy + local search per area on weekday/Saturday/Sunday templates, today\'s shift patterns, at least 1 attending at all times. '
      + 'Sized at the attending supervision ceiling. As in the app, applying it replaces the area\'s attending shifts and keeps residents/PAs on their teams.' }
}

function allocatorSchedule(label, minRules, note) {
  const areas = scopeAreas(ctx.scope)
  const weekly = DAYS.reduce((t, d) => t + currentFor(d).filter(s => s.role_type === 'Attending' && areas.includes(teamArea(s.team, []))).reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0)
  const { instance, context } = buildPlanInstance({
    days: DAYS, shiftsForDay: currentFor, customTeams: [], pph: ctx.pph, demand, target: ctx.target, scope: ctx.scope,
    patterns: planPatterns('current', [8, 10, 12]), minCoverageRules: minRules, weeklyBudgetHours: weekly,
  })
  const result = solveInstance(instance)
  if (!result.hours) return { label, error: `${result.status}: ${result.message}` }
  const { proposedByDay, newTeams, plannedByDay } = applyPlanResult(result, context, [])
  return { label, shiftsForDay: d => proposedByDay[d], customTeams: newTeams, generatedByDay: plannedByDay, budget: weekly, hours: result.hours,
    note: `${note} Budget = today's ${weekly} attending h/week; solver ${result.status} in ${result.stats.solveSeconds} s (within ${(100 * result.stats.relativeGap).toFixed(1)}% of the best possible).` }
}

describe('current vs generated schedules (real data, same demand)', () => {
  it('measures the current schedule', () => {
    const cur = { label: 'Current', shiftsForDay: currentFor, customTeams: [] }
    const m = scheduleMetrics(ctx, cur)
    // Also measure it as the app priced it before the /api/schedule fix
    // (resident_level dropped -> every resident at the PGY-2 rate), and how
    // often the supervision ceiling is what limits a Main team.
    const stripped = current.map(s => ({ ...s, resident_level: null, role_detail: s.role_type === 'Resident' ? 'unknown' : s.role_detail }))
    let capWith = 0, capWithout = 0, changed = 0, atCeiling = 0, staffedTeamHours = 0
    for (const d of DAYS) {
      const x = currentFor(d), y = stripped.filter(s => s.day === d)
      for (const area of scopeAreas(ctx.scope)) for (let h = 0; h < 24; h++) {
        const cx = teamCapacity(x, ctx.pph, [], area, h), cy = teamCapacity(y, ctx.pph, [], area, h)
        capWith += cx; capWithout += cy
        if (Math.abs(cx - cy) > 1e-9) changed++
      }
      for (const team of ['Green', 'Red', 'Blue']) for (let h = 0; h < 24; h++) {
        const ceiling = attendingCapacityForTeam(x, ctx.pph, 'main', team, h)
        if (ceiling > 0) { staffedTeamHours++; if (Math.abs(teamCapacityForTeam(x, ctx.pph, 'main', team, h) - ceiling) < 1e-9) atCeiling++ }
      }
    }
    m.note = `The schedule as loaded from \`data/Current_Schedule_Block.csv\` (${current.length} shifts), each resident priced at their level. `
      + `Before the \`/api/schedule\` fix the app priced every resident as PGY-2: that changes capacity in ${changed} of ${DAYS.length * 72} area-hours `
      + `(${capWith.toFixed(1)} vs ${capWithout.toFixed(1)} patient-hours of capacity per week) — small, because ${atCeiling} of ${staffedTeamHours} `
      + `staffed Main team-hours are already at the attending supervision ceiling, where extra resident capacity does not count.`
    m.unattended = unattendedHours(ctx, cur)
    results.push(m)
    // Guard: a comparison against zero demand is meaningless (and would
    // pass every conservation check trivially).
    expect(m.all.demand).toBeGreaterThan(1000)
    expect(Math.abs(m.all.served + m.all.deficit - m.all.demand)).toBeLessThan(1e-6)
  })

  it('measures the generator\'s schedule', () => {
    const gen = generatorSchedule()
    const m = scheduleMetrics(ctx, gen)
    m.unattended = unattendedHours(ctx, gen)
    results.push(m)
    const menu = new Set(DEFAULT_PATTERNS.map(p => `${p.start}/${p.length}`))
    for (const d of DAYS) for (const s of gen.generatedByDay[d]) expect(menu.has(`${s.startMins / 60}/${(s.endMins - s.startMins) / 60}`)).toBe(true)
    expect(Math.abs(m.all.served + m.all.deficit - m.all.demand)).toBeLessThan(1e-6)
  })

  const solver = solverAvailable()
  const allocIt = solver.ok ? it : it.skip
  for (const [label, rules, note] of [
    ['Allocator (same hours)', [], 'Staffing planner, no minimum-coverage rules.'],
    ['Allocator (same hours, attending always on)', scopeAreas(ctx.scope).map(area => ({ area, fromHour: 0, toHour: 0, min: 1 })),
      'Staffing planner with an operational rule the objective alone does not encode: every area has an attending on at all times.'],
  ]) {
    allocIt(`measures: ${label}`, () => {
      const plan = allocatorSchedule(label, rules, note)
      if (plan.error) { results.push({ label, error: plan.error }); return }
      const m = scheduleMetrics(ctx, plan)
      m.unattended = unattendedHours(ctx, plan)
      results.push(m)
      expect(plan.hours.total).toBeLessThanOrEqual(plan.budget + 1e-9)
      expect(Math.abs(m.all.served + m.all.deficit - m.all.demand)).toBeLessThan(1e-6)
    }, 120_000)
  }

  afterAll(() => {
    const ok = results.filter(r => !r.error)
    const md = renderComparison(ctx, ok, { when: new Date().toISOString(), source: '`data/Current_Schedule_Block.csv` + `data/processed/demand.json` (committed snapshot)' })
    const unattendedRow = `| Hours with no attending on (${Object.values(AREA_LABEL).join(' / ')}) | ${ok.map(r => Object.keys(AREA_LABEL).map(a => r.unattended?.[a] ?? 0).join(' / ')).join(' | ')} |`
    const withRow = md.replace(/(\| Excess beyond tolerance \(patient-hours\) \|[^\n]*\n)/, `$1${unattendedRow}\n`)
    const errors = results.filter(r => r.error).map(r => `\n> ${r.label} could not be produced: ${r.error}`).join('')
    mkdirSync(path.join(HERE, 'reports'), { recursive: true })
    writeFileSync(path.join(HERE, 'reports', 'comparison-report.md'), withRow + errors + '\n')
    console.log(`\nComparison report: ${path.join(HERE, 'reports', 'comparison-report.md')}`)
  })
})
