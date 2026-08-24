import { useCallback, useEffect, useRef, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import ShiftTooltip from './ShiftTooltip'

const ROLE_OPACITY = { Attending: 1, PA: 0.62, Resident: 0.42 }
const HANDLE_PX = 6
const GAP = 1

// Fixed white, not themed: this sits on the shift block's own team color
// (always a fairly dark, saturated fill regardless of app theme), not on
// the page background, so it must stay legible against that color rather
// than switching to near-black text in light mode.
function ShiftLabel({ roleType, roleDetail }) {
  return (
    <div className="px-1 leading-tight overflow-hidden whitespace-nowrap text-white" style={{ fontSize: 9, pointerEvents: 'none' }}>
      <span className="font-semibold">{roleType}</span>
      {roleDetail && <span className="opacity-75"> · {roleDetail}</span>}
    </div>
  )
}

// One unified drag system (PHASE 5, 5.3): every gesture — move, resize-start,
// resize-end — is a dnd-kit draggable, distinguished by `mode` in its drag
// data. ScheduleEditor/index.jsx's DndContext branches on that mode to
// interpret delta.x. This replaces dnd-kit-for-move + raw window.mousemove
// listeners-for-resize, which used to fight over the cursor mid-drag (the
// old `*, *:hover { cursor: grabbing !important }` stylesheet hack existed
// only because of that fight — gone now that one system owns both).
export default function ShiftBlock({
  shift, color, hourPx, lane, numLanes, laneHeight, allDayShifts,
  onDelete, onUpdate, selected, onSelect,
}) {
  const primaryRef = useRef(null)
  const contRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)
  const hideTimeoutRef = useRef(null)

  // Small grace period before hiding: without it, moving the pointer from
  // the shift onto the (now portaled, so visually detached) tooltip to use
  // its time fields would immediately hide the tooltip out from under the
  // cursor.
  function showTooltipAt(hour, clientX, clientY) {
    if (hideTimeoutRef.current) { clearTimeout(hideTimeoutRef.current); hideTimeoutRef.current = null }
    setTooltip({ hour, clientX, clientY })
  }
  function scheduleHideTooltip() {
    hideTimeoutRef.current = setTimeout(() => setTooltip(null), 150)
  }
  function cancelHideTooltip() {
    if (hideTimeoutRef.current) { clearTimeout(hideTimeoutRef.current); hideTimeoutRef.current = null }
  }
  useEffect(() => () => { if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current) }, [])

  const { setNodeRef: setMoveRef, listeners: moveListeners, attributes: moveAttrs, isDragging: movingThis } =
    useDraggable({ id: `${shift.id}::move`, data: { shift, mode: 'move', lane, numLanes } })
  const { setNodeRef: setStartRef, listeners: startListeners, attributes: startAttrs, isDragging: resizingStart } =
    useDraggable({ id: `${shift.id}::start`, data: { shift, mode: 'resize-start', lane, numLanes } })
  const { setNodeRef: setEndRef, listeners: endListeners, attributes: endAttrs, isDragging: resizingEnd } =
    useDraggable({ id: `${shift.id}::end`, data: { shift, mode: 'resize-end', lane, numLanes } })
  const isDragging = movingThis || resizingStart || resizingEnd

  const setRefs = useCallback(node => {
    primaryRef.current = node
    setMoveRef(node)
  }, [setMoveRef])

  const isOvernight = shift.endMins > 1440
  const opacity = ROLE_OPACITY[shift.role_type] ?? 1

  const yTop = lane * laneHeight
  const yHeight = laneHeight - GAP

  const primaryLeft = (shift.startMins / 60) * hourPx
  const primaryW = Math.max(((isOvernight ? 1440 : shift.endMins) - shift.startMins) / 60 * hourPx, 6)
  const wrapEnd = shift.endMins - 1440
  const wrapW = isOvernight ? Math.max((wrapEnd / 60) * hourPx, 6) : 0

  function hourFromX(el, clientX) {
    const rect = el?.getBoundingClientRect()
    if (!rect) return null
    return Math.floor((clientX - rect.left) / hourPx)
  }

  const baseStyle = {
    position: 'absolute',
    top: yTop,
    height: yHeight,
    backgroundColor: color,
    opacity,
    borderRadius: 3,
    userSelect: 'none',
    overflow: 'visible',
    outline: (selected || isDragging) ? '2px solid #fbbf24' : undefined,
    outlineOffset: -1,
    filter: isDragging ? 'brightness(1.5) saturate(1.4)' : undefined,
  }

  return (
    <>
      {isOvernight && (
        <div
          ref={contRef}
          style={{ ...baseStyle, left: 0, width: wrapW, borderLeft: `2px solid ${color}` }}
          onMouseMove={e => { const h = hourFromX(contRef.current, e.clientX); if (h != null) showTooltipAt(h, e.clientX, e.clientY) }}
          onMouseLeave={scheduleHideTooltip}
        >
          <div
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, right: HANDLE_PX, cursor: isDragging ? 'grabbing' : 'grab' }}
            onClick={e => { e.stopPropagation(); onSelect?.(shift.id) }}
            {...moveListeners} {...moveAttrs}
          >
            <ShiftLabel roleType={shift.role_type} roleDetail={shift.role_detail} />
          </div>
          <div
            ref={setEndRef}
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: HANDLE_PX, cursor: 'ew-resize', zIndex: 2 }}
            {...endListeners} {...endAttrs}
          />
          {tooltip && (
            <ShiftTooltip shift={shift} allDayShifts={allDayShifts} hoverHour={tooltip.hour}
              anchorX={tooltip.clientX} anchorY={tooltip.clientY} onUpdate={onUpdate}
              onMouseEnter={cancelHideTooltip} onMouseLeave={scheduleHideTooltip} />
          )}
        </div>
      )}

      <div
        ref={setRefs}
        style={{ ...baseStyle, left: primaryLeft, width: primaryW, borderRight: isOvernight ? `2px solid ${color}` : undefined }}
        onMouseMove={e => { const h = hourFromX(primaryRef.current, e.clientX); if (h != null) showTooltipAt(h, e.clientX, e.clientY) }}
        onMouseLeave={scheduleHideTooltip}
      >
        <div
          ref={setStartRef}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: HANDLE_PX, cursor: 'ew-resize', zIndex: 2 }}
          {...startListeners} {...startAttrs}
        />
        <div
          style={{ position: 'absolute', left: HANDLE_PX, top: 0, bottom: isOvernight ? 0 : HANDLE_PX, right: isOvernight ? 0 : HANDLE_PX, cursor: isDragging ? 'grabbing' : 'grab' }}
          onClick={e => { e.stopPropagation(); onSelect?.(shift.id) }}
          {...moveListeners} {...moveAttrs}
        >
          <ShiftLabel roleType={shift.role_type} roleDetail={shift.role_detail} />
        </div>
        {!isOvernight && (
          <div
            ref={setEndRef}
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: HANDLE_PX, cursor: 'ew-resize', zIndex: 2 }}
            {...endListeners} {...endAttrs}
          />
        )}
        <button
          style={{
            position: 'absolute', top: 0, right: 1,
            lineHeight: 1, fontSize: 10, color: 'rgba(255,255,255,0.8)',
            background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', zIndex: 3,
          }}
          onClick={e => { e.stopPropagation(); onDelete(shift.id) }}
        >
          ×
        </button>
        {tooltip && (
          <ShiftTooltip shift={shift} allDayShifts={allDayShifts} hoverHour={tooltip.hour}
            anchorX={tooltip.clientX} anchorY={tooltip.clientY} onUpdate={onUpdate}
            onMouseEnter={cancelHideTooltip} onMouseLeave={scheduleHideTooltip} />
        )}
      </div>
    </>
  )
}
