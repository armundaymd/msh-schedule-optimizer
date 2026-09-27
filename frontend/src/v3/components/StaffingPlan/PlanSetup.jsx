import { AREAS, AREA_LABEL, SCOPE_LABEL, SCOPE_ORDER, scopeAreas } from '../../../shared/areas'
import { formatHour } from '../../../shared/coverageInsights'
import { DEFAULT_MAX_FLEX } from '../../../shared/staffingPlan'
import { ALLOWED_LENGTHS, PLAN_START_MODES, planPatterns } from '../../utils/patterns'
import CoverageEditor from './CoverageEditor'
import EruScenarioPicker from './EruScenarioPicker'
import PlanningInputs from './PlanningInputs'

const TARGETS = ['mean', 'p50', 'p75', 'p90']
const TARGET_LABEL = { mean: 'Mean', p50: 'p50', p75: 'p75', p90: 'p90' }

function Section({ n, title, hint, children }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[10px] font-semibold text-indigo-300">{n}</span>
        <span className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide">{title}</span>
      </div>
      {hint && <div className="text-[11px] text-[var(--c-text-faint)] -mt-1 mb-1.5">{hint}</div>}
      {children}
    </section>
  )
}

function Pills({ options, value, onChange, disabled = () => false, title }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => !disabled(key) && onChange(key)}
          disabled={disabled(key)}
          title={disabled(key) ? title?.(key) : undefined}
          aria-pressed={value === key}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            value === key ? 'bg-indigo-700 text-white'
              : disabled(key) ? 'bg-[var(--c-bg-panel)] text-[var(--c-text-faint)] cursor-not-allowed'
                : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
          }`}
        >{label}</button>
      ))}
    </div>
  )
}

const inputCls = 'bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)] outline-none focus:border-indigo-500'

function HourSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))} className={inputCls}>
      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
    </select>
  )
}

// One rule row: area + hour window (+ minimum count for coverage rules).
function RuleRow({ rule, areas, withMin, onChange, onRemove }) {
  const allDay = rule.fromHour === rule.toHour
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-xs text-[var(--c-text-secondary)]">
      <select aria-label="Area" value={rule.area} onChange={e => onChange({ area: e.target.value })} className={inputCls}>
        {areas.map(a => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
      </select>
      {withMin ? (
        <>
          <span className="text-[var(--c-text-muted)]">needs at least</span>
          <input
            type="number" min={1} max={5} value={rule.min} aria-label="Minimum attendings"
            onChange={e => onChange({ min: Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1)) })}
            className={`${inputCls} w-11`}
          />
          <span className="text-[var(--c-text-muted)]">attending{rule.min === 1 ? '' : 's'}</span>
        </>
      ) : (
        <span className="text-[var(--c-text-muted)]">keep current shifts starting</span>
      )}
      <HourSelect label="From" value={rule.fromHour} onChange={v => onChange({ fromHour: v })} />
      <span className="text-[var(--c-text-faint)]">to</span>
      <HourSelect label="To" value={rule.toHour} onChange={v => onChange({ toHour: v })} />
      {allDay && <span className="text-[10px] text-[var(--c-text-faint)]">(all day)</span>}
      <button onClick={onRemove} aria-label="Remove rule" className="ml-auto text-[var(--c-text-muted)] hover:text-red-400 px-1">×</button>
    </div>
  )
}

export default function PlanSetup({ settings, onChange, percentilesAvailable, todayWeekly, onUseToday, days, shiftsForDay, customTeams }) {
  const { scope, target, startMode, lengths, lockRules, minRules } = settings
  const areas = scopeAreas(scope)
  const nPatterns = planPatterns(startMode, lengths).length

  function updateRule(key, i, patch) {
    onChange({ [key]: settings[key].map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  }
  function removeRule(key, i) {
    onChange({ [key]: settings[key].filter((_, j) => j !== i) })
  }
  // Rules for areas no longer in scope are ignored by the planner; showing
  // them would be confusing, so they're filtered on display and on run.
  const visible = key => settings[key].map((r, i) => [r, i]).filter(([r]) => areas.includes(r.area))

  return (
    <div className="space-y-5">
      <Section n="1" title="Planning question" hint="Attending hours are the only decision variable. Residents and APPs stay exactly as scheduled.">
        <PlanningInputs settings={settings} onChange={onChange} todayWeekly={todayWeekly} onUseToday={onUseToday} />
      </Section>

      <Section n="2" title="Demand target">
        <Pills
          options={TARGETS.map(t => [t, TARGET_LABEL[t]])} value={target} onChange={v => onChange({ target: v })}
          disabled={t => t !== 'mean' && !percentilesAvailable}
          title={() => 'Percentile demand needs a pipeline refresh with raw data'}
        />
      </Section>

      <Section n="3" title="Scope" hint="Deficits are always measured per area — surplus in one area never offsets a shortfall in another.">
        <Pills options={SCOPE_ORDER.map(s => [s, SCOPE_LABEL[s]])} value={scope} onChange={v => onChange({ scope: v })} />
      </Section>

      {settings.useCoverage && areas.includes('eru') && (
        <Section n="4" title="ERU dedicated coverage scenario" hint="Choose when ERU has its own attending; the allocator then places the rest of the budget. Scenarios are for comparison — they do not say which window is clinically right.">
          <EruScenarioPicker settings={settings} onChange={onChange} days={days} />
        </Section>
      )}

      <Section n={settings.useCoverage && areas.includes('eru') ? '5' : '4'} title="Operational coverage" hint="Hard attending-coverage rules by area, day and time (defaults: Main 24/7 and the current ERU dedicated coverage, kept for comparison — not an established clinical minimum). Satisfied before any throughput optimization.">
        <CoverageEditor
          coverage={settings.coverage} enabled={settings.useCoverage} areas={areas} allAreas={AREAS}
          days={days} shiftsForDay={shiftsForDay} customTeams={customTeams}
          onToggle={v => onChange({ useCoverage: v })} onChange={c => onChange({ coverage: c })}
        />
      </Section>

      <Section n={settings.useCoverage && areas.includes('eru') ? '6' : '5'} title="Shift constraints">
        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-[var(--c-text-muted)] mb-1">Shift structure <span className="text-[var(--c-text-faint)]">— current start times, or an expanded grid to test whether timing (not hours) limits coverage</span></div>
            <div className="flex items-center gap-3 flex-wrap">
              <Pills
                options={Object.entries(PLAN_START_MODES).map(([k, v]) => [k, v.label])}
                value={startMode} onChange={v => onChange({ startMode: v })}
              />
              <div className="flex items-center gap-2 text-xs text-[var(--c-text-secondary)]">
                {ALLOWED_LENGTHS.map(L => (
                  <label key={L} className="flex items-center gap-1">
                    <input
                      type="checkbox" checked={lengths.includes(L)}
                      onChange={e => onChange({ lengths: e.target.checked ? [...lengths, L].sort((a, b) => a - b) : lengths.filter(x => x !== L) })}
                    />
                    {L}h
                  </label>
                ))}
              </div>
            </div>
            <div className="text-[10px] text-[var(--c-text-faint)] mt-1">
              {nPatterns} shift pattern{nPatterns === 1 ? '' : 's'}. Current start times is recommended: larger menus have more options
              than the search can explore, and often end up with a slightly worse plan. The result always says how close it is to the best possible.
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)] flex-wrap">
            <span className="text-[11px] text-[var(--c-text-muted)]">Additional simultaneous attendings per area (new teams, beyond one per existing team):</span>
            <input type="number" min={0} max={6} value={settings.maxFlex ?? DEFAULT_MAX_FLEX} aria-label="New-team attendings per area"
              onChange={e => onChange({ maxFlex: Math.max(0, Math.min(6, parseInt(e.target.value, 10) || 0)) })} className={`${inputCls} w-11`} />
            <span className="text-[10px] text-[var(--c-text-faint)]">lets the planner add attending coverage at peaks, not just re-time today&apos;s shifts (ERU stays at one).</span>
          </div>

          <div>
            <div className="text-[11px] text-[var(--c-text-muted)] mb-1">Minimum attending coverage</div>
            <div className="space-y-1.5">
              {visible('minRules').map(([r, i]) => (
                <RuleRow key={i} rule={r} areas={areas} withMin
                  onChange={p => updateRule('minRules', i, p)} onRemove={() => removeRule('minRules', i)} />
              ))}
              <button
                onClick={() => onChange({ minRules: [...minRules, { area: areas[0], fromHour: 0, toHour: 0, min: 1 }] })}
                className="text-[11px] text-indigo-300 hover:text-indigo-200"
              >+ Add minimum coverage</button>
            </div>
          </div>

          <div>
            <div className="text-[11px] text-[var(--c-text-muted)] mb-1">Locked shifts <span className="text-[var(--c-text-faint)]">— kept exactly as scheduled today; their hours count toward the budget</span></div>
            <div className="space-y-1.5">
              {visible('lockRules').map(([r, i]) => (
                <RuleRow key={i} rule={r} areas={areas}
                  onChange={p => updateRule('lockRules', i, p)} onRemove={() => removeRule('lockRules', i)} />
              ))}
              <button
                onClick={() => onChange({ lockRules: [...lockRules, { area: areas[0], fromHour: 19, toHour: 7 }] })}
                className="text-[11px] text-indigo-300 hover:text-indigo-200"
              >+ Lock current shifts</button>
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}
