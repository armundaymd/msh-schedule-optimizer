import { useState } from 'react'
import CoverageMiniChart from './CoverageMiniChart'

const COVERAGE_LINES = [
  { key: 'before', name: 'Before', color: '#64748b', dashed: true },
  { key: 'after', name: 'After', color: '#2dd4bf' },
]

function DayBreakdown({ day, result, theme }) {
  const [open, setOpen] = useState(false)
  const allResolved = result.resolvedCount === result.totalOverflow
  return (
    <div className="border border-[var(--c-border-subtle)] rounded">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-[var(--c-bg-surface-hover)] transition-colors"
      >
        <span className="font-medium">{day}</span>
        <span className={allResolved ? 'text-green-400' : result.totalOverflow > 0 ? 'text-amber-400' : 'text-[var(--c-text-muted)]'}>
          {result.totalOverflow > 0
            ? `${result.resolvedCount}/${result.totalOverflow} resolved`
            : 'no overflow'}
          <span className="ml-1 text-[var(--c-text-faint)]">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-[var(--c-border-subtle)] space-y-2">
          {result.demandSeries && (
            <CoverageMiniChart
              demandSeries={result.demandSeries}
              lines={[
                { ...COVERAGE_LINES[0], data: result.beforeCoverage },
                { ...COVERAGE_LINES[1], data: result.afterCoverage },
              ]}
              theme={theme}
            />
          )}
          {result.changes.length === 0 ? (
            <div className="text-xs text-[var(--c-text-muted)]">No changes were necessary.</div>
          ) : (
            <ul className="space-y-1.5">
              {result.changes.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs text-[var(--c-text-secondary)]">
                  <span className="text-[var(--c-text-faint)] shrink-0 mt-0.5">•</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export default function OptimizeModal({ result, onAccept, onDiscard, theme }) {
  if (!result) return null

  const allResolved = result.resolvedCount === result.totalOverflow

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[var(--c-bg-panel)] border border-[var(--c-border)] rounded-xl shadow-2xl w-[500px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--c-border)] shrink-0">
          <div className="text-sm font-semibold text-[var(--c-text-strong)]">
            ⚡ Auto-optimize results{result.isWeek ? ' — full week' : ''}
          </div>
          <div className={`text-xs mt-1 ${allResolved ? 'text-green-400' : 'text-amber-400'}`}>
            {allResolved
              ? `✓ All ${result.totalOverflow} overflow hours resolved`
              : `⚠ ${result.resolvedCount} of ${result.totalOverflow} overflow hours resolved`
            }
          </div>
        </div>

        {/* Changes list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0">
          {result.isWeek ? (
            <div className="space-y-1.5">
              {Object.entries(result.perDay).map(([day, dayResult]) => (
                <DayBreakdown key={day} day={day} result={dayResult} theme={theme} />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {result.demandSeries && (
                <CoverageMiniChart
                  label="Coverage before vs after"
                  demandSeries={result.demandSeries}
                  lines={[
                    { ...COVERAGE_LINES[0], data: result.beforeCoverage },
                    { ...COVERAGE_LINES[1], data: result.afterCoverage },
                  ]}
                  theme={theme}
                />
              )}
              {result.changes.length === 0 ? (
                <div className="text-xs text-[var(--c-text-muted)]">No changes were necessary.</div>
              ) : (
                <ul className="space-y-2">
                  {result.changes.map((c, i) => (
                    <li key={i} className="flex gap-2 text-xs text-[var(--c-text-secondary)]">
                      <span className="text-[var(--c-text-faint)] shrink-0 mt-0.5">•</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[var(--c-border)] flex gap-3 justify-end shrink-0">
          <button
            onClick={onDiscard}
            className="text-xs px-4 py-1.5 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors"
          >
            Discard changes
          </button>
          <button
            onClick={onAccept}
            className="text-xs px-4 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-[var(--c-text-strong)] transition-colors"
          >
            Accept changes
          </button>
        </div>
      </div>
    </div>
  )
}
