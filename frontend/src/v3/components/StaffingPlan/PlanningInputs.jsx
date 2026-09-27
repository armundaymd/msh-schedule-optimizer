import { AREA_LABEL, scopeAreas } from '../../../shared/areas'
import { PLANNING_MODES, PLANNING_MODE_ORDER, frontierBudgets, planningUnits } from '../../../shared/attendingPlanner'
import { weeklyBudget, WEEKS_PER_YEAR } from '../../../shared/staffingPlan'
import { Tag } from './AssumptionStrip'

const inputCls = 'bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)] outline-none focus:border-indigo-500'
const fmtH = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const TARGET_PICKS = [90, 92.5, 95, 97.5, 99]
const num = (v, fallback = 0) => (v === '' || v == null ? fallback : Number(v))

function Pills({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} aria-pressed={value === key}
          className={`px-3 py-1 text-xs rounded transition-colors ${value === key ? 'bg-indigo-700 text-white'
            : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'}`}>{label}</button>
      ))}
    </div>
  )
}

// Optional per-area minimum coverage (blank = no area target).
function AreaTargets({ settings, onChange }) {
  const areas = scopeAreas(settings.scope)
  if (areas.length < 2) return null
  return (
    <div className="mt-2 text-xs text-[var(--c-text-secondary)]">
      <div className="text-[11px] text-[var(--c-text-muted)] mb-1">Optional per-area minimum modeled coverage <Tag kind="CONFIGURED" /></div>
      <div className="flex gap-3 flex-wrap">
        {areas.map(a => (
          <label key={a} className="flex items-center gap-1">
            {AREA_LABEL[a]} ≥
            <input type="number" min={0} max={100} step={0.5} placeholder="—" aria-label={`${AREA_LABEL[a]} minimum coverage`}
              value={settings.areaTargets?.[a] ?? ''} className={`${inputCls} w-14 text-right`}
              onChange={e => onChange({ areaTargets: { ...settings.areaTargets, [a]: e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))) } })} />%
          </label>
        ))}
      </div>
      <div className="text-[10px] text-[var(--c-text-faint)] mt-1">
        Equal targets across areas are not assumed to be clinically appropriate. ERU throughput coverage means something different:
        the model does not quantify acuity or resuscitation readiness — ERU is usually better governed by its coverage policy.
      </div>
    </div>
  )
}

