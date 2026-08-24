import { useRef, useState, useEffect } from 'react'
import PillToggle from '../../shared/components/PillToggle'

export default function SettingsMenu({ theme, onThemeChange, costModeEnabled, onToggleCostMode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Settings"
        className="text-xs px-2.5 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
      >
        ⚙
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl p-3 w-56">
          <div className="text-xs text-[var(--c-text-muted)] mb-1.5">Theme</div>
          <div className="flex rounded overflow-hidden border border-[var(--c-border-strong)] mb-3">
            {['light', 'dark'].map(t => (
              <button
                key={t}
                onClick={() => onThemeChange(t)}
                className={`flex-1 px-2 py-1 text-xs font-medium capitalize transition-colors ${
                  theme === t ? 'bg-blue-700 text-[var(--c-text-strong)]' : 'bg-[var(--c-btn-bg)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--c-text-muted)] select-none">💰 Cost modeling</span>
            <PillToggle checked={!!costModeEnabled} onChange={onToggleCostMode} />
          </div>
        </div>
      )}
    </div>
  )
}
