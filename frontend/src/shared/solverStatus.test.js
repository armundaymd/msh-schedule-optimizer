import { describe, it, expect } from 'vitest'
import { solverStatus, formatGapPct } from './solverStatus'

describe('solverStatus', () => {
  it('calls a plan proven optimal only when the gap is zero', () => {
    expect(solverStatus('optimal', 0)).toMatchObject({ kind: 'proven', label: 'Optimal' })
    expect(solverStatus('optimal', 0).detail).toMatch(/mathematically proven/)
  })

  it('an OPTIMAL status that stopped inside the 0.1% tolerance is near-optimal, not proven', () => {
    const s = solverStatus('optimal', 0.0008)
    expect(s.kind).toBe('near')
    expect(s.label).toBe('Near-optimal')
    expect(s.detail).toBe('within 0.08% of the best possible objective')
    expect(`${s.label} ${s.detail} ${s.short}`).not.toMatch(/proven/)
  })

  it('a feasible (budget-limited) result reports its optimality gap', () => {
    expect(solverStatus('feasible', 0.04)).toMatchObject({ kind: 'best', label: 'Best found', detail: '4.0% optimality gap' })
  })

  it('formats gaps', () => {
    expect(formatGapPct(0)).toBe('0.0%')
    expect(formatGapPct(0.0005)).toBe('0.05%')
    expect(formatGapPct(0.123)).toBe('12.3%')
  })
})
