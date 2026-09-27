// Runs every synthetic scenario through every engine, checks invariants and
// expectations, and writes validation/reports/validation-report.md.
//   npm run validate
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { teamArea } from '../src/shared/capacity'
import { checkInvariants } from './invariants'
import { runAllocator, runGenerator, solverAvailable } from './engines'
import { SCENARIOS } from './scenarios'
import { renderReport } from './report'

const REPORT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports')
const OK = new Set(['ok', 'optimal', 'feasible'])
const results = []

function engineMode(sc, engine) {
  const m = sc.engines[engine]
  return typeof m === 'string' ? { mode: m } : m
}

export function evaluate(sc, engine) {
  const { mode, reason } = engineMode(sc, engine)
  if (mode === 'na') return { engine, outcome: 'N/A', reason, checks: [] }
  const run = engine === 'generator' ? runGenerator(sc) : runAllocator(sc)
  if (run.status === 'skipped') return { engine, outcome: 'SKIPPED', reason: run.message, checks: [] }

  const base = { engine, status: run.status, message: run.message }
  if (sc.expectStatus || !OK.has(run.status)) {
    const exp = sc.expectStatus ? sc.expect({ run, sc }) : [{ level: 'must', name: 'Engine produced a schedule', pass: false, detail: `${run.status}: ${run.message}` }]
    const failed = exp.filter(c => !c.pass)
    return { ...base, noSchedule: true, checks: exp, outcome: failed.length ? 'FAIL' : 'PASS',
      reason: failed.length ? failed.map(c => `${c.name} (${c.detail})`).join('; ') : `Refused as expected: ${run.message}` }
  }

  const inv = checkInvariants(sc, run)
  const gen = sc.days.flatMap(d => run.generated[d])
  const ctx = { run, sc, gen, hours: run.generatedHours, m: inv.measured, t: inv.metrics, areaOf: team => teamArea(team, run.customTeams) }
  const exp = sc.expect(ctx)
  const invFail = inv.checks.filter(c => c.pass === false)
  const mustFail = exp.filter(c => c.level === 'must' && !c.pass)
  const shouldFail = exp.filter(c => c.level === 'should' && !c.pass)
  const list = cs => cs.map(c => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')

  let outcome, why
  if (invFail.length) { outcome = 'FAIL'; why = `Invariant violated: ${list(invFail)}` }
  else if (mustFail.length || shouldFail.length) {
    if (mode === 'limitation') { outcome = 'LIMITATION'; why = `${reason} Diverges on: ${list([...mustFail, ...shouldFail])}` }
    else if (mustFail.length) { outcome = 'FAIL'; why = `Expected behaviour not met: ${list(mustFail)}` }
    else { outcome = 'SUBOPTIMAL'; why = `Valid, but not the best schedule: ${list(shouldFail)}` }
  } else {
    outcome = 'PASS'
    why = `All ${inv.checks.filter(c => c.pass !== null).length} invariants and ${exp.length} expectation checks hold.`
  }
  return {
    ...base, outcome, reason: why, checks: [...inv.checks, ...exp], metrics: inv.metrics, measured: inv.measured,
    hours: run.generatedHours, lockedHours: run.reported.lockedHours ?? 0, budget: sc.budget ?? run.budget ?? null,
    shifts: gen.map(s => `${s.team} ${s.start_time}-${s.end_time}`).join(', '),
  }
}

describe('schedule validation scenarios', () => {
  for (const sc of SCENARIOS) {
    const entry = { sc, byEngine: {} }
    results.push(entry)
    describe(`${sc.id} ${sc.title}`, () => {
      for (const engine of ['generator', 'allocator']) {
        it(engine, () => {
          const r = evaluate(sc, engine)
          entry.byEngine[engine] = r
          expect(r.outcome, r.reason).not.toBe('FAIL')
        }, 60_000)
      }
    })
  }

  afterAll(() => {
    mkdirSync(REPORT_DIR, { recursive: true })
    for (const r of results) for (const e of ['generator', 'allocator']) {
      r.byEngine[e] ??= { engine: e, outcome: 'SKIPPED', reason: 'test did not run', checks: [] }
    }
    const probe = solverAvailable()
    const md = renderReport(results, { when: new Date().toISOString(), solver: probe.ok ? 'OR-Tools CP-SAT via python -m staffing' : `unavailable (${probe.reason})` })
    writeFileSync(path.join(REPORT_DIR, 'validation-report.md'), md)
    const summary = results.map(r => `${r.sc.id.padEnd(4)} gen=${r.byEngine.generator.outcome.padEnd(10)} alloc=${r.byEngine.allocator.outcome}`)
    console.log(`\nValidation report: ${path.join(REPORT_DIR, 'validation-report.md')}\n${summary.join('\n')}`)
  })
})
