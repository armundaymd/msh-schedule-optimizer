import PphSliders from './PphSliders'
import CapacityChart from './CapacityChart'

export default function PphChart({
  day, demand, shifts, baselineShifts, pph, onPphChange,
  scenarios, comparisonScenarioId, onSelectComparison, onDeleteScenario, onResetToScenario,
  customTeams,
}) {
  const compScenario = scenarios?.find(s => s.id === comparisonScenarioId)
  const comparisonShifts = compScenario ? (compScenario.proposed[day] ?? []) : null
  const comparisonPph    = compScenario?.pph ?? null

  return (
    <div className="flex flex-col h-full bg-[#0f1117]">
      <div className="px-3 py-2 text-xs font-semibold text-slate-400 border-b border-slate-700 shrink-0">
        PPH Comparison — {day}
      </div>
      <PphSliders pph={pph} onChange={onPphChange} />
      <div className="flex-1 min-h-0 p-2">
        <CapacityChart
          day={day}
          demand={demand}
          shifts={shifts}
          baselineShifts={baselineShifts}
          pph={pph}
          comparisonShifts={comparisonShifts}
          comparisonPph={comparisonPph}
          customTeams={customTeams}
        />
      </div>
      {scenarios?.length > 0 && (
        <div className="shrink-0 border-t border-slate-800 px-3 py-2">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">Scenarios</div>
          <div className="flex flex-wrap gap-1.5">
            {scenarios.map(sc => (
              <div
                key={sc.id}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer transition-colors ${
                  comparisonScenarioId === sc.id
                    ? 'bg-orange-900/60 border border-orange-600 text-orange-200'
                    : 'bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-500'
                }`}
                onClick={() => onSelectComparison(sc.id === comparisonScenarioId ? null : sc.id)}
              >
                <span className="max-w-[80px] truncate">{sc.name}</span>
                <button
                  onClick={e => { e.stopPropagation(); onResetToScenario(sc.id) }}
                  className="text-[10px] text-slate-400 hover:text-slate-200 ml-0.5"
                  title="Restore this scenario"
                >
                  ↩
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onDeleteScenario(sc.id) }}
                  className="text-[10px] text-slate-500 hover:text-red-400 ml-0.5"
                  title="Delete scenario"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
