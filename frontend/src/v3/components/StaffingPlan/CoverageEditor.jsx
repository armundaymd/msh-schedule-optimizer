import { AREA_LABEL } from '../../../shared/areas'
import { formatHour } from '../../../shared/coverageInsights'
import {
  COVERAGE_MODE, COVERAGE_MODES, COVERAGE_MODE_LABEL, CROSS_COVER_CREDIT, CROSS_COVER_CREDIT_LABEL, CROSS_COVER_CREDIT_MODES,
  STRUCTURAL_MAX_ATTENDINGS, WEEK_DAYS, describeRule, effectiveMaxAttendings, validateCoverageConfig,
} from '../../../shared/operationalCoverage'
import StaffRoutingEditor from './StaffRoutingEditor'
import IntakeCutoffEditor from './IntakeCutoffEditor'

const inputCls = 'bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)] outline-none focus:border-indigo-500'
const SHORT = d => d.slice(0, 2)

function HourSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))} className={inputCls}>
      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
    </select>
  )
}

// Mode + its parameters (minimum attendings / covering area).
function ModeFields({ area, rule, areas, onChange }) {
  const others = areas.filter(a => a !== area)
  return (
    <>
      <select aria-label="Coverage mode" value={rule.mode} className={inputCls}
        onChange={e => {
          const mode = e.target.value
          const next = { mode }
          if (mode === COVERAGE_MODE.REQUIRED_DEDICATED) next.minAttendings = rule.minAttendings ?? 1
          if (mode === COVERAGE_MODE.CROSS_COVERED) next.coveredBy = rule.coveredBy ?? others[0]
          onChange(next, ['minAttendings', 'coveredBy'])
        }}>
        {COVERAGE_MODES.map(m => <option key={m} value={m}>{COVERAGE_MODE_LABEL[m]}</option>)}
      </select>
      {rule.mode === COVERAGE_MODE.REQUIRED_DEDICATED && (
        <label className="flex items-center gap-1 text-[var(--c-text-muted)]">
          ≥
          <input type="number" min={1} max={5} value={rule.minAttendings ?? 1} aria-label="Minimum attendings"
            onChange={e => onChange({ minAttendings: Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1)) })}
            className={`${inputCls} w-11`} />
        </label>
      )}
      {(rule.mode === COVERAGE_MODE.CROSS_COVERED || rule.mode === COVERAGE_MODE.FLEXIBLE) && (
        <label className="flex items-center gap-1 text-[var(--c-text-muted)]">
          {rule.mode === COVERAGE_MODE.FLEXIBLE ? 'else covered by' : 'by'}
          <select aria-label="Covering area" value={rule.coveredBy ?? ''} className={inputCls}
            onChange={e => onChange(e.target.value ? { coveredBy: e.target.value } : {}, e.target.value ? [] : ['coveredBy'])}>
            {rule.mode === COVERAGE_MODE.FLEXIBLE && <option value="">nobody</option>}
            {others.map(a => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
          </select>
        </label>
      )}
    </>
  )
}

// Most attendings at once (structural limits shown fixed), and — for areas
// that can be cross-covered — the throughput-credit ASSUMPTION.
function AreaLimits({ area, ac, coverage, onChange }) {
  const structural = STRUCTURAL_MAX_ATTENDINGS[area]
  const max = effectiveMaxAttendings(coverage, area)
  const covered = [ac.default, ...ac.rules].some(r => r.coveredBy)
  const credit = ac.crossCoverCredit ?? { mode: CROSS_COVER_CREDIT.CONSERVATIVE }
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px] text-[var(--c-text-muted)] pl-4">
      {structural != null ? (
        <span title="Structural limit: never more than this many dedicated attendings at the same time, in any scenario">
          At most <b className="text-[var(--c-text-secondary)]">{max}</b> dedicated attending{max === 1 ? '' : 's'} at once (fixed)
        </span>
      ) : (
        <label className="flex items-center gap-1">
          At most
          <input type="number" min={1} max={9} value={ac.maxAttendings ?? ''} placeholder="—" aria-label="Maximum attendings at once"
            onChange={e => {
              const v = parseInt(e.target.value, 10)
              onChange(Number.isInteger(v) && v >= 1 ? { ...ac, maxAttendings: v } : withPatch(ac, {}, ['maxAttendings']))
            }}
            className={`${inputCls} w-11`} />
          at once
        </label>
      )}
      {covered && (
        <label className="flex items-center gap-1" title="How much modeled throughput cross-coverage adds is uncertain; this is an analysis assumption, not a validated relationship">
          Cross-cover throughput credit
          <select aria-label="Cross-cover throughput credit" value={credit.mode} className={inputCls}
            onChange={e => onChange({ ...ac, crossCoverCredit: e.target.value === CROSS_COVER_CREDIT.CUSTOM
              ? { mode: e.target.value, residentCreditFraction: 1, headroomFactor: 0.2 } : { mode: e.target.value } })}>
            {CROSS_COVER_CREDIT_MODES.map(m => <option key={m} value={m}>{CROSS_COVER_CREDIT_LABEL[m]}</option>)}
          </select>
          {credit.mode === CROSS_COVER_CREDIT.CUSTOM && (
            <>
              <input type="number" min={0} max={1} step={0.1} value={credit.residentCreditFraction} aria-label="Share of resident/PA capacity credited"
                title="Share of the area's resident/PA capacity that can be credited (0–1)"
                onChange={e => onChange({ ...ac, crossCoverCredit: { ...credit, residentCreditFraction: Math.max(0, Math.min(1, Number(e.target.value) || 0)) } })}
                className={`${inputCls} w-14`} />
              × residents, ≤
              <input type="number" min={0} step={0.05} value={credit.headroomFactor} aria-label="Patients per unit of covering headroom"
                title="Patients/hr of this area credited per 1 patient/hr of the covering attendings' spare supervision capacity"
                onChange={e => onChange({ ...ac, crossCoverCredit: { ...credit, headroomFactor: Math.max(0, Number(e.target.value) || 0) } })}
                className={`${inputCls} w-14`} />
              × headroom
            </>
          )}
        </label>
      )}
    </div>
  )
}

