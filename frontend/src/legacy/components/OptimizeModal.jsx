import { useState } from 'react'

function DayBreakdown({ day, result }) {
  const [open, setOpen] = useState(false)
  const allResolved = result.resolvedCount === result.totalOverflow
  return (
    <div className="border border-slate-800 rounded">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800/60 transition-colors"
      >
        <span className="font-medium">{day}</span>
        <span className={allResolved ? 'text-green-400' : result.totalOverflow > 0 ? 'text-amber-400' : 'text-slate-500'}>
          {result.totalOverflow > 0
            ? `${result.resolvedCount}/${result.totalOverflow} resolved`
            : 'no overflow'}
          <span className="ml-1 text-slate-600">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-slate-800">
          {result.changes.length === 0 ? (
            <div className="text-xs text-slate-500">No changes were necessary.</div>
          ) : (
            <ul className="space-y-1.5">
              {result.changes.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs text-slate-300">
                  <span className="text-slate-600 shrink-0 mt-0.5">•</span>
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

export default function OptimizeModal({ result, onAccept, onDiscard }) {
  if (!result) return null

  const allResolved = result.resolvedCount === result.totalOverflow

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[500px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-700 shrink-0">
          <div className="text-sm font-semibold text-slate-100">
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
                <DayBreakdown key={day} day={day} result={dayResult} />
              ))}
            </div>
          ) : result.changes.length === 0 ? (
            <div className="text-xs text-slate-400">No changes were necessary.</div>
          ) : (
            <ul className="space-y-2">
              {result.changes.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs text-slate-300">
                  <span className="text-slate-600 shrink-0 mt-0.5">•</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-700 flex gap-3 justify-end shrink-0">
          <button
            onClick={onDiscard}
            className="text-xs px-4 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
          >
            Discard changes
          </button>
          <button
            onClick={onAccept}
            className="text-xs px-4 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
          >
            Accept changes
          </button>
        </div>
      </div>
    </div>
  )
}
