import { formatHour } from '../../../shared/coverageInsights'
import {
  COVERAGE_MODE, ERU_SCENARIO_PRESETS, dedicatedWindowFeasibility, describeWindow, withEruDedicatedCoverage, windowHours,
} from '../../../shared/operationalCoverage'
import { planPatterns } from '../../utils/patterns'

const inputCls = 'bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)] outline-none focus:border-indigo-500'

function HourSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))} className={inputCls}>
      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
    </select>
  )
}

// One window row: on/off + from/to.
function WindowRow({ label, window, onChange }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-[var(--c-text-secondary)]">
      <label className="flex items-center gap-1 w-24">
        <input type="checkbox" checked={!!window} onChange={e => onChange(e.target.checked ? { fromHour: 9, toHour: 17 } : null)} />
        {label}
      </label>
      {window ? (
        <>
          <HourSelect label={`${label} from`} value={window.fromHour} onChange={v => onChange({ ...window, fromHour: v })} />
          <span className="text-[var(--c-text-faint)]">to</span>
          <HourSelect label={`${label} to`} value={window.toHour} onChange={v => onChange({ ...window, toHour: v })} />
          <span className="text-[10px] text-[var(--c-text-faint)]">{windowHours(window)} h/day{window.fromHour === window.toHour ? ' (24 h)' : ''}</span>
        </>
      ) : <span className="text-[10px] text-[var(--c-text-faint)]">no dedicated ERU attending</span>}
    </div>
  )
}

// ERU dedicated-coverage scenario: writes ERU's rules into the plan's
// operational coverage config (the same config the editor below shows —
// day-specific exceptions are added there). The allocator then places the
// REST of the budget.
export default function EruScenarioPicker({ settings, onChange, days }) {
  const sc = settings.eruScenario ?? { preset: 'config' }
  const patterns = planPatterns(settings.startMode, settings.lengths)
  const fit = dedicatedWindowFeasibility(settings.coverage, 'eru', days, patterns)

  function apply(next) {
    const outside = next.outside ?? COVERAGE_MODE.CROSS_COVERED
    const preset = ERU_SCENARIO_PRESETS[next.preset]
    const coverage = withEruDedicatedCoverage(settings.coverage, {
      weekday: next.weekday, weekend: next.weekend, outside,
      name: preset?.short ?? 'custom', basis: next.preset === 'current' ? 'current-schedule' : 'scenario',
    })
    onChange({ eruScenario: next, coverage })
  }
  function choosePreset(key) {
    if (key === 'config') { onChange({ eruScenario: { preset: 'config' } }); return }
    const p = ERU_SCENARIO_PRESETS[key]
    apply({ preset: key, weekday: p.weekday, weekend: p.weekend, outside: sc.outside ?? COVERAGE_MODE.CROSS_COVERED })
  }
  const editable = sc.preset !== 'config'
  const current = ERU_SCENARIO_PRESETS.current

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--c-text-secondary)]">
        <select aria-label="ERU scenario" value={sc.preset} onChange={e => choosePreset(e.target.value)} className={inputCls}>
          <option value="config">As in the coverage rules below</option>
          {Object.entries(ERU_SCENARIO_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          <option value="custom">Custom window</option>
        </select>
        {editable && (
          <label className="flex items-center gap-1 text-[var(--c-text-muted)]">
            outside the window
            <select aria-label="ERU outside the dedicated window" value={sc.outside ?? COVERAGE_MODE.CROSS_COVERED} className={inputCls}
              onChange={e => apply({ ...sc, outside: e.target.value })}>
              <option value={COVERAGE_MODE.CROSS_COVERED}>Main cross-covers (no dedicated ERU)</option>
              <option value={COVERAGE_MODE.FLEXIBLE}>Allocator may add ERU hours; else Main covers</option>
            </select>
          </label>
        )}
      </div>
      {editable && (
        <div className="pl-2 space-y-1">
          <WindowRow label="Mon–Fri" window={sc.weekday} onChange={w => apply({ ...sc, preset: 'custom', weekday: w })} />
          <WindowRow label="Sat–Sun" window={sc.weekend} onChange={w => apply({ ...sc, preset: 'custom', weekend: w })} />
        </div>
      )}
      <div className="text-[10px] text-[var(--c-text-faint)]">
        {editable && ERU_SCENARIO_PRESETS[sc.preset]?.note && <>{ERU_SCENARIO_PRESETS[sc.preset].note} </>}
        Current ERU coverage for reference: Mon–Fri {describeWindow(current.weekday)}, Sat–Sun {describeWindow(current.weekend)}. ERU never has more than one
        attending at once. Day-specific exceptions: edit ERU&apos;s rules under Operational coverage.
      </div>
      {fit && (fit.feasible
        ? <div className="text-[11px] text-[var(--c-text-muted)]">ERU dedicated attending-hours: <b className="text-[var(--c-text-secondary)]">{fit.minHours} h/week</b> (fits the shift menu with one ERU attending at a time).</div>
        : <div className="text-[11px] text-amber-300">
            The shift menu can&apos;t staff this window with one ERU attending at a time: {fit.byDay.filter(d => !d.feasible).map(d => `${d.day.slice(0, 3)} (${d.required} h)`).join(', ')} have no non-overlapping
            combination of allowed shifts that fits. The run will be refused rather than breaking the rule.
          </div>)}
      <label className="flex items-center gap-1.5 text-[11px] text-[var(--c-text-muted)]">
        <input type="checkbox" checked={!!settings.compareCurrentEru} onChange={e => onChange({ compareCurrentEru: e.target.checked })} />
        Also solve with Current ERU coverage (same budget) and compare
      </label>
    </div>
  )
}
