import CoverageMiniChart from '../CoverageMiniChart'

const currency = n => `$${Math.round(n).toLocaleString()}`

export default function GeneratorResult({ result, onAccept, onDiscard }) {
  if (!result) return null
  const { totals, groups, area } = result

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[640px] max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-slate-700 shrink-0">
          <div className="text-sm font-semibold text-slate-100">✦ Generated schedule — {area}</div>
          <div className={`text-xs mt-1 ${totals.uncoveredHours <= 0 ? 'text-green-400' : 'text-amber-400'}`}>
            {totals.uncoveredHours <= 0
              ? '✓ Target demand fully covered'
              : `⚠ ${totals.uncoveredHours.toFixed(1)} patient-hours of target demand left uncovered`}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-slate-900/60 rounded px-3 py-1.5">
              <div className="text-[10px] text-slate-500 uppercase">Attending hrs</div>
              <div className="text-sm font-semibold text-slate-100">{totals.hours.toFixed(1)}</div>
              <div className="text-[10px] text-slate-500">baseline {totals.baselineHours.toFixed(1)}</div>
            </div>
            <div className="bg-slate-900/60 rounded px-3 py-1.5">
              <div className="text-[10px] text-slate-500 uppercase">Shifts</div>
              <div className="text-sm font-semibold text-slate-100">{totals.shiftCount}</div>
            </div>
            <div className="bg-slate-900/60 rounded px-3 py-1.5">
              <div className="text-[10px] text-slate-500 uppercase">Cost</div>
              <div className="text-sm font-semibold text-slate-100">{currency(totals.cost)}</div>
              <div className="text-[10px] text-slate-500">baseline {currency(totals.baselineCost)}</div>
            </div>
            <div className="bg-slate-900/60 rounded px-3 py-1.5">
              <div className="text-[10px] text-slate-500 uppercase">Uncovered</div>
              <div className="text-sm font-semibold" style={{ color: totals.uncoveredHours > 0 ? '#f59e0b' : '#94a3b8' }}>
                {totals.uncoveredHours.toFixed(1)} pt-hrs
              </div>
            </div>
          </div>

          {/* Per-pattern counts */}
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">Per-pattern counts</div>
            <div className="text-xs text-slate-300">
              {Object.values(totals.patternCounts).length === 0
                ? 'No shifts generated.'
                : Object.values(totals.patternCounts)
                    .sort((a, b) => b.count - a.count)
                    .map(p => `${p.count} x ${p.start}-${p.end}`)
                    .join(', ')}
            </div>
          </div>

          {/* Coverage curves */}
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">Generated coverage vs target</div>
            <div className="grid grid-cols-2 gap-2">
              {groups.map(g => (
                <CoverageMiniChart
                  key={g.label}
                  label={`${g.label} (${g.days.join(', ')})`}
                  demandSeries={g.demandSeries}
                  lines={[{ key: 'coverage', name: 'Generated coverage', color: '#2dd4bf', data: g.coverageSeries }]}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-700 flex gap-3 justify-end shrink-0">
          <button onClick={onDiscard} className="text-xs px-4 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            Discard
          </button>
          <button onClick={onAccept} className="text-xs px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-600 text-white transition-colors">
            Accept changes
          </button>
        </div>
      </div>
    </div>
  )
}
