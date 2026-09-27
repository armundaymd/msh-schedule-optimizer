// The real allocator solver (OR-Tools CP-SAT) via `python -m staffing`,
// for Node-side validation and analysis runs.
import { execFileSync } from 'node:child_process'
import { REPO_ROOT } from './realData'

const PYTHON = process.env.PYTHON ?? 'python3'

let probe = null
export function solverAvailable() {
  if (probe == null) {
    try {
      execFileSync(PYTHON, ['-c', 'import ortools, pydantic, staffing.service'], { cwd: REPO_ROOT, stdio: 'pipe' })
      probe = { ok: true }
    } catch (e) {
      probe = { ok: false, reason: `${PYTHON} with ortools/pydantic not available: ${String(e.stderr ?? e.message).trim().split('\n').at(-1)}` }
    }
  }
  return probe
}

export function solveInstance(instance) {
  const out = execFileSync(PYTHON, ['-m', 'staffing'], {
    cwd: REPO_ROOT, input: JSON.stringify(instance), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out.toString())
}

// Objective scaling, penalties and search settings as the solver defines them.
export function describeSolver() {
  return JSON.parse(execFileSync(PYTHON, ['-m', 'staffing', '--describe'], { cwd: REPO_ROOT }).toString())
}
