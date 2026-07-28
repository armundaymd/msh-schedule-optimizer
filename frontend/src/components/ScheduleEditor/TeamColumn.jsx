import { useState, useRef, useEffect } from 'react'
import ShiftBlock from './ShiftBlock'

const ROLES = ['Attending', 'PA', 'Resident']
const RESIDENT_LEVELS = ['PGY-1', 'PGY-2', 'PGY-3', 'PGY-4', 'Off-Service']

// True if two shifts share at least one minute on the 24-h clock.
// endMins > 1440 means the shift wraps past midnight.
function overlaps(a, b) {
  const aON = a.endMins > 1440
  const bON = b.endMins > 1440
  if (!aON && !bON) {
    return a.startMins < b.endMins && a.endMins > b.startMins
  }
  if (aON && bON) return true   // both cross midnight → share 00:00
  const [on, off] = aON ? [a, b] : [b, a]
  const wrapEnd = on.endMins - 1440
  // overnight covers [on.start, 1440) ∪ [0, wrapEnd)
  return on.startMins < off.endMins || wrapEnd > off.startMins
}

// Greedy interval-graph colouring: sort by startMins, assign minimum lane
// that doesn't conflict with already-placed shifts.
function assignLanes(shifts) {
  if (!shifts.length) return { lanes: {}, numLanes: 1 }
  const sorted = [...shifts].sort((a, b) => a.startMins - b.startMins)
  const lanes = {}

  for (const s of sorted) {
    const usedLanes = new Set(
      sorted
        .filter(o => o.id !== s.id && lanes[o.id] !== undefined && overlaps(s, o))
        .map(o => lanes[o.id])
    )
    let lane = 0
    while (usedLanes.has(lane)) lane++
    lanes[s.id] = lane
  }

  const numLanes = Math.max(...Object.values(lanes)) + 1
  return { lanes, numLanes }
}

export default function TeamColumn({ team, color, shifts, allDayShifts, hourPx, totalH, onAdd, onDelete, onUpdate, onBeforeDrag, isCustom, onRemove }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [residentSubmenu, setResidentSubmenu] = useState(false)
  const pickerRef = useRef(null)

  function closePicker() {
    setPickerOpen(false)
    setResidentSubmenu(false)
  }

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e) { if (pickerRef.current && !pickerRef.current.contains(e.target)) closePicker() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const { lanes, numLanes } = assignLanes(shifts)

  return (
    <div className="flex-1 min-w-0 border-l border-slate-800 flex flex-col">
      {/* header */}
      <div
        className="flex items-center justify-between px-1 py-1 text-xs font-semibold shrink-0 relative"
        style={{ height: 32, color, borderBottom: `1px solid ${color}40` }}
      >
        <span className="truncate flex-1">{team}</span>
        {isCustom && (
          <button
            onClick={e => { e.stopPropagation(); onRemove?.() }}
            style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
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
            <div className="absolute right-0 top-6 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl py-1 w-28">
              {ROLES.map(role => (
                <button
                  key={role}
                  onClick={() => {
                    if (role === 'Resident') setResidentSubmenu(true)
                    else { onAdd(role); closePicker() }
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
                >
                  {role}
                </button>
              ))}
            </div>
          )}

          {pickerOpen && residentSubmenu && (
            <div className="absolute right-0 top-6 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl py-1 w-28">
              {RESIDENT_LEVELS.map(level => (
                <button
                  key={level}
                  onClick={() => { onAdd('Resident', level); closePicker() }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
                >
                  {level}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* timeline */}
      <div className="relative" style={{ height: totalH }}>
        {/* hour grid lines */}
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            style={{ position: 'absolute', top: h * hourPx, left: 0, right: 0, height: 1, background: '#1e293b' }}
          />
        ))}

        {/* shift blocks — positioned by lane */}
        {shifts.map(shift => (
          <ShiftBlock
            key={shift.id}
            shift={shift}
            color={color}
            hourPx={hourPx}
            lane={lanes[shift.id] ?? 0}
            numLanes={numLanes}
            allDayShifts={allDayShifts}
            onDelete={onDelete}
            onUpdate={onUpdate}
            onBeforeDrag={onBeforeDrag}
          />
        ))}
      </div>
    </div>
  )
}
