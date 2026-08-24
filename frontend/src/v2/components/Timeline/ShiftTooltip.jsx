import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { shiftCoversHour } from '../../../shared/capacity'

function minsToDisplay(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2,'0')}:${String(norm % 60).padStart(2,'0')}`
}

function timeToMins(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

const RESIDENT_LEVELS = ['PGY-1', 'PGY-2', 'PGY-3', 'PGY-4', 'Off-Service']
const SNAP = 30
const VIEWPORT_MARGIN = 8

// Editable numeric start/end time fields — ShiftTooltip previously exposed
// a resident-level dropdown but not times, so every time edit had to be a
// drag (PHASE 5, 5.6).
function TimeField({ label, value, onCommit }) {
  const [text, setText] = useState(value)
  const [synced, setSynced] = useState(value)
  if (value !== synced) { setSynced(value); setText(value) }

  function commit() {
    if (!/^\d{1,2}:\d{2}$/.test(text)) { setText(value); return }
    const mins = Math.round(timeToMins(text) / SNAP) * SNAP
    const clamped = ((mins % 1440) + 1440) % 1440
    const normalized = minsToDisplay(clamped)
    setText(normalized)
    if (normalized !== value) onCommit(clamped)
  }

  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      {label}
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onFocus={e => e.target.select()}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
        onMouseDown={e => e.stopPropagation()}
        style={{ pointerEvents: 'auto' }}
        className="w-12 bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-slate-100 text-center"
      />
    </label>
  )
}

// Portaled to document.body with position:fixed and clamped to the
// viewport. It used to be position:absolute inside Timeline's
// overflow-x-auto scroll container, which clips (not just visually hides)
// any descendant that extends past its bounds -- that's why it could go
// unreadable near the edges of the screen, not just cosmetically clipped.
export default function ShiftTooltip({ shift, allDayShifts, hoverHour, anchorX, anchorY, onUpdate, onMouseEnter, onMouseLeave }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || anchorX == null || anchorY == null) return
    const rect = el.getBoundingClientRect()
    let left = anchorX + 14
    let top = anchorY + 14
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN) left = anchorX - rect.width - 14
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) top = anchorY - rect.height - 14
    if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN
    setPos({ left, top })
  }, [anchorX, anchorY, hoverHour, shift.startMins, shift.endMins, shift.resident_level])

  if (hoverHour == null) return null

  const teammates = allDayShifts.filter(s => s.team === shift.team && shiftCoversHour(s, hoverHour))
  const attending = teammates.filter(s => s.role_type === 'Attending').length
  const pa = teammates.filter(s => s.role_type === 'PA').length
  const resident = teammates.filter(s => s.role_type === 'Resident').length

  function commitStart(mins) {
    const duration = shift.endMins - shift.startMins
    onUpdate(shift.id, { startMins: mins, endMins: mins + duration, start_time: minsToDisplay(mins), end_time: minsToDisplay(mins + duration) })
  }
  function commitEnd(mins) {
    let endMins = mins
    if (endMins <= shift.startMins) endMins += 1440
    onUpdate(shift.id, { endMins, end_time: minsToDisplay(endMins % 1440) })
  }

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos?.left ?? anchorX, top: pos?.top ?? anchorY, visibility: pos ? 'visible' : 'hidden', zIndex: 1000 }}
      className="bg-slate-900 border border-slate-600 rounded shadow-xl p-2 text-xs text-slate-200 w-48"
      onMouseDown={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="font-semibold mb-1">{shift.role_type} — {shift.role_detail}</div>
      {shift.role_type === 'Resident' && onUpdate && (
        <select
          value={shift.resident_level ?? shift.role_detail ?? 'PGY-2'}
          onMouseDown={e => e.stopPropagation()}
          onChange={e => onUpdate(shift.id, { role_detail: e.target.value, resident_level: e.target.value })}
          style={{ pointerEvents: 'auto' }}
          className="mb-2 w-full bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-slate-200"
        >
          {RESIDENT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      {onUpdate ? (
        <div className="flex items-center gap-1.5 mb-2" style={{ pointerEvents: 'auto' }}>
          <TimeField label="From" value={minsToDisplay(shift.startMins)} onCommit={commitStart} />
          <span className="text-slate-600">→</span>
          <TimeField label="" value={minsToDisplay(shift.endMins)} onCommit={commitEnd} />
        </div>
      ) : (
        <div className="text-slate-400 mb-2">{minsToDisplay(shift.startMins)} → {minsToDisplay(shift.endMins)}</div>
      )}
      <div className="border-t border-slate-700 pt-1 space-y-0.5">
        <div>At {String(hoverHour).padStart(2,'0')}:00</div>
        <div>Attending: <span className="text-white">{attending}</span></div>
        <div>PA: <span className="text-white">{pa}</span></div>
        <div>Resident: <span className="text-white">{resident}</span></div>
      </div>
    </div>,
    document.body,
  )
}
