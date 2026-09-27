// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_OPERATIONAL_COVERAGE } from '../../../shared/operationalCoverage'
import { DEFAULT_PPH } from '../../../shared/pph'

// The solver endpoint, mocked: one Main attending 07-15 each day; target
// runs also report the planning block the backend returns.
const calls = []
vi.mock('../../../shared/api', () => ({
  postStaffingPlan: vi.fn(async instance => {
    calls.push(instance)
    if (instance.mode === 'target' && instance.targetCoverage > 0.99) {
      return { status: 'infeasible', message: 'TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS: overall: requested …', planning: { bestAchievablePlan: [] } }
    }
    const shifts = instance.days.map(day => ({ area: 'main', slot: 'Green', flex: false, day, start: 7, length: 8 }))
    const total = 8 * instance.days.length
    return {
      status: 'optimal', message: '', shifts, stats: { objectiveValue: 1000 - (instance.budgetHours ?? 0), relativeGap: 0, solveSeconds: 0.1 },
      hours: { budget: instance.budgetHours, usableBudget: instance.budgetHours, locked: 0, optimized: total, total, unallocated: instance.budgetHours != null ? instance.budgetHours - total : null },
      objective: { unmetPphHours: 10 },
      planning: instance.mode === 'target' ? { hoursRequired: total, hoursLowerBound: total, hoursProven: true, requested: { areaTargetCoverage: {} }, bestAchievable: { coverage: 0.98, unmetPph: 5, proven: true } } : {},
    }
  }),
}))

const { default: StaffingPlan } = await import('./index')

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { cleanup(); calls.length = 0 })

const DAYS = ['Monday']
const demand = { Main: { overall: Array(24).fill(2) }, FastTrack: { overall: Array(24).fill(0) }, ERU: { overall: Array(24).fill(0) } }
const shifts = [
  { id: 'a', day: 'Monday', team: 'Green', role_type: 'Attending', role_detail: 'Attending', resident_level: null, startMins: 420, endMins: 900, start_time: '07:00', end_time: '15:00' },
  { id: 'r', day: 'Monday', team: 'Green', role_type: 'Resident', role_detail: 'EM2', resident_level: 'PGY-2', startMins: 420, endMins: 900, start_time: '07:00', end_time: '15:00' },
]

function setup(props = {}) {
  return render(
    <StaffingPlan open onClose={() => {}} days={DAYS} initialScope="main" initialTarget="mean" percentilesAvailable={false}
      shiftsForDay={() => shifts} customTeams={[]} pph={DEFAULT_PPH} demand={demand} onApply={() => {}} onSaveScenario={() => {}}
      operationalCoverage={DEFAULT_OPERATIONAL_COVERAGE} onCoverageChange={() => {}} {...props} />,
  )
}

describe('Staffing Planner planning modes', () => {
  it('target mode sends the target and shows requested / required / achieved with provenance', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Target modeled coverage' }))
    fireEvent.click(screen.getByRole('button', { name: '92.5%' }))
    fireEvent.click(screen.getByRole('button', { name: 'Find hours needed' }))
    await screen.findByText(/Attending h required/)
    expect(calls[0]).toMatchObject({ mode: 'target', targetCoverage: 0.925, budgetHours: null })
    expect(screen.getByText('≥ 92.5% modeled coverage')).toBeTruthy()
    expect(screen.getByText('proven minimum for this menu and rules')).toBeTruthy()
    for (const tag of ['OBSERVED', 'CONFIGURED', 'ASSUMED', 'CALCULATED']) expect(screen.getAllByText(tag).length).toBeGreaterThan(0)
    expect(screen.getByText(/not a clinical staffing requirement/)).toBeTruthy()
  })

  it('an infeasible target is reported as such, not as a plan', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Target modeled coverage' }))
    fireEvent.change(screen.getByLabelText('Target modeled coverage'), { target: { value: '99.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find hours needed' }))
    await screen.findByText(/TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS\./)
    expect(screen.queryByRole('button', { name: 'Apply to schedule' })).toBeNull()
  })

  it('frontier mode solves each budget with warm starts and lists them', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Resource frontier' }))
    fireEvent.change(screen.getByLabelText('Frontier min'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Frontier max'), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText('Frontier step'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solve frontier' }))
    await screen.findByText(/Marginal value of additional attending-hours/)
    // 40 and 60, plus today's 8 h.
    expect(calls.map(c => c.budgetHours)).toEqual([8, 40, 60])
    expect(calls[0].hint).toBeUndefined()
    expect(calls[1].hint).toHaveLength(1)
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(3))
  })

  it('restores saved planner settings (mode and inputs)', () => {
    setup({ restoredSettings: { planningMode: 'maxUnmet', maxUnmetPph: 42, scope: 'main', target: 'mean' } })
    expect(screen.getByRole('button', { name: 'Maximum modeled unmet demand' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Maximum unmet patient-hours per week').value).toBe('42')
  })

  it('FTE and cost stay blank until configured', () => {
    setup()
    expect(screen.getByLabelText('Clinical hours per FTE').value).toBe('')
    expect(screen.getByLabelText('Hourly rate').value).toBe('')
  })
})
