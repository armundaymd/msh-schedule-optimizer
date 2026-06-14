function minsToDisplay(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2,'0')}:${String(norm % 60).padStart(2,'0')}`
}

// True if shift s is active during the clock-hour h (0–23), handling overnight shifts.
function shiftCoversHour(s, h) {
  const hStart = h * 60
  const hEnd = hStart + 60
  if (s.endMins <= 1440) {
    return s.startMins < hEnd && s.endMins > hStart
  }
  // Overnight: covers [startMins, 1440) ∪ [0, endMins-1440)
  const wrapEnd = s.endMins - 1440
  return s.startMins < hEnd || hStart < wrapEnd
}

export default function ShiftTooltip({ shift, allDayShifts, hoverHour, style }) {
  if (hoverHour == null) return null

  const teammates = allDayShifts.filter(s => s.team === shift.team && shiftCoversHour(s, hoverHour))
  const attending = teammates.filter(s => s.role_type === 'Attending').length
  const pa = teammates.filter(s => s.role_type === 'PA').length
  const resident = teammates.filter(s => s.role_type === 'Resident').length

  return (
    <div
      style={{ ...style, pointerEvents: 'none', zIndex: 100 }}
      className="absolute bg-slate-900 border border-slate-600 rounded shadow-xl p-2 text-xs text-slate-200 w-44"
    >
      <div className="font-semibold mb-1">{shift.role_type} — {shift.role_detail}</div>
      <div className="text-slate-400 mb-2">{minsToDisplay(shift.startMins)} → {minsToDisplay(shift.endMins)}</div>
      <div className="border-t border-slate-700 pt-1 space-y-0.5">
        <div>At {String(hoverHour).padStart(2,'0')}:00</div>
        <div>Attending: <span className="text-white">{attending}</span></div>
        <div>PA: <span className="text-white">{pa}</span></div>
        <div>Resident: <span className="text-white">{resident}</span></div>
      </div>
    </div>
  )
}
