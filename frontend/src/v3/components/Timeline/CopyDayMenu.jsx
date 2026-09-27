import { useRef, useState, useEffect } from 'react'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday']
const WEEKEND = ['Saturday','Sunday']

// "Copy this day to..." (PHASE 5, 5.5) — the baseline has identical
// Monday-Friday, and without this every weekday change had to be repeated
// five times by hand.
export default function CopyDayMenu({ day, onCopyTo }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState([])
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function toggle(d) {
    setSelected(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])
  }

  function apply(days) {
    onCopyTo(days)
    setOpen(false)
    setSelected([])
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
      >
        Copy {day} to…
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl p-3 w-56">
          <div className="text-xs text-[var(--c-text-muted)] mb-1.5">Copy to specific days</div>
          <div className="grid grid-cols-2 gap-1 mb-2">
            {DAYS.filter(d => d !== day).map(d => (
              <label key={d} className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="checkbox" checked={selected.includes(d)} onChange={() => toggle(d)} />
                {d.slice(0, 3)}
              </label>
            ))}
          </div>
          <button
            onClick={() => apply(selected)}
            disabled={selected.length === 0}
            className="w-full text-xs py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white transition-colors mb-2"
          >
            Copy to selected
          </button>
          <div className="border-t border-[var(--c-border)] pt-2 flex flex-col gap-1.5">
            <button
              onClick={() => apply(WEEKDAYS.filter(d => d !== day))}
              className="text-xs text-left text-[var(--c-text-secondary)] hover:text-[var(--c-text-strong)] transition-colors"
            >
              Apply to all weekdays
            </button>
            <button
              onClick={() => apply(WEEKEND.filter(d => d !== day))}
              className="text-xs text-left text-[var(--c-text-secondary)] hover:text-[var(--c-text-strong)] transition-colors"
            >
              Apply to weekend
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
