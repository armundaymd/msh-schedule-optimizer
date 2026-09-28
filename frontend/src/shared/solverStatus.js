// SHARED — the one place that words a CP-SAT solver status for people.
//
// The solver (staffing/cpsat.py) stops as soon as its plan is proven within
// OPTIMALITY_GAP (0.1%) of the best possible objective and then reports
// status 'optimal'. That is NOT a proof that the plan is the best: only a
// zero gap (objective equal to the proven bound) is. So:
//   'optimal' + gap 0   → Optimal — mathematically proven best for this model
//   'optimal' + gap > 0 → Near-optimal — within X% of the best possible objective
//   'feasible'          → Best found — X% optimality gap (search budget ran out)
// None of these says anything about real-world or clinical correctness.

export const PROVEN_GAP = 1e-9

export function formatGapPct(relativeGap) {
  const p = 100 * Math.max(0, Number(relativeGap) || 0)
  return `${p > 0 && p < 0.1 ? p.toFixed(2) : p.toFixed(1)}%`
}

// { kind: 'proven' | 'near' | 'best' | 'none', label, detail, short }
export function solverStatus(status, relativeGap = 0) {
  const gap = Math.max(0, Number(relativeGap) || 0)
  const g = formatGapPct(gap)
  if (status === 'optimal' && gap <= PROVEN_GAP) {
    return { kind: 'proven', label: 'Optimal', detail: 'mathematically proven best for this model', short: 'optimal (proven)' }
  }
  if (status === 'optimal') {
    return { kind: 'near', label: 'Near-optimal', detail: `within ${g} of the best possible objective`, short: `near-optimal · within ${g}` }
  }
  if (status === 'feasible') {
    return { kind: 'best', label: 'Best found', detail: `${g} optimality gap`, short: `best found · gap ${g}` }
  }
  return { kind: 'none', label: status ?? '—', detail: '', short: status ?? '—' }
}
