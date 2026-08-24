import { useState } from 'react'
import { DEFAULT_PATTERNS, ALLOWED_LENGTHS, anyStartPatterns, patternLabel } from '../../utils/patterns'

const AREAS = [
  { key: 'main', label: 'Main', defaultMaxConcurrent: 3 },
  { key: 'fasttrack', label: 'FastTrack', defaultMaxConcurrent: 1 },
  { key: 'eru', label: 'ERU', defaultMaxConcurrent: 1 },
]

const TARGETS = ['mean', 'p50', 'p75', 'p90']
const TARGET_LABEL = { mean: 'Mean', p50: 'p50', p75: 'p75', p90: 'p90' }

// 23:00-07:00, matching validate.py's Night_23_07 time window.
const DEFAULT_OVERNIGHT_HOURS = [23, 0, 1, 2, 3, 4, 5, 6]

export default function ConstraintsPanel({
  initialArea = 'main', target, percentilesAvailable, defaultCostPerHour = 250,
  onGenerate, onClose,
}) {
  const [area, setArea] = useState(initialArea)
  const [panelTarget, setPanelTarget] = useState(target ?? 'mean')
  const [patternMode, setPatternMode] = useState('default') // 'default' | 'any'
  const [customPatterns, setCustomPatterns] = useState(DEFAULT_PATTERNS)
  const [anyLength, setAnyLength] = useState(8)
  const [newStart, setNewStart] = useState(7)
  const [newLength, setNewLength] = useState(8)

  const areaConfig = AREAS.find(a => a.key === area)
  const [maxConcurrent, setMaxConcurrent] = useState(areaConfig.defaultMaxConcurrent)
  const [minConcurrent, setMinConcurrent] = useState(1)
  const [overnightMin, setOvernightMin] = useState(0)
  const [costPerHour, setCostPerHour] = useState(defaultCostPerHour)
  const [objective, setObjective] = useState('minimize-hours')
  const [weeklyHourBudget, setWeeklyHourBudget] = useState(200)
  const [scope, setScope] = useState('templates')

  function handleAreaChange(nextArea) {
    setArea(nextArea)
    setMaxConcurrent(AREAS.find(a => a.key === nextArea).defaultMaxConcurrent)
  }

  function addPattern() {
    const p = { start: newStart, length: newLength }
    if (customPatterns.some(cp => cp.start === p.start && cp.length === p.length)) return
    setCustomPatterns(prev => [...prev, p].sort((a, b) => a.start - b.start))
  }

  function removePattern(idx) {
    setCustomPatterns(prev => prev.filter((_, i) => i !== idx))
  }

  function handleGenerateClick() {
    const patterns = patternMode === 'any' ? anyStartPatterns(anyLength) : customPatterns
    onGenerate({
      area,
      target: panelTarget,
      patterns,
      scope,
      constraints: {
        minConcurrent,
        maxConcurrent,
        overnightMin,
        overnightHours: DEFAULT_OVERNIGHT_HOURS,
        costPerHour,
        objective,
        weeklyHourBudget: objective === 'maximize-coverage' ? weeklyHourBudget : null,
      },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[var(--c-bg-panel)] border border-[var(--c-border)] rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-[var(--c-border)] shrink-0">
          <div className="text-sm font-semibold text-[var(--c-text-strong)]">✦ Generate schedule</div>
          <div className="text-xs text-[var(--c-text-muted)] mt-1">Shift set covering: places attendings on an empty board against target demand.</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          {/* Area */}
          <div>
            <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">Area</div>
            <div className="flex gap-1.5">
              {AREAS.map(a => (
                <button
                  key={a.key}
                  onClick={() => handleAreaChange(a.key)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${area === a.key ? 'bg-teal-700 text-[var(--c-text-strong)]' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {/* Target */}
          <div>
            <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">Target demand</div>
            <div className="flex gap-1.5">
              {TARGETS.map(t => {
                const disabled = t !== 'mean' && !percentilesAvailable
                return (
                  <button
                    key={t}
                    onClick={() => !disabled && setPanelTarget(t)}
                    disabled={disabled}
                    title={disabled ? 'Percentile demand needs a pipeline refresh with raw data' : undefined}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                      panelTarget === t ? 'bg-teal-700 text-[var(--c-text-strong)]' : disabled ? 'bg-[var(--c-bg-panel)] text-[var(--c-text-faint)] cursor-not-allowed' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
                    }`}
                  >
                    {TARGET_LABEL[t]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Patterns */}
          <div>
            <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">Shift pattern menu</div>
            <div className="flex gap-3 mb-2">
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={patternMode === 'default'} onChange={() => setPatternMode('default')} />
                Fixed menu
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={patternMode === 'any'} onChange={() => setPatternMode('any')} />
                Any start hour
              </label>
              {patternMode === 'any' && (
                <select
                  value={anyLength}
                  onChange={e => setAnyLength(parseInt(e.target.value))}
                  className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)]"
                >
                  {ALLOWED_LENGTHS.map(l => <option key={l} value={l}>{l}h</option>)}
                </select>
              )}
            </div>
            {patternMode === 'default' && (
              <>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {customPatterns.map((p, i) => (
                    <span key={i} className="flex items-center gap-1 bg-[var(--c-bg-surface)] border border-[var(--c-border)] rounded px-2 py-0.5 text-xs text-[var(--c-text-secondary)]">
                      {patternLabel(p)}
                      <button onClick={() => removePattern(i)} className="text-[var(--c-text-muted)] hover:text-red-400">×</button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <select value={newStart} onChange={e => setNewStart(parseInt(e.target.value))} className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)]">
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                  <select value={newLength} onChange={e => setNewLength(parseInt(e.target.value))} className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)]">
                    {ALLOWED_LENGTHS.map(l => <option key={l} value={l}>{l}h</option>)}
                  </select>
                  <button onClick={addPattern} className="text-xs px-2 py-0.5 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)]">+ Add</button>
                </div>
              </>
            )}
          </div>

          {/* Concurrency constraints */}
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--c-text-muted)]">Max concurrent</span>
              <input type="number" min={1} value={maxConcurrent} onChange={e => setMaxConcurrent(parseInt(e.target.value) || 1)}
                className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)]" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--c-text-muted)]">Min concurrent</span>
              <input type="number" min={0} value={minConcurrent} onChange={e => setMinConcurrent(parseInt(e.target.value) || 0)}
                className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)]" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--c-text-muted)]" title="Applies 23:00-07:00">Overnight min</span>
              <input type="number" min={0} value={overnightMin} onChange={e => setOvernightMin(parseInt(e.target.value) || 0)}
                className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)]" />
            </label>
          </div>

          {/* Objective */}
          <div>
            <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">Objective</div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={objective === 'minimize-hours'} onChange={() => setObjective('minimize-hours')} />
                Minimise hours needed to cover target demand
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={objective === 'maximize-coverage'} onChange={() => setObjective('maximize-coverage')} />
                Maximise coverage under a fixed weekly hour budget
              </label>
              {objective === 'maximize-coverage' && (
                <div className="flex items-center gap-1.5 pl-5">
                  <input type="number" min={1} value={weeklyHourBudget} onChange={e => setWeeklyHourBudget(parseInt(e.target.value) || 1)}
                    className="w-20 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)]" />
                  <span className="text-xs text-[var(--c-text-muted)]">attending-hours/week, spent on the best-value shifts first</span>
                </div>
              )}
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)] pl-0">
                <span className="text-[var(--c-text-muted)]">$/hr</span>
                <input type="number" min={0} step={5} value={costPerHour} onChange={e => setCostPerHour(parseFloat(e.target.value) || 0)}
                  className="w-16 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)]" />
              </label>
            </div>
          </div>

          {/* Scope */}
          <div>
            <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">Scope</div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={scope === 'day'} onChange={() => setScope('day')} />
                This day only
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={scope === 'templates'} onChange={() => setScope('templates')} />
                Weekday / Saturday / Sunday templates
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
                <input type="radio" checked={scope === 'week'} onChange={() => setScope('week')} />
                All seven days independently
              </label>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-[var(--c-border)] flex gap-3 justify-end shrink-0">
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)] transition-colors">
            Cancel
          </button>
          <button onClick={handleGenerateClick} className="text-xs px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-600 text-[var(--c-text-strong)] transition-colors">
            Generate
          </button>
        </div>
      </div>
    </div>
  )
}
