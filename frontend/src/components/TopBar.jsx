import { useRef, useState, useEffect } from 'react'

export default function TopBar({ summary, onRefresh, refreshing, onResetDay, onSaveScenario, scenarioCount, onUndo, onRedo, canUndo, canRedo, onAutoOptimize, optimizing }) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [name, setName] = useState('')
  const popoverRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!popoverOpen) return
    setName(`Scenario ${scenarioCount + 1}`)
    setTimeout(() => inputRef.current?.select(), 0)
    function onDown(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setPopoverOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [popoverOpen, scenarioCount])

  function confirm() {
    if (!name.trim()) return
    onSaveScenario(name.trim())
    setPopoverOpen(false)
  }

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-slate-700 shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-white font-semibold text-sm tracking-wide">ED Staffing</span>
        {summary && (
          <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
            {summary.total_encounters.toLocaleString()} encounters · {summary.date_range} · {summary.unique_days} days
          </span>
        )}
      </div>
      <div className="flex gap-2 items-center">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
          className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 transition-colors"
        >
          ↩
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
          className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 transition-colors"
        >
          ↪
        </button>
        <button
          onClick={onResetDay}
          className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
        >
          Reset day
        </button>
        <div className="relative" ref={popoverRef}>
          <button
            onClick={() => setPopoverOpen(v => !v)}
            disabled={scenarioCount >= 5}
            className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 transition-colors"
          >
            Save scenario
          </button>
          {popoverOpen && (
            <div className="absolute right-0 top-8 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl p-3 w-52">
              <div className="text-xs text-slate-400 mb-1.5">Scenario name</div>
              <input
                ref={inputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && confirm()}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 outline-none focus:border-blue-500 mb-2"
              />
              <button
                onClick={confirm}
                className="w-full text-xs py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
              >
                Save
              </button>
            </div>
          )}
        </div>
        <button
          onClick={onAutoOptimize}
          disabled={optimizing}
          className="text-xs px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white transition-colors"
        >
          {optimizing ? '⚡ Optimizing…' : '⚡ Auto-optimize'}
        </button>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white transition-colors"
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh data'}
        </button>
      </div>
    </div>
  )
}
