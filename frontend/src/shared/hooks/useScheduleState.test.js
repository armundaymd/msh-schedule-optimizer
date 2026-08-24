// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useScheduleState } from './useScheduleState'

const RAW = [
  { day: 'Monday', team: 'Green', role_type: 'Attending', role_detail: 'Attending', resident_level: null, start_time: '07:00', end_time: '15:00' },
  { day: 'Monday', team: 'Red',   role_type: 'Attending', role_detail: 'Attending', resident_level: null, start_time: '07:00', end_time: '15:00' },
  { day: 'Tuesday', team: 'Green', role_type: 'Attending', role_detail: 'Attending', resident_level: null, start_time: '07:00', end_time: '15:00' },
]

describe('clearDay / clearWeek', () => {
  it('clearDay empties one day only, and Cmd-Z (undoForDay) restores it', () => {
    const { result } = renderHook(() => useScheduleState())
    act(() => result.current.loadBaseline(RAW))

    expect(result.current.getShiftsForDay('Monday')).toHaveLength(2)

    act(() => result.current.clearDay('Monday'))
    expect(result.current.getShiftsForDay('Monday')).toHaveLength(0)
    expect(result.current.getShiftsForDay('Tuesday')).toHaveLength(1) // untouched

    act(() => result.current.undoForDay('Monday'))
    expect(result.current.getShiftsForDay('Monday')).toHaveLength(2)
  })

  it('clearWeek empties every day, and each day can be undone independently', () => {
    const { result } = renderHook(() => useScheduleState())
    act(() => result.current.loadBaseline(RAW))

    act(() => result.current.clearWeek())
    expect(result.current.getShiftsForDay('Monday')).toHaveLength(0)
    expect(result.current.getShiftsForDay('Tuesday')).toHaveLength(0)
    expect(result.current.getShiftsForDay('Wednesday')).toHaveLength(0)

    act(() => result.current.undoForDay('Tuesday'))
    expect(result.current.getShiftsForDay('Tuesday')).toHaveLength(1)
    expect(result.current.getShiftsForDay('Monday')).toHaveLength(0) // still cleared
  })
})
