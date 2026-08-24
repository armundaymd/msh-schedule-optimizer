// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useScheduleState } from '../../shared/hooks/useScheduleState'
import { useCommandStack } from './useCommandStack'

const RAW = [
  { day: 'Monday', team: 'Green', role_type: 'Attending', role_detail: 'Attending', resident_level: null, start_time: '07:00', end_time: '15:00' },
  { day: 'Tuesday', team: 'Green', role_type: 'Attending', role_detail: 'Attending', resident_level: null, start_time: '07:00', end_time: '15:00' },
]

function setup() {
  const { result } = renderHook(() => {
    const schedState = useScheduleState()
    const commandStack = useCommandStack(schedState)
    return { schedState, commandStack }
  })
  act(() => result.current.schedState.loadBaseline(RAW))
  return result
}

describe('useCommandStack', () => {
  it('undo restores a single-day command regardless of what produced it', () => {
    const result = setup()
    act(() => {
      result.current.commandStack.pushCommand('day', ['Monday'], 'test edit')
      result.current.schedState.applyDayShifts('Monday', [])
    })
    expect(result.current.schedState.getShiftsForDay('Monday')).toHaveLength(0)

    act(() => result.current.commandStack.undo())
    expect(result.current.schedState.getShiftsForDay('Monday')).toHaveLength(1)
  })

  it('a week-scope command reverts every affected day in one undo', () => {
    const result = setup()
    act(() => {
      result.current.commandStack.pushCommand('week', ['Monday', 'Tuesday'], 'week op')
      result.current.schedState.applyDayShifts('Monday', [])
      result.current.schedState.applyDayShifts('Tuesday', [])
    })
    expect(result.current.schedState.getShiftsForDay('Monday')).toHaveLength(0)
    expect(result.current.schedState.getShiftsForDay('Tuesday')).toHaveLength(0)

    act(() => result.current.commandStack.undo())
    expect(result.current.schedState.getShiftsForDay('Monday')).toHaveLength(1)
    expect(result.current.schedState.getShiftsForDay('Tuesday')).toHaveLength(1)
  })

  it('redo re-applies an undone command', () => {
    const result = setup()
    act(() => {
      result.current.commandStack.pushCommand('day', ['Monday'], 'test edit')
      result.current.schedState.applyDayShifts('Monday', [])
    })
    act(() => result.current.commandStack.undo())
    expect(result.current.schedState.getShiftsForDay('Monday')).toHaveLength(1)

    act(() => result.current.commandStack.redo())
    expect(result.current.schedState.getShiftsForDay('Monday')).toHaveLength(0)
  })

  it('canUndo/canRedo reflect stack state', () => {
    const result = setup()
    expect(result.current.commandStack.canUndo()).toBe(false)
    act(() => {
      result.current.commandStack.pushCommand('day', ['Monday'], 'test edit')
      result.current.schedState.applyDayShifts('Monday', [])
    })
    expect(result.current.commandStack.canUndo()).toBe(true)
    expect(result.current.commandStack.canRedo()).toBe(false)
    act(() => result.current.commandStack.undo())
    expect(result.current.commandStack.canUndo()).toBe(false)
    expect(result.current.commandStack.canRedo()).toBe(true)
  })

  it('clear() empties both stacks (used after a data refresh)', () => {
    const result = setup()
    act(() => {
      result.current.commandStack.pushCommand('day', ['Monday'], 'test edit')
      result.current.schedState.applyDayShifts('Monday', [])
    })
    act(() => result.current.commandStack.clear())
    expect(result.current.commandStack.canUndo()).toBe(false)
    expect(result.current.commandStack.canRedo()).toBe(false)
  })
})
