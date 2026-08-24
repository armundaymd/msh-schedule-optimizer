import { useCallback, useRef, useState } from 'react'

// One command stack for v2, tagged by scope (day/week/global), so Cmd-Z
// behaves the same regardless of what produced the change -- a single shift
// drag, a week-wide auto-optimize, or a schedule generation. Replaces the
// per-day undo stacks in shared/hooks/useScheduleState (still used for their
// data operations: getShiftsForDay/applyDayShifts/etc, just not their own
// undo/redo, which legacy keeps using unchanged).
//
// A command captures a snapshot of every affected day's shifts BEFORE the
// change. Undo restores that snapshot (and pushes the current state onto
// the redo stack); redo does the reverse.
export function useCommandStack(schedState) {
  const undoStack = useRef([]) // [{ scope, days, label, snapshot: { day: shift[] } }]
  const redoStack = useRef([])
  const [version, setVersion] = useState(0)

  // Call BEFORE mutating. days: array of day names this command will touch.
  const pushCommand = useCallback((scope, days, label) => {
    const snapshot = {}
    for (const day of days) snapshot[day] = schedState.getShiftsForDay(day)
    undoStack.current = [...undoStack.current.slice(-49), { scope, days, label, snapshot }]
    redoStack.current = []
    setVersion(v => v + 1)
  }, [schedState])

  const undo = useCallback(() => {
    const cmd = undoStack.current[undoStack.current.length - 1]
    if (!cmd) return
    undoStack.current = undoStack.current.slice(0, -1)
    const redoSnapshot = {}
    for (const day of cmd.days) redoSnapshot[day] = schedState.getShiftsForDay(day)
    redoStack.current = [...redoStack.current, { ...cmd, snapshot: redoSnapshot }]
    for (const day of cmd.days) schedState.applyDayShifts(day, cmd.snapshot[day])
    setVersion(v => v + 1)
  }, [schedState])

  const redo = useCallback(() => {
    const cmd = redoStack.current[redoStack.current.length - 1]
    if (!cmd) return
    redoStack.current = redoStack.current.slice(0, -1)
    const undoSnapshot = {}
    for (const day of cmd.days) undoSnapshot[day] = schedState.getShiftsForDay(day)
    undoStack.current = [...undoStack.current, { ...cmd, snapshot: undoSnapshot }]
    for (const day of cmd.days) schedState.applyDayShifts(day, cmd.snapshot[day])
    setVersion(v => v + 1)
  }, [schedState])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const canUndo = useCallback(() => undoStack.current.length > 0, [version])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const canRedo = useCallback(() => redoStack.current.length > 0, [version])

  const clear = useCallback(() => {
    undoStack.current = []
    redoStack.current = []
    setVersion(v => v + 1)
  }, [])

  return { pushCommand, undo, redo, canUndo, canRedo, clear }
}
