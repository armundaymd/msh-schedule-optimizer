// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_OPERATIONAL_COVERAGE, cloneCoverageConfig } from '../../../shared/operationalCoverage'
import IntakeCutoffEditor from './IntakeCutoffEditor'

afterEach(cleanup)

describe('IntakeCutoffEditor', () => {
  const coverage = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)

  it('shows the confirmed cutoffs and edits a team time', () => {
    const onChange = vi.fn()
    render(<IntakeCutoffEditor coverage={coverage} onChange={onChange} customTeams={[]} />)
    const froms = screen.getAllByLabelText('From')
    expect(froms.map(s => Number(s.value))).toEqual([20, 0])
    fireEvent.change(froms[0], { target: { value: '19' } })
    const next = onChange.mock.calls[0][0].intakeCutoffs
    expect(next.teams[0]).toMatchObject({ team: 'Blue', fromHour: 19, toHour: 7 })
    expect(next.teams[1]).toMatchObject({ team: 'FastTrack', fromHour: 0 })
  })

  it('edits the hours for tool-added teams, adds and removes a team cutoff', () => {
    const onChange = vi.fn()
    render(<IntakeCutoffEditor coverage={coverage} onChange={onChange} customTeams={[]} />)
    fireEvent.change(screen.getByLabelText('Hours before coverage ends'), { target: { value: '2' } })
    expect(onChange.mock.calls[0][0].intakeCutoffs.extraTeamsHoursBeforeEnd).toBe(2)
    fireEvent.click(screen.getByText('+ Add team cutoff'))
    expect(onChange.mock.calls[1][0].intakeCutoffs.teams).toHaveLength(3)
    fireEvent.click(screen.getAllByLabelText('Remove cutoff')[1])
    expect(onChange.mock.calls[2][0].intakeCutoffs.teams.map(t => t.team)).toEqual(['Blue'])
  })
})
