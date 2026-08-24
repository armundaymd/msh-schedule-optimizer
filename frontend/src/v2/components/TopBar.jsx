import { useRef, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import ConfirmDialog from '../../shared/components/ConfirmDialog'
import SettingsMenu from './SettingsMenu'

export default function TopBar({ summary, onRefresh, refreshing, onResetDay, onSaveScenario, scenarioCount, onUndo, onRedo, canUndo, canRedo, onAutoOptimize, onAutoOptimizeWeek, optimizing, onExport, activeTeam, onClearDay, onClearWeek, onOpenGenerator, onOpenScenarios, theme, onThemeChange, costModeEnabled, onToggleCostMode }) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [name, setName] = useState('')
  const popoverRef = useRef(null)
  const inputRef = useRef(null)

  const [clearConfirm, setClearConfirm] = useState(null) // null | 'day' | 'week'

  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useRef(null)

  const [optimizeMenuOpen, setOptimizeMenuOpen] = useState(false)
  const optimizeMenuRef = useRef(null)

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

  useEffect(() => {
    if (!exportOpen) return
    function onDown(e) { if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [exportOpen])

  useEffect(() => {
    if (!optimizeMenuOpen) return
    function onDown(e) { if (optimizeMenuRef.current && !optimizeMenuRef.current.contains(e.target)) setOptimizeMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [optimizeMenuOpen])

  function confirm() {
    if (!name.trim()) return
    onSaveScenario(name.trim())
    setPopoverOpen(false)
  }

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-[var(--c-bg-panel)] border-b border-[var(--c-border)] shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-[var(--c-text-strong)] font-semibold text-sm tracking-wide">ED Staffing</span>
        <Link
          to="/"
          title="Back to version chooser"
          className="text-[10px] font-semibold uppercase tracking-wide text-[var(--c-text-secondary)] bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] px-1.5 py-0.5 rounded transition-colors"
        >
          v2
        </Link>
        {summary && (
          <span className="text-xs text-[var(--c-text-muted)] bg-[var(--c-bg-surface)] px-2 py-0.5 rounded">
            {summary.total_encounters.toLocaleString()} encounters · {summary.date_range} · {summary.unique_days} days
          </span>
        )}
      </div>
      <div className="flex gap-2 items-center">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
          className="text-xs px-2 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] disabled:opacity-40 text-[var(--c-text-secondary)] transition-colors"
        >
          ↩
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
          className="text-xs px-2 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] disabled:opacity-40 text-[var(--c-text-secondary)] transition-colors"
        >
          ↪
        </button>
        <button
          onClick={onResetDay}
          className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
        >
          Reset day
        </button>
        <button
          onClick={() => setClearConfirm('day')}
          title="Clear this day to blank (different from Reset day, which reverts to baseline)"
          className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
        >
          Clear day
        </button>
        <button
          onClick={() => setClearConfirm('week')}
          title="Clear every day this week to blank"
          className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
        >
          Clear week
        </button>
        <button
          onClick={onOpenGenerator}
          className="text-xs px-3 py-1 rounded bg-teal-700 hover:bg-teal-600 text-white transition-colors"
        >
          ✦ Generate schedule
        </button>
        <button
          onClick={onOpenScenarios}
          className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
        >
          📊 Scenarios ({scenarioCount})
        </button>
        <div className="relative" ref={popoverRef}>
          <button
            onClick={() => setPopoverOpen(v => !v)}
            disabled={scenarioCount >= 5}
            className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] disabled:opacity-40 text-[var(--c-text-secondary)] transition-colors"
          >
            Save scenario
          </button>
          {popoverOpen && (
            <div className="absolute right-0 top-8 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl p-3 w-52">
              <div className="text-xs text-[var(--c-text-muted)] mb-1.5">Scenario name</div>
              <input
                ref={inputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && confirm()}
                className="w-full bg-[var(--c-btn-bg)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)] outline-none focus:border-blue-500 mb-2"
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
        <div className="relative flex" ref={optimizeMenuRef}>
          <button
            onClick={onAutoOptimize}
            disabled={optimizing}
            title={`Auto-optimize ${activeTeam ?? 'Main'} for this day (uses the area selected in the chart tab)`}
            className="text-xs px-3 py-1 rounded-l bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white transition-colors"
          >
            {optimizing ? '⚡ Optimizing…' : `⚡ Auto-optimize ${activeTeam ?? 'Main'}`}
          </button>
          <button
            onClick={() => setOptimizeMenuOpen(v => !v)}
            disabled={optimizing}
            title="More optimize options"
            className="text-xs px-1.5 rounded-r bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white transition-colors border-l border-amber-900"
          >
            ▾
          </button>
          {optimizeMenuOpen && (
            <div className="absolute right-0 top-8 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl py-1 w-44">
              <button
                onClick={() => { setOptimizeMenuOpen(false); onAutoOptimizeWeek?.() }}
                disabled={optimizing}
                title={`Runs on ${activeTeam ?? 'Main'} for every day of the week`}
                className="block w-full text-left px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-btn-bg)] transition-colors disabled:opacity-40"
              >
                Optimize full week
              </button>
            </div>
          )}
        </div>
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => setExportOpen(v => !v)}
            className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
          >
            ⬇ Export
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-8 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl py-1 w-40">
              <button
                onClick={() => { setExportOpen(false); onExport?.('csv') }}
                className="block w-full text-left px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-btn-bg)] transition-colors"
              >
                Export CSV
              </button>
              <button
                onClick={() => { setExportOpen(false); onExport?.('json') }}
                className="block w-full text-left px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-btn-bg)] transition-colors"
              >
                Export JSON
              </button>
            </div>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white transition-colors"
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh data'}
        </button>
        <SettingsMenu
          theme={theme}
          onThemeChange={onThemeChange}
          costModeEnabled={costModeEnabled}
          onToggleCostMode={onToggleCostMode}
        />
      </div>

      {clearConfirm && (
        <ConfirmDialog
          title={clearConfirm === 'day' ? 'Clear this day?' : 'Clear the whole week?'}
          message={clearConfirm === 'day'
            ? 'All shifts for this day will be removed. This can be undone with Cmd+Z.'
            : 'All shifts for every day this week will be removed. This can be undone with Cmd+Z, one day at a time.'}
          confirmLabel="Clear"
          onCancel={() => setClearConfirm(null)}
          onConfirm={() => {
            if (clearConfirm === 'day') onClearDay?.()
            else onClearWeek?.()
            setClearConfirm(null)
          }}
        />
      )}
    </div>
  )
}
