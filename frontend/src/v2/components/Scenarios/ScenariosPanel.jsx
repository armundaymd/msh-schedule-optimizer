import { useState } from 'react'
import { scenarioPayloadToSnapshot } from '../../../shared/scenarioPayload'
import { computeShiftCost } from '../../../shared/cost'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

function weekAttendingHours(shiftsByDay) {
  return DAYS.reduce((sum, d) => sum + (shiftsByDay[d] ?? [])
    .filter(s => s.role_type === 'Attending')
    .reduce((s2, s) => s2 + (s.endMins - s.startMins) / 60, 0), 0)
}

function weekShiftCount(shiftsByDay) {
  return DAYS.reduce((sum, d) => sum + (shiftsByDay[d]?.length ?? 0), 0)
}

function weekCost(shiftsByDay, costRates) {
  return DAYS.reduce((sum, d) => sum + computeShiftCost(shiftsByDay[d] ?? [], costRates), 0)
}

const currency = n => `$${Math.round(n).toLocaleString()}`

function StatRow({ label, current, scenario, format = String, deltaFormat = format }) {
  const delta = scenario - current
  const deltaColor = delta === 0 ? 'text-[var(--c-text-muted)]' : delta > 0 ? 'text-amber-400' : 'text-green-400'
  return (
    <tr className="text-xs">
      <td className="py-1 pr-3 text-[var(--c-text-muted)]">{label}</td>
      <td className="py-1 pr-3 text-[var(--c-text-secondary)] text-right">{format(current)}</td>
      <td className="py-1 pr-3 text-[var(--c-text-secondary)] text-right">{format(scenario)}</td>
      <td className={`py-1 text-right ${deltaColor}`}>{delta > 0 ? '+' : ''}{deltaFormat(delta)}</td>
    </tr>
  )
}

export default function ScenariosPanel({
  open, onClose, scenarios, comparisonScenarioId, onSelectComparison,
  onDeleteScenario, onResetToScenario, currentShiftsByDay, costRates, costModeEnabled,
}) {
  const [expandedId, setExpandedId] = useState(null)
  if (!open) return null

  const currentHours = weekAttendingHours(currentShiftsByDay)
  const currentCost = weekCost(currentShiftsByDay, costRates)
  const currentShiftCount = weekShiftCount(currentShiftsByDay)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[var(--c-bg-panel)] border border-[var(--c-border)] rounded-xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b border-[var(--c-border)] shrink-0 flex items-center justify-between">
          <div className="text-sm font-semibold text-[var(--c-text-strong)]">📊 Saved scenarios</div>
          <button onClick={onClose} className="text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)] text-sm">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {scenarios.length === 0 ? (
            <div className="text-xs text-[var(--c-text-muted)]">No scenarios saved yet. Use "Save scenario" in the top bar to snapshot the current week.</div>
          ) : (
            scenarios.map(sc => {
              const snapshot = scenarioPayloadToSnapshot(sc.payload)
              const hours = weekAttendingHours(snapshot)
              const cost = weekCost(snapshot, sc.payload.costRates ?? costRates)
              const shiftCount = weekShiftCount(snapshot)
              const expanded = expandedId === sc.id
              const comparing = comparisonScenarioId === sc.id
              return (
                <div key={sc.id} className="border border-[var(--c-border-subtle)] rounded">
                  <button
                    onClick={() => setExpandedId(expanded ? null : sc.id)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--c-bg-surface-hover)] transition-colors"
                  >
                    <div className="text-left">
                      <div className="text-xs font-medium text-[var(--c-text-secondary)]">{sc.name}</div>
                      <div className="text-[10px] text-[var(--c-text-muted)]">
                        {new Date(sc.created_at).toLocaleString()} · {hours.toFixed(1)} att-hrs
                        {costModeEnabled && ` · ${currency(cost)}`} · {shiftCount} shifts
                      </div>
                    </div>
                    <span className="text-[var(--c-text-faint)] text-xs">{expanded ? '▲' : '▼'}</span>
                  </button>
                  {expanded && (
                    <div className="px-3 py-2 border-t border-[var(--c-border-subtle)] space-y-2">
                      <table className="w-full">
                        <thead>
                          <tr className="text-[10px] text-[var(--c-text-muted)] uppercase">
                            <td className="pb-1"></td>
                            <td className="pb-1 text-right">Current</td>
                            <td className="pb-1 text-right">{sc.name}</td>
                            <td className="pb-1 text-right">Delta</td>
                          </tr>
                        </thead>
                        <tbody>
                          <StatRow label="Attending hrs" current={currentHours} scenario={hours} format={n => n.toFixed(1)} />
                          {costModeEnabled && (
                            <StatRow label="Cost" current={currentCost} scenario={cost} format={currency} deltaFormat={n => `${n < 0 ? '-' : ''}${currency(Math.abs(n))}`} />
                          )}
                          <StatRow label="Shift count" current={currentShiftCount} scenario={shiftCount} />
                        </tbody>
                      </table>
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => { onResetToScenario(sc.id); onClose() }}
                          className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                        >
                          Load into working schedule
                        </button>
                        <button
                          onClick={() => onSelectComparison(comparing ? null : sc.id)}
                          className={`text-xs px-3 py-1 rounded transition-colors ${
                            comparing ? 'bg-orange-800 hover:bg-orange-700 text-orange-100' : 'bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)]'
                          }`}
                        >
                          {comparing ? '✓ Comparing on chart' : 'Compare on chart'}
                        </button>
                        <button
                          onClick={() => onDeleteScenario(sc.id)}
                          className="text-xs px-3 py-1 rounded bg-[var(--c-btn-bg)] hover:bg-red-900 text-[var(--c-text-secondary)] hover:text-red-200 transition-colors ml-auto"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--c-border)] shrink-0 text-right">
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
