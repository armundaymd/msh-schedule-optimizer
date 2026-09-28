import { AREAS, teamsInArea } from '../../../shared/areas'
import { formatHour } from '../../../shared/coverageInsights'
import { intakeCutoffsOf } from '../../../shared/operationalCoverage'

const inputCls = 'bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)] outline-none focus:border-indigo-500'

function HourSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))} className={inputCls}>
      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
    </select>
  )
}

// Intake cutoffs: when a team that closes for the night stops taking NEW
// patients (so they are finished rather than signed out to Green/Red). Part
// of the operational coverage config, so edits are saved with scenarios.
export default function IntakeCutoffEditor({ coverage, onChange, customTeams }) {
  const ic = intakeCutoffsOf(coverage) ?? { teams: [], extraTeamsHoursBeforeEnd: 0 }
  const rows = ic.teams ?? []
  const allTeams = [...new Set(AREAS.flatMap(a => teamsInArea(a, customTeams)))]
  const set = patch => onChange({ ...coverage, intakeCutoffs: { ...ic, ...patch } })
  const update = (i, patch) => set({ teams: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-[var(--c-text-muted)]">
        No new patients <span className="text-[var(--c-text-faint)]">— a team closed to new patients adds no capacity against demand (its patients go to the teams still open); its staff still work and its residents still need its attending</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-wrap text-xs text-[var(--c-text-secondary)] pl-2">
          <select aria-label="Team" value={r.team} onChange={e => update(i, { team: e.target.value, label: undefined })} className={inputCls}>
            {allTeams.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span className="text-[var(--c-text-muted)]">takes no new patients from</span>
          <HourSelect label="From" value={r.fromHour} onChange={v => update(i, { fromHour: v, label: undefined })} />
          <span className="text-[var(--c-text-faint)]">until</span>
          <HourSelect label="Until" value={r.toHour} onChange={v => update(i, { toHour: v, label: undefined })} />
          <button onClick={() => set({ teams: rows.filter((_, j) => j !== i) })} aria-label="Remove cutoff" className="ml-auto text-[var(--c-text-muted)] hover:text-red-400 px-1">×</button>
          {r.label && <div className="w-full text-[10px] text-[var(--c-text-faint)] pl-1">{r.label}{r.basis === 'confirmed-operational-rule' ? ' · confirmed' : ''}</div>}
        </div>
      ))}
      <button onClick={() => set({ teams: [...rows, { team: 'Blue', fromHour: 20, toHour: 7 }] })} className="text-[11px] text-indigo-300 hover:text-indigo-200 pl-2">
        + Add team cutoff
      </button>
      <div className="flex items-center gap-1.5 flex-wrap text-xs text-[var(--c-text-secondary)] pl-2">
        <span className="text-[var(--c-text-muted)]">Teams added by the planner, Generator or Auto-optimize take no new patients in the last</span>
        <input type="number" min={0} max={12} aria-label="Hours before coverage ends" value={ic.extraTeamsHoursBeforeEnd ?? 0}
          onChange={e => set({ extraTeamsHoursBeforeEnd: Math.max(0, Math.min(12, Math.round(Number(e.target.value)) || 0)) })}
          className={`${inputCls} w-12 text-right`} />
        <span className="text-[var(--c-text-muted)]">h of their coverage, unless another attending continues it (0 = off)</span>
      </div>
    </div>
  )
}
