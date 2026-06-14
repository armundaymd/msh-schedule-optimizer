import { useState, useCallback, useRef } from 'react'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const MAX_STACK = 50

function timeToMins(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minsToTime(m) {
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60)
  const mn = ((m % 1440) + 1440) % 1440 % 60
  return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`
}

function normalizeShifts(raw) {
  return raw.map((s, i) => ({
    ...s,
    id: `${s.day}-${s.team}-${s.role_type}-${i}`,
    startMins: timeToMins(s.start_time),
    endMins: timeToMins(s.end_time) <= timeToMins(s.start_time)
      ? timeToMins(s.end_time) + 1440
      : timeToMins(s.end_time),
  }))
}

export function useScheduleState() {
  const [baseline, setBaseline] = useState(null)
  const [proposed, setProposed] = useState({})
  const [stackVersion, setStackVersion] = useState(0)

  const undoStacks = useRef({})
  const redoStacks = useRef({})

  const loadBaseline = useCallback((rawShifts) => {
    const normalized = normalizeShifts(rawShifts)
    setBaseline(normalized)
    setProposed({})
    undoStacks.current = {}
    redoStacks.current = {}
    setStackVersion(v => v + 1)
  }, [])

  const getShiftsForDay = useCallback((day) => {
    if (proposed[day]) return proposed[day]
    if (!baseline) return []
    return baseline.filter(s => s.day === day)
  }, [baseline, proposed])

  const ensureProposed = useCallback((day) => {
    setProposed(prev => {
      if (prev[day]) return prev
      const dayShifts = baseline ? baseline.filter(s => s.day === day) : []
      return { ...prev, [day]: dayShifts }
    })
  }, [baseline])

  // Push a snapshot of day's shifts onto the undo stack (clears redo).
  // Caller is responsible for passing the current shifts array before mutation.
  const pushUndoForDay = useCallback((day, snapshot) => {
    const stack = undoStacks.current[day] ?? []
    undoStacks.current[day] = [...stack.slice(-(MAX_STACK - 1)), snapshot]
    redoStacks.current[day] = []
    setStackVersion(v => v + 1)
  }, [])

  const undoForDay = useCallback((day) => {
    const stack = undoStacks.current[day] ?? []
    if (!stack.length) return
    const prev = stack[stack.length - 1]
    undoStacks.current[day] = stack.slice(0, -1)
    setProposed(cur => {
      const current = cur[day] ?? (baseline?.filter(s => s.day === day) ?? [])
      redoStacks.current[day] = [...(redoStacks.current[day] ?? []).slice(-(MAX_STACK - 1)), current]
      return { ...cur, [day]: prev }
    })
    setStackVersion(v => v + 1)
  }, [baseline])

  const redoForDay = useCallback((day) => {
    const stack = redoStacks.current[day] ?? []
    if (!stack.length) return
    const next = stack[stack.length - 1]
    redoStacks.current[day] = stack.slice(0, -1)
    setProposed(cur => {
      const current = cur[day] ?? (baseline?.filter(s => s.day === day) ?? [])
      undoStacks.current[day] = [...(undoStacks.current[day] ?? []).slice(-(MAX_STACK - 1)), current]
      return { ...cur, [day]: next }
    })
    setStackVersion(v => v + 1)
  }, [baseline])

  // canUndo/canRedo read refs synchronously; stackVersion in deps forces recompute on change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const canUndo = useCallback((day) => (undoStacks.current[day]?.length ?? 0) > 0, [stackVersion])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const canRedo = useCallback((day) => (redoStacks.current[day]?.length ?? 0) > 0, [stackVersion])

  const updateShift = useCallback((day, id, patch) => {
    setProposed(prev => {
      const dayShifts = prev[day] ?? (baseline?.filter(s => s.day === day) ?? [])
      return {
        ...prev,
        [day]: dayShifts.map(s => s.id === id ? { ...s, ...patch } : s),
      }
    })
  }, [baseline])

  const addShift = useCallback((day, team, roleType = 'Attending') => {
    const id = `new-${Date.now()}`
    const roleDetail = roleType === 'Attending' ? 'Attending' : roleType === 'PA' ? 'PA' : 'Resident'
    const shift = {
      id,
      day,
      team,
      role_type: roleType,
      role_detail: roleDetail,
      start_time: '07:00',
      end_time: '15:00',
      startMins: 7 * 60,
      endMins: 15 * 60,
    }
    setProposed(prev => {
      const dayShifts = prev[day] ?? (baseline?.filter(s => s.day === day) ?? [])
      return { ...prev, [day]: [...dayShifts, shift] }
    })
  }, [baseline])

  const deleteShift = useCallback((day, id) => {
    setProposed(prev => {
      const dayShifts = prev[day] ?? (baseline?.filter(s => s.day === day) ?? [])
      return { ...prev, [day]: dayShifts.filter(s => s.id !== id) }
    })
  }, [baseline])

  const resetDay = useCallback((day) => {
    setProposed(prev => {
      const next = { ...prev }
      delete next[day]
      return next
    })
  }, [])

  const loadSnapshot = useCallback((snap) => {
    setProposed(snap)
    undoStacks.current = {}
    redoStacks.current = {}
    setStackVersion(v => v + 1)
  }, [])

  // Update a single day's shifts without touching undo stacks (used by optimizer)
  const applyDayShifts = useCallback((day, newShifts) => {
    setProposed(prev => ({ ...prev, [day]: newShifts }))
  }, [])

  return {
    baseline,
    proposed,
    loadBaseline,
    loadSnapshot,
    applyDayShifts,
    getShiftsForDay,
    ensureProposed,
    updateShift,
    addShift,
    deleteShift,
    resetDay,
    pushUndoForDay,
    undoForDay,
    redoForDay,
    canUndo,
    canRedo,
    DAYS,
    minsToTime,
  }
}
