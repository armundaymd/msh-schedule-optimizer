import { useState, useEffect } from 'react'
import PphSliders from './PphSliders'
import CapacityChart from './CapacityChart'
import PillToggle from '../../../shared/components/PillToggle'
import { fetchDemandCI, fetchValidation } from '../../../shared/api'
import { hasPercentiles } from '../../../shared/demandSeries'
import { scenarioPayloadToSnapshot } from '../../../shared/scenarioPayload'

const TEAM_VIEWS = ['Main', 'FastTrack', 'ERU']
const TARGETS = ['mean', 'p50', 'p75', 'p90']
const TARGET_LABEL = { mean: 'Mean', p50: 'p50', p75: 'p75', p90: 'p90' }

export default function PphChart({
  day, demand, shifts, baselineShifts, pph, onPphChange,
  scenarios, comparisonScenarioId, onSelectComparison, onDeleteScenario, onResetToScenario,
  customTeams,
  costRates, costModeEnabled, onCostRateChange, onToggleCostMode,
  activeTeam, onActiveTeamChange, target, onTargetChange,
  hoverHour, onHoverHour,
}) {
  const [demandCI, setDemandCI]         = useState(null)
  const [empiricalPph, setEmpiricalPph] = useState(null)
  const percentilesAvailable = hasPercentiles(demand)

  useEffect(() => {
    fetchDemandCI().then(d => d && setDemandCI(d)).catch(() => {})
    fetchValidation().then(d => {
      if (!d?.empirical_pph) return
      const ep = d.empirical_pph
      setEmpiricalPph({
        main:      ep.Main?.overall_mean_pph      ?? null,
        fasttrack: ep.FastTrack?.overall_mean_pph ?? null,
        eru:       ep.ERU?.overall_mean_pph       ?? null,
      })
    }).catch(() => {})
  }, [])

  const compScenario     = scenarios?.find(s => s.id === comparisonScenarioId)
  const comparisonShifts = compScenario ? (scenarioPayloadToSnapshot(compScenario.payload)[day] ?? []) : null
  const comparisonPph    = compScenario?.payload?.pph ?? null

  const nDays  = demandCI?.[activeTeam]?.n_days ?? null
  const ciTitle = nDays
    ? `${activeTeam} demand shown as mean ± 95% bootstrap CI across ${nDays} days of data`
    : null

  return (
    <div className="flex flex-col h-full bg-[#0f1117]">

      {/* Title + ⓘ */}
      <div className="px-3 py-2 text-xs font-semibold text-slate-400 border-b border-slate-700 shrink-0 flex items-center gap-1.5">
        Demand vs Capacity — {day}
        {ciTitle && (
          <span title={ciTitle} className="text-slate-600 cursor-help select-none" style={{ fontSize: 11 }}>ⓘ</span>
        )}
      </div>

      {/* Team-type tabs */}
      <div className="flex items-center justify-between border-b border-slate-700 shrink-0 pr-2">
        <div className="flex">
          {TEAM_VIEWS.map(t => (
            <button
              key={t}
              onClick={() => onActiveTeamChange?.(t)}
              className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                activeTeam === t
                  ? 'text-blue-300 border-b-2 border-blue-500 bg-slate-800/40'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Demand target: mean, or a percentile once the pipeline has computed one */}
        <div className="flex rounded overflow-hidden border border-slate-700">
          {TARGETS.map(t => {
            const disabled = t !== 'mean' && !percentilesAvailable
            return (
              <button
                key={t}
                onClick={() => !disabled && onTargetChange?.(t)}
                disabled={disabled}
                title={disabled ? 'Percentile demand needs a pipeline refresh with raw data' : undefined}
                className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                  target === t
                    ? 'bg-blue-700 text-white'
                    : disabled
                      ? 'bg-slate-900 text-slate-700 cursor-not-allowed'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {TARGET_LABEL[t]}
              </button>
            )
          })}
        </div>
      </div>

      <PphSliders pph={pph} onChange={onPphChange} empiricalPph={empiricalPph} activeTeam={activeTeam} />

      {/* Bottleneck dot legend */}
      <div className="flex items-center gap-3 px-3 pt-1 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} />
          Supervision-limited
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#2dd4bf' }} />
          Staffing-limited
        </span>
      </div>

      {/* Cost modeling toggle */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-slate-800">
        <span className="text-[11px] text-slate-400 select-none">💰 Cost modeling</span>
        <PillToggle checked={!!costModeEnabled} onChange={onToggleCostMode} />
        {costModeEnabled && (
          <div className="flex items-center gap-3 ml-2">
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              Attending $/hr
              <input
                type="number"
                min={0}
                step={5}
                value={costRates?.attending ?? 0}
                onChange={e => onCostRateChange('attending', parseFloat(e.target.value) || 0)}
                className="w-16 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-xs text-slate-100 outline-none focus:border-blue-500"
              />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              PA $/hr
              <input
                type="number"
                min={0}
                step={5}
                value={costRates?.pa ?? 0}
                onChange={e => onCostRateChange('pa', parseFloat(e.target.value) || 0)}
                className="w-16 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-xs text-slate-100 outline-none focus:border-blue-500"
              />
            </label>
          </div>
        )}
      </div>

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
          demandCI={demandCI}
          empiricalPph={empiricalPph}
          activeTeam={activeTeam}
          target={target}
          hoverHour={hoverHour}
          onHoverHour={onHoverHour}
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
                >↩</button>
                <button
                  onClick={e => { e.stopPropagation(); onDeleteScenario(sc.id) }}
                  className="text-[10px] text-slate-500 hover:text-red-400 ml-0.5"
                  title="Delete scenario"
                >×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
