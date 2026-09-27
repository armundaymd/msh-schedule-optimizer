import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
    <label className="flex items-center gap-1 text-[11px] text-[var(--c-text-muted)]">
      {label}
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onFocus={e => e.target.select()}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
        onMouseDown={e => e.stopPropagation()}
        style={{ pointerEvents: 'auto' }}
        className="w-12 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1 py-0.5 text-[var(--c-text-strong)] text-center"
      />
    </label>
  )
}

// Portaled to document.body with position:fixed and clamped to the
// viewport. It used to be position:absolute inside Timeline's
// overflow-x-auto scroll container, which clips (not just visually hides)
// any descendant that extends past its bounds -- that's why it could go
// unreadable near the edges of the screen, not just cosmetically clipped.
//
// Two modes:
//   hover  — anchorX/anchorY (the cursor), read-only, pointer-events: none,
//            so it can never intercept the pointer or chase it.
//   pinned — anchored under anchorRef's element, editable (onUpdate), stays
//            open until onClose: Escape, the × button, or a mousedown
//            outside both the editor and ignoreRefs (the shift itself, so
//            dragging the selected shift doesn't close it). Re-anchors on
//            scroll/resize and when the shift moves.
export default function ShiftTooltip({
  shift, allDayShifts, hoverHour, anchorX, anchorY,
  pinned = false, anchorRef, ignoreRefs = [], onUpdate, onClose,
}) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  const place = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let ax, below, above
    if (pinned) {
      const a = anchorRef?.current?.getBoundingClientRect()
      if (!a) return
      ax = a.left; below = a.bottom + 4; above = a.top - rect.height - 4
    } else {
      if (anchorX == null || anchorY == null) return
      ax = anchorX + 14; below = anchorY + 14; above = anchorY - rect.height - 14
      if (ax + rect.width > window.innerWidth - VIEWPORT_MARGIN) ax = anchorX - rect.width - 14
    }
    let left = Math.min(ax, window.innerWidth - VIEWPORT_MARGIN - rect.width)
    let top = below + rect.height > window.innerHeight - VIEWPORT_MARGIN ? above : below
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
    if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN
    setPos(prev => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [pinned, anchorRef, anchorX, anchorY])

  useLayoutEffect(() => {
    place()
  }, [place, hoverHour, shift.startMins, shift.endMins, shift.team, shift.resident_level])

  // Pinned only: follow the shift through scrolling/resizing, and close on
  // Escape or an outside mousedown. Any focused field inside is blurred
  // first so its pending edit commits rather than being lost.
  useEffect(() => {
    if (!pinned) return
    function blurInside() {
      if (ref.current?.contains(document.activeElement)) document.activeElement.blur()
    }
    function onDown(e) {
      if (ref.current?.contains(e.target)) return
      if (ignoreRefs.some(r => r.current?.contains(e.target))) return
      blurInside()
      onClose?.()
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // ignoreRefs is a fresh array each render but holds stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, place, onClose])

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
      role={pinned ? 'dialog' : 'tooltip'}
      aria-label={pinned ? `Edit ${shift.role_type} shift` : undefined}
      style={{
        position: 'fixed', left: pos?.left ?? anchorX ?? 0, top: pos?.top ?? anchorY ?? 0,
        visibility: pos ? 'visible' : 'hidden', zIndex: 1000,
        pointerEvents: pinned ? 'auto' : 'none',
      }}
      className={`bg-[var(--c-bg-panel)] border rounded shadow-xl p-2 text-xs text-[var(--c-text-secondary)] w-48 ${
        pinned ? 'border-amber-400/70' : 'border-[var(--c-border-strong)]'
      }`}
      onMouseDown={e => e.stopPropagation()}
      // Portal events still bubble through the React tree; a click here must
      // not reach Timeline's click-to-deselect.
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-1 mb-1">
        <div className="font-semibold">{shift.role_type} — {shift.role_detail}</div>
        {pinned && (
          <button
            onClick={() => onClose?.()}
            aria-label="Close editor"
            title="Close (Esc)"
            className="shrink-0 -mt-0.5 px-1 text-[var(--c-text-muted)] hover:text-[var(--c-text-strong)]"
          >×</button>
        )}
      </div>
      {shift.role_type === 'Resident' && onUpdate && (
        <select
          value={shift.resident_level ?? shift.role_detail ?? 'PGY-2'}
          onMouseDown={e => e.stopPropagation()}
          onChange={e => onUpdate(shift.id, { role_detail: e.target.value, resident_level: e.target.value })}
          style={{ pointerEvents: 'auto' }}
          className="mb-2 w-full bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1 py-0.5 text-[var(--c-text-secondary)]"
        >
          {RESIDENT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      {onUpdate ? (
        <div className="flex items-center gap-1.5 mb-2" style={{ pointerEvents: 'auto' }}>
          <TimeField label="From" value={minsToDisplay(shift.startMins)} onCommit={commitStart} />
          <span className="text-[var(--c-text-faint)]">→</span>
          <TimeField label="" value={minsToDisplay(shift.endMins)} onCommit={commitEnd} />
        </div>
      ) : (
        <div className="text-[var(--c-text-muted)] mb-2">{minsToDisplay(shift.startMins)} → {minsToDisplay(shift.endMins)}</div>
      )}
      {!pinned && onUpdate == null && (
        <div className="text-[10px] text-[var(--c-text-faint)] mb-1.5">Click the shift to edit</div>
      )}
      <div className="border-t border-[var(--c-border)] pt-1 space-y-0.5">
        <div>At {String(hoverHour).padStart(2,'0')}:00</div>
        <div>Attending: <span className="text-[var(--c-text-strong)]">{attending}</span></div>
        <div>PA: <span className="text-[var(--c-text-strong)]">{pa}</span></div>
        <div>Resident: <span className="text-[var(--c-text-strong)]">{resident}</span></div>
      </div>
    </div>,
    document.body,
  )
}
