import { useState, useRef, useEffect } from 'react'
import { useDroppable } from '@dnd-kit/core'
import ShiftBlock from './ShiftBlock'
import { LANE_HEIGHT, ROW_HEADER_W, assignLanes } from './layout'

const ROLES = ['Attending', 'PA', 'Resident']
const RESIDENT_LEVELS = ['PGY-1', 'PGY-2', 'PGY-3', 'PGY-4', 'Off-Service']

const COLLAPSED_H = 22

export default function TeamRow({
  team, color, shifts, allDayShifts, hourPx, totalW, onAdd, onDelete, onUpdate,
  dragPreview, isCustom, onRemove, selectedId, onSelect, hoverHour,
  hidden, onToggleHidden,
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [residentSubmenu, setResidentSubmenu] = useState(false)
  const pickerRef = useRef(null)

  function closePicker() {
    setPickerOpen(false)
    setResidentSubmenu(false)
  }

  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e) { if (pickerRef.current && !pickerRef.current.contains(e.target)) closePicker() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const { lanes, numLanes } = assignLanes(shifts)
  const rowH = numLanes * LANE_HEIGHT
  const { setNodeRef, isOver } = useDroppable({ id: team })

  const eyeButton = (
    <button
      onClick={e => { e.stopPropagation(); onToggleHidden?.(team) }}
      title={hidden ? `Show ${team}` : `Hide ${team}`}
      style={{ fontSize: 11, color: 'var(--c-text-muted)', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}
    >
      👁
    </button>
  )

  // Collapsed: just the team name + eye button, no timeline content — lets
  // you hide teams you don't care about right now (e.g. FastTrack/ERU while
  // focused on Main), which also shrinks the row list's total height.
  if (hidden) {
    return (
      <div className="flex items-center border-b border-[var(--c-border-subtle)] opacity-50" style={{ height: COLLAPSED_H }}>
        <div className="shrink-0 flex items-center gap-2 px-2 text-xs font-semibold" style={{ width: ROW_HEADER_W, color }}>
          {eyeButton}
          <span className="truncate">{team}</span>
        </div>
        <div className="text-[10px] text-[var(--c-text-faint)] px-2">hidden</div>
      </div>
    )
  }

  return (
    <div className="flex border-b border-[var(--c-border-subtle)]">
      {/* row header */}
      <div
        className="shrink-0 flex items-center justify-between px-2 text-xs font-semibold"
        style={{ width: ROW_HEADER_W, height: rowH, color, borderRight: `1px solid ${color}40` }}
      >
        <span className="truncate">{team}</span>
        <div className="flex items-center gap-1">
          {eyeButton}
          {isCustom && (
            <button
              onClick={e => { e.stopPropagation(); onRemove?.() }}
              style={{ fontSize: 10, color: 'var(--c-text-faint)', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}
              title={`Remove ${team}`}
            >
              ×
            </button>
          )}
          <div ref={pickerRef} className="relative">
            <button
              onClick={() => { setPickerOpen(v => !v); setResidentSubmenu(false) }}
              style={{ color, border: `1px solid ${color}`, borderRadius: 3 }}
              className="text-xs px-1 hover:opacity-80 leading-4"
            >
              +
            </button>
            {pickerOpen && !residentSubmenu && (
              <div className="absolute left-0 top-6 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl py-1 w-28">
                {ROLES.map(role => (
                  <button
                    key={role}
                    onClick={() => { if (role === 'Resident') setResidentSubmenu(true); else { onAdd(role); closePicker() } }}
                    className="block w-full text-left px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-btn-bg)] transition-colors"
                  >
                    {role}
                  </button>
                ))}
              </div>
            )}
            {pickerOpen && residentSubmenu && (
              <div className="absolute left-0 top-6 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl py-1 w-28">
                {RESIDENT_LEVELS.map(level => (
                  <button
                    key={level}
                    onClick={() => { onAdd('Resident', level); closePicker() }}
                    className="block w-full text-left px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-btn-bg)] transition-colors"
                  >
                    {level}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* timeline row */}
      <div
        ref={setNodeRef}
        className="relative transition-colors"
        style={{
          width: totalW, height: rowH,
          background: isOver ? 'rgba(59,130,246,0.10)' : undefined,
          boxShadow: isOver ? 'inset 0 0 0 2px rgba(59,130,246,0.5)' : undefined,
        }}
      >
        {/* hour grid lines */}
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} style={{ position: 'absolute', left: h * hourPx, top: 0, bottom: 0, width: 1, background: '#1e293b' }} />
        ))}
        {hoverHour != null && (
          <div style={{ position: 'absolute', left: hoverHour * hourPx, top: 0, bottom: 0, width: hourPx, background: 'rgba(96,165,250,0.08)', pointerEvents: 'none' }} />
        )}

        {/* drop-position preview */}
        {dragPreview && dragPreview.segments.map((seg, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: seg.left, width: seg.width,
              top: dragPreview.lane * LANE_HEIGHT, height: LANE_HEIGHT - 1,
              background: color, opacity: 0.3, border: `2px dashed ${color}`, borderRadius: 3,
              pointerEvents: 'none', zIndex: 5,
            }}
          />
        ))}

        {shifts.map(shift => (
          <ShiftBlock
            key={shift.id}
            shift={shift}
            color={color}
            hourPx={hourPx}
            lane={lanes[shift.id] ?? 0}
            numLanes={numLanes}
            laneHeight={LANE_HEIGHT}
            allDayShifts={allDayShifts}
            onDelete={onDelete}
            onUpdate={onUpdate}
            selected={selectedId === shift.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}