export default function PlanningInputs({ settings, onChange, todayWeekly, onUseToday }) {
  const { planningMode, amount, period, allowedDeficit } = settings
  const { weeklyHours, annualHours } = weeklyBudget(amount, period)
  const budgets = frontierBudgets({ ...settings.frontier, include: [Math.round(todayWeekly)] })
  const u = planningUnits(1, settings.units)

  return (
    <div className="space-y-2">
      <Pills options={[...PLANNING_MODE_ORDER, 'requirement'].map(k => [k, PLANNING_MODES[k].label])}
        value={planningMode} onChange={v => onChange({ planningMode: v, mode: v === 'requirement' ? 'requirement' : 'budget' })} />
      <div className="text-[11px] text-[var(--c-text-muted)] italic">{PLANNING_MODES[planningMode].question}</div>

      {planningMode === 'budget' && (
        <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--c-text-secondary)]">
          <input type="number" min={0} step={100} value={amount} aria-label="Attending hours"
            onChange={e => onChange({ amount: Math.max(0, Number(e.target.value) || 0) })} className={`${inputCls} w-24 text-right`} />
          <span>attending hours per</span>
          <Pills options={[['annual', 'year'], ['weekly', 'week']]} value={period} onChange={v => onChange({ period: v })} />
          <Tag kind="CONFIGURED" />
          <span className="text-[var(--c-text-muted)] w-full">
            {period === 'annual'
              ? <>= <b className="text-[var(--c-text-strong)]">{fmtH(weeklyHours)}</b> h/week ({fmtH(amount)} ÷ {WEEKS_PER_YEAR} weeks, not rounded) — a maximum; hours that reduce no deficit are left unallocated</>
              : <>= <b className="text-[var(--c-text-strong)]">{fmtH(annualHours)}</b> h/year (× {WEEKS_PER_YEAR}) — a maximum; hours that reduce no deficit are left unallocated</>}
            {Math.abs(weeklyHours - todayWeekly) > 0.01 && (
              <> · <button onClick={onUseToday} className="text-indigo-300 hover:text-indigo-200 underline">use today&apos;s {fmtH(todayWeekly)} h/week</button></>
            )}
          </span>
        </div>
      )}

      {planningMode === 'target' && (
        <div className="text-xs text-[var(--c-text-secondary)]">
          <div className="flex items-center gap-2 flex-wrap">
            <span>Reach at least</span>
            <input type="number" min={0} max={100} step={0.5} value={settings.targetCoveragePct} aria-label="Target modeled coverage"
              onChange={e => onChange({ targetCoveragePct: Math.max(0, Math.min(100, num(e.target.value))) })} className={`${inputCls} w-16 text-right`} />
            <span>% modeled coverage (served ÷ demand, per area-hour, whole scope) with the fewest attending-hours.</span>
            <Tag kind="CONFIGURED" />
          </div>
          <div className="flex gap-1 mt-1">
            {TARGET_PICKS.map(t => (
              <button key={t} onClick={() => onChange({ targetCoveragePct: t })}
                className={`text-[10px] px-1.5 py-0.5 rounded ${settings.targetCoveragePct === t ? 'bg-indigo-700 text-white' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)]'}`}>{t}%</button>
            ))}
          </div>
          <AreaTargets settings={settings} onChange={onChange} />
        </div>
      )}

      {planningMode === 'maxUnmet' && (
        <div className="text-xs text-[var(--c-text-secondary)]">
          <div className="flex items-center gap-2 flex-wrap">
            <span>Keep modeled unmet demand at or below</span>
            <input type="number" min={0} step={5} value={settings.maxUnmetPph} aria-label="Maximum unmet patient-hours per week"
              onChange={e => onChange({ maxUnmetPph: Math.max(0, num(e.target.value)) })} className={`${inputCls} w-20 text-right`} />
            <span>patient-hours/week, with the fewest attending-hours.</span>
            <Tag kind="CONFIGURED" />
          </div>
          <AreaTargets settings={settings} onChange={onChange} />
        </div>
      )}

      {planningMode === 'minPractical' && (
        <div className="text-xs text-[var(--c-text-secondary)] space-y-1">
          <div>
            No budget. The solver (1) finds the least modeled unmet demand any number of attending-hours can reach under the rules,
            team limits and shift menu — full coverage is not assumed to be possible; (2) finds the fewest hours within a tolerance of
            it; (3) places those hours to minimise severe deficits, then excess.
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span>Treat unmet demand within</span>
            <input type="number" min={0} max={10} step={0.05} value={settings.practicalTolerancePct} aria-label="Equivalence tolerance"
              onChange={e => onChange({ practicalTolerancePct: Math.max(0, Math.min(10, num(e.target.value))) })} className={`${inputCls} w-16 text-right`} />
            <span>coverage points of the least achievable as effectively equivalent.</span>
            <Tag kind="CONFIGURED" />
          </div>
          <div className="text-[10px] text-[var(--c-text-faint)]">
            Without a tolerance, tiny fractional gains could justify large hour increases. The result is a minimum practical modeled
            requirement under these assumptions — not required clinical staffing, and not &quot;optimal staffing&quot;.
          </div>
        </div>
      )}

      {planningMode === 'frontier' && (
        <div className="text-xs text-[var(--c-text-secondary)] space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span>Budgets from</span>
            {['min', 'max', 'step'].map((k, i) => (
              <span key={k} className="flex items-center gap-1">
                {i === 1 && <span>to</span>}{i === 2 && <span>every</span>}
                <input type="number" min={0} step={k === 'step' ? 5 : 25} value={settings.frontier[k]} aria-label={`Frontier ${k}`}
                  onChange={e => onChange({ frontier: { ...settings.frontier, [k]: Math.max(0, num(e.target.value)) } })} className={`${inputCls} w-16 text-right`} />
              </span>
            ))}
            <span>h/week, plus</span>
            <input value={settings.frontier.explicit} placeholder="e.g. 624, 800" aria-label="Extra budgets"
              onChange={e => onChange({ frontier: { ...settings.frontier, explicit: e.target.value } })} className={`${inputCls} w-28`} />
          </div>
          <div className="text-[10px] text-[var(--c-text-faint)]">
            {budgets.length} solve{budgets.length === 1 ? '' : 's'} ({budgets.join(', ')}; today&apos;s hours always included).
            Each takes as long as one fixed-hours run — use Quick or Standard search to explore, Thorough before comparing closely.
          </div>
        </div>
      )}

      {planningMode === 'requirement' && (
        <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--c-text-secondary)]">
          <span>Find the fewest attending hours that leave no area short by more than</span>
          <input type="number" min={0} max={5} step={0.1} value={allowedDeficit} aria-label="Allowed deficit"
            onChange={e => onChange({ allowedDeficit: Math.max(0, Number(e.target.value) || 0) })} className={`${inputCls} w-14 text-right`} />
          <span>patients/hr in any hour.</span>
        </div>
      )}

      <details className="text-xs text-[var(--c-text-secondary)]">
        <summary className="text-[11px] text-[var(--c-text-muted)] cursor-pointer">Planning units — FTE / illustrative cost (optional)</summary>
        <div className="mt-1 flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1">Clinical hours per attending FTE per year
            <input type="number" min={0} step={50} placeholder="not set" value={settings.units.clinicalHoursPerFte ?? ''} aria-label="Clinical hours per FTE"
              onChange={e => onChange({ units: { ...settings.units, clinicalHoursPerFte: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) } })} className={`${inputCls} w-20 text-right`} />
          </label>
          <label className="flex items-center gap-1">Hourly rate $
            <input type="number" min={0} step={10} placeholder="not set" value={settings.units.hourlyRate ?? ''} aria-label="Hourly rate"
              onChange={e => onChange({ units: { ...settings.units, hourlyRate: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) } })} className={`${inputCls} w-20 text-right`} />
          </label>
          <Tag kind="CONFIGURED" />
        </div>
        <div className="text-[10px] text-[var(--c-text-faint)] mt-1">
          Nothing is assumed: FTE and cost are shown only once set. Use your institution&apos;s clinical FTE definition. Cost is an
          illustrative planning estimate (hours × rate), not institutional cost.
          {u.fte == null && u.cost == null ? '' : ' Shown next to every attending-hours result.'}
        </div>
      </details>
    </div>
  )
}
