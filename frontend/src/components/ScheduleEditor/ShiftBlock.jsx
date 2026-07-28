import { useRef, useState } from 'react'
import ShiftTooltip from './ShiftTooltip'

const SNAP = 30
const ROLE_OPACITY = { Attending: 1, PA: 0.62, Resident: 0.42 }
const HANDLE_PX = 6
const GAP = 1   // px gap between lanes

function snap(m) { return Math.round(m / SNAP) * SNAP }

function minsToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2,'0')}:${String(norm % 60).padStart(2,'0')}`
}

export default function ShiftBlock({ shift, color, hourPx, lane, numLanes, allDayShifts, onDelete, onUpdate, onBeforeDrag }) {
  const minsPerPx = 60 / hourPx
  const primaryRef = useRef(null)
  const contRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)

  const isOvernight = shift.endMins > 1440
  const opacity = ROLE_OPACITY[shift.role_type] ?? 1

  // Horizontal lane geometry (as CSS percentages + gap)
  const laneW = 100 / numLanes
  const xLeft  = `calc(${lane * laneW}% + ${GAP}px)`
  const xWidth = `calc(${laneW}% - ${GAP * 2}px)`

  // Vertical: primary fragment startMins → min(endMins, 1440)
  const primaryTop = (shift.startMins / 60) * hourPx
  const primaryH   = Math.max(((isOvernight ? 1440 : shift.endMins) - shift.startMins) / 60 * hourPx, 8)

  // Continuation fragment: 0 → endMins - 1440 (only when overnight)
  const wrapEnd = shift.endMins - 1440
  const wrapH   = isOvernight ? Math.max((wrapEnd / 60) * hourPx, 8) : 0

  function startDrag(e, mode) {
    e.stopPropagation()
    e.preventDefault()
    onBeforeDrag?.()
    const startY = e.clientY
    const s0 = shift.startMins, e0 = shift.endMins

    function onMove(me) {
      const delta = (me.clientY - startY) * minsPerPx
      let ns = s0, ne = e0
      if (mode === 'move')   { ns = snap(s0 + delta); ne = ns + (e0 - s0) }
      else if (mode === 'top')    { ns = snap(s0 + delta); if (ns >= ne - SNAP) ns = ne - SNAP }
      else if (mode === 'bottom') { ne = snap(e0 + delta); if (ne <= ns + SNAP) ne = ns + SNAP }
      onUpdate(shift.id, { startMins: ns, endMins: ne, start_time: minsToTime(ns), end_time: minsToTime(ne) })
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function hourFromPrimary(e) {
    const rect = primaryRef.current?.getBoundingClientRect()
    if (!rect) return null
    return Math.floor(shift.startMins / 60 + (e.clientY - rect.top) / hourPx)
  }
  function hourFromCont(e) {
    const rect = contRef.current?.getBoundingClientRect()
    if (!rect) return null
    return Math.floor((e.clientY - rect.top) / hourPx)
  }

  const baseStyle = {
    position: 'absolute',
    left: xLeft,
    width: xWidth,
    backgroundColor: color,
    opacity,
    borderRadius: 3,
    userSelect: 'none',
    overflow: 'visible',
  }

  function BlockLabel({ h }) {
    if (h < 16) return null
    return (
      <div className="px-0.5 py-0.5 text-white leading-tight overflow-hidden" style={{ fontSize: 8, pointerEvents: 'none' }}>
        <div className="font-semibold truncate">{shift.role_type}</div>
        {h > 28 && <div className="truncate opacity-75">{shift.role_detail}</div>}
      </div>
    )
  }

  return (
    <>
      {/* Continuation fragment — midnight-wrapping portion rendered at top of grid */}
      {isOvernight && (
        <div
          ref={contRef}
          style={{ ...baseStyle, top: 0, height: wrapH, borderTop: `2px solid ${color}`, cursor: 'grab' }}
          onMouseDown={e => startDrag(e, 'move')}
          onMouseMove={e => { const h = hourFromCont(e); if (h != null) setTooltip({ hour: h, fromCont: true, y: e.clientY - contRef.current.getBoundingClientRect().top }) }}
          onMouseLeave={() => setTooltip(null)}
        >
          <div
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: HANDLE_PX, cursor: 's-resize', zIndex: 2 }}
            onMouseDown={e => startDrag(e, 'bottom')}
          />
          <BlockLabel h={wrapH} />
          {tooltip?.fromCont && (
            <ShiftTooltip shift={shift} allDayShifts={allDayShifts} hoverHour={tooltip.hour} onUpdate={onUpdate}
              style={{ top: tooltip.y - 20, left: 4, zIndex: 100 }} />
          )}
        </div>
      )}

      {/* Primary fragment — startMins to end-of-day (or endMins if not overnight) */}
      <div
        ref={primaryRef}
        style={{
          ...baseStyle,
          top: primaryTop,
          height: primaryH,
          cursor: 'grab',
          borderBottom: isOvernight ? `2px solid ${color}` : undefined,
        }}
        onMouseMove={e => { const h = hourFromPrimary(e); if (h != null) setTooltip({ hour: h, fromCont: false, y: e.clientY - primaryRef.current.getBoundingClientRect().top }) }}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* top handle — change startMins */}
        <div
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: HANDLE_PX, cursor: 'n-resize', zIndex: 2 }}
          onMouseDown={e => startDrag(e, 'top')}
        />
        {/* body — move shift */}
        <div
          style={{ position: 'absolute', top: HANDLE_PX, left: 0, right: 0, bottom: HANDLE_PX, cursor: 'grab' }}
          onMouseDown={e => startDrag(e, 'move')}
        >
          <BlockLabel h={primaryH} />
        </div>
        {/* bottom handle — change endMins (non-overnight only; overnight uses cont fragment handle) */}
        {!isOvernight && (
          <div
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: HANDLE_PX, cursor: 's-resize', zIndex: 2 }}
            onMouseDown={e => startDrag(e, 'bottom')}
          />
        )}
        {/* delete button */}
        <button
          style={{
            position: 'absolute', top: 1, right: 2,
            lineHeight: 1, fontSize: 10, color: 'rgba(255,255,255,0.8)',
            background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', zIndex: 3,
          }}
          onClick={e => { e.stopPropagation(); onDelete(shift.id) }}
        >
          ×
        </button>
        {tooltip && !tooltip.fromCont && (
          <ShiftTooltip shift={shift} allDayShifts={allDayShifts} hoverHour={tooltip.hour} onUpdate={onUpdate}
            style={{ top: tooltip.y - 20, left: 4, zIndex: 100 }} />
        )}
      </div>
    </>
  )
}