function withPatch(obj, patch, drop = []) {
  const next = { ...obj }
  for (const k of drop) delete next[k]
  return { ...next, ...patch }
}

// Operational attending coverage per area: a default mode plus day/time
// rules (later rules win). Edits the plan's own copy; it is saved with
// scenarios and becomes the app's config when a plan is run.
export default function CoverageEditor({ coverage, enabled, onToggle, onChange, areas, allAreas, days, shiftsForDay, customTeams }) {
  const errors = validateCoverageConfig(coverage, customTeams)

  function setArea(area, next) {
    onChange({ ...coverage, areas: { ...coverage.areas, [area]: next } })
  }
  function areaCfg(area) {
    return coverage.areas[area] ?? { default: { mode: COVERAGE_MODE.FLEXIBLE }, rules: [] }
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-[var(--c-text-secondary)]">
        <input type="checkbox" checked={enabled} onChange={e => onToggle(e.target.checked)} />
        Apply operational coverage rules <span className="text-[var(--c-text-faint)]">— hard rules are satisfied first; only the remaining hours are optimized. Area maximums (ERU: one attending at a time) always apply.</span>
      </label>
      {enabled && areas.map(area => {
        const ac = areaCfg(area)
        return (
          <div key={area} className="border border-[var(--c-border-subtle)] rounded px-2 py-1.5 space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap text-xs text-[var(--c-text-secondary)]">
              <span className="font-semibold w-16">{AREA_LABEL[area]}</span>
              <span className="text-[var(--c-text-muted)]">otherwise</span>
              <ModeFields area={area} rule={ac.default} areas={allAreas}
                onChange={(p, drop) => setArea(area, { ...ac, default: withPatch(ac.default, p, drop) })} />
            </div>
            <AreaLimits area={area} ac={ac} coverage={coverage} onChange={next => setArea(area, next)} />
            {ac.rules.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 flex-wrap text-xs text-[var(--c-text-secondary)] pl-4">
                <div className="flex gap-0.5" role="group" aria-label="Days">
                  {WEEK_DAYS.map(d => {
                    const on = !r.days || r.days.includes(d)
                    return (
                      <button key={d} aria-pressed={on} title={d}
                        onClick={() => {
                          const cur = r.days ?? WEEK_DAYS
                          const days = on ? cur.filter(x => x !== d) : WEEK_DAYS.filter(x => x === d || cur.includes(x))
                          if (!days.length) return
                          setArea(area, { ...ac, rules: ac.rules.map((x, j) => (j === i ? withPatch(x, days.length === 7 ? {} : { days }, ['days']) : x)) })
                        }}
                        className={`w-5 text-[10px] rounded ${on ? 'bg-indigo-700 text-white' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-faint)]'}`}>
                        {SHORT(d)}
                      </button>
                    )
                  })}
                </div>
                <HourSelect label="From" value={r.fromHour} onChange={v => setArea(area, { ...ac, rules: ac.rules.map((x, j) => (j === i ? { ...x, fromHour: v } : x)) })} />
                <span className="text-[var(--c-text-faint)]">to</span>
                <HourSelect label="To" value={r.toHour} onChange={v => setArea(area, { ...ac, rules: ac.rules.map((x, j) => (j === i ? { ...x, toHour: v } : x)) })} />
                <ModeFields area={area} rule={r} areas={allAreas}
                  onChange={(p, drop) => setArea(area, { ...ac, rules: ac.rules.map((x, j) => (j === i ? withPatch(x, p, drop) : x)) })} />
                <button onClick={() => setArea(area, { ...ac, rules: ac.rules.filter((_, j) => j !== i) })}
                  aria-label="Remove rule" className="ml-auto text-[var(--c-text-muted)] hover:text-red-400 px-1">×</button>
                <div className="w-full text-[10px] text-[var(--c-text-faint)] pl-1">{r.label ? `${r.label}: ` : ''}{describeRule(area, r)}</div>
              </div>
            ))}
            <button
              onClick={() => setArea(area, { ...ac, rules: [...ac.rules, { fromHour: 9, toHour: 17, mode: COVERAGE_MODE.REQUIRED_DEDICATED, minAttendings: 1 }] })}
              className="text-[11px] text-indigo-300 hover:text-indigo-200 pl-4"
            >+ Add time window</button>
          </div>
        )
      })}
      {enabled && shiftsForDay && (
        <StaffRoutingEditor coverage={coverage} onChange={onChange} days={days} shiftsForDay={shiftsForDay} customTeams={customTeams} />
      )}
      {enabled && <IntakeCutoffEditor coverage={coverage} onChange={onChange} customTeams={customTeams} />}
      {enabled && errors.length > 0 && (
        <div className="text-[11px] text-red-300">{errors.join(' ')}</div>
      )}
      {enabled && (
        <div className="text-[10px] text-[var(--c-text-faint)]">
          Hours are on the 24-hour day template (an overnight window such as 19:00–07:00 wraps into the same day). A cross-covered area keeps its
          own demand, and the covering attendings are responsible for it and supervise its residents/PAs; how much throughput that adds is the
          credit assumption above (none by default — the ceiling-ratio option is unvalidated). Closed hours keep their historical demand. The ERU
          windows are today's dedicated coverage, kept as hard rules for comparison — not a clinically established minimum.
        </div>
      )}
    </div>
  )
}
