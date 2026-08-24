import CoverageMiniChart from '../CoverageMiniChart'

const currency = n => `$${Math.round(n).toLocaleString()}`

// Docked to the bottom rather than a centered full-screen modal, so the
// live Timeline above stays visible and the Current/Generated toggle can
// swap what it's actually showing (not just an aggregate chart) -- see the
// "compare current vs generated" round.
export default function GeneratorResult({ result, onAccept, onDiscard, costModeEnabled, theme, previewMode, onPreviewModeChange }) {
  if (!result) return null
  const { totals, groups, area } = result

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--c-bg-panel)] border-t border-[var(--c-border)] shadow-2xl flex flex-col" style={{ maxHeight: '42vh' }}>
      <div className="px-5 py-3 border-b border-[var(--c-border)] shrink-0 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-[var(--c-text-strong)]">✦ Generated schedule — {area}</div>
          <div className={`text-xs mt-0.5 ${totals.uncoveredHours <= 0 ? 'text-green-400' : 'text-amber-400'}`}>
            {totals.uncoveredHours <= 0
              ? '✓ Target demand fully covered, assuming attendings reach their supervision ceiling'
              : `⚠ ${totals.uncoveredHours.toFixed(1)} patient-hours of target demand left uncovered even at full ceiling`}
          </div>
          <div className="text-[11px] text-[var(--c-text-muted)] mt-0.5 max-w-xl">
            This places attendings only, sized against their supervision ceiling (patients/hr they can be responsible for once
            backed by residents/PAs). Until you add that coverage, the live Demand vs Capacity chart will correctly show far
            less than this — an attending with nobody to supervise and no solo-seeing throughput has near-zero real capacity.
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex rounded overflow-hidden border border-[var(--c-border-strong)]">
            {['current', 'generated'].map(mode => (
              <button
                key={mode}
                onClick={() => onPreviewModeChange(mode)}
                className={`px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  previewMode === mode ? 'bg-blue-700 text-white' : 'bg-[var(--c-btn-bg)] text-[var(--c-text-secondary)] hover:bg-[var(--c-btn-bg-hover)]'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[var(--c-text-muted)]">Timeline above shows the {previewMode} schedule</span>
          <button onClick={onDiscard} className="text-xs px-4 py-1.5 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors">
            Discard
          </button>
          <button onClick={onAccept} className="text-xs px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-600 text-white transition-colors">
            Accept changes
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3 min-h-0">
        {/* Stats */}
        <div className={`grid gap-2 ${costModeEnabled ? 'grid-cols-4' : 'grid-cols-3'}`}>
          <div className="bg-[var(--c-bg-tile)] rounded px-3 py-1.5">
            <div className="text-[10px] text-[var(--c-text-muted)] uppercase">Attending hrs</div>
            <div className="text-sm font-semibold text-[var(--c-text-strong)]">{totals.hours.toFixed(1)}</div>
            <div className="text-[10px] text-[var(--c-text-muted)]">baseline {totals.baselineHours.toFixed(1)}</div>
          </div>
          <div className="bg-[var(--c-bg-tile)] rounded px-3 py-1.5">
            <div className="text-[10px] text-[var(--c-text-muted)] uppercase">Shifts</div>
            <div className="text-sm font-semibold text-[var(--c-text-strong)]">{totals.shiftCount}</div>
          </div>
          {costModeEnabled && (
            <div className="bg-[var(--c-bg-tile)] rounded px-3 py-1.5">
              <div className="text-[10px] text-[var(--c-text-muted)] uppercase">Cost</div>
              <div className="text-sm font-semibold text-[var(--c-text-strong)]">{currency(totals.cost)}</div>
              <div className="text-[10px] text-[var(--c-text-muted)]">baseline {currency(totals.baselineCost)}</div>
            </div>
          )}
          <div className="bg-[var(--c-bg-tile)] rounded px-3 py-1.5">
            <div className="text-[10px] text-[var(--c-text-muted)] uppercase">Uncovered</div>
            <div className="text-sm font-semibold" style={{ color: totals.uncoveredHours > 0 ? '#f59e0b' : '#94a3b8' }}>
              {totals.uncoveredHours.toFixed(1)} pt-hrs
            </div>
          </div>
        </div>

        {/* Per-pattern counts */}
        <div>
          <div className="text-[10px] text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">Per-pattern counts</div>
          <div className="text-xs text-[var(--c-text-secondary)]">
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
          <div className="text-[10px] text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">
            Assumed coverage vs target (at full ceiling, once staffed — not current live capacity)
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {groups.map(g => (
              <CoverageMiniChart
                key={g.label}
                label={`${g.label} (${g.days.join(', ')})`}
                demandSeries={g.demandSeries}
                lines={[{ key: 'coverage', name: 'Assumed coverage', color: '#2dd4bf', data: g.coverageSeries }]}
                theme={theme}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
