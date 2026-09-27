import { AREAS, AREA_LABEL, teamsInArea } from '../../../shared/areas'
import { formatHour } from '../../../shared/coverageInsights'
import { routedShifts, unroutedClosedAreaShifts } from '../../../shared/operationalCoverage'

const inputCls = 'bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--c-text-strong)] outline-none focus:border-indigo-500'

function HourSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))} className={inputCls}>
      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
    </select>
  )
}

const shiftText = ({ day, shift, hours }) =>
  `${day.slice(0, 3)} ${shift.team} ${shift.role_detail || shift.role_type} ${shift.start_time}–${shift.end_time}${hours ? ` (${hours.length} h)` : ''}`

// Staff operating-area routing: WHERE a resident/PA works at a given
// day/time, separate from the team recorded in the schedule. Patients never
// move. Every affected shift is listed so the department can confirm it.
export default function StaffRoutingEditor({ coverage, onChange, days, shiftsForDay, customTeams }) {
  const rules = coverage.staffRouting ?? []
  const allTeams = [...new Set(AREAS.flatMap(a => teamsInArea(a, customTeams)))]
  const set = next => onChange({ ...coverage, staffRouting: next })
  const update = (i, patch) => set(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const routed = routedShifts(coverage, days, shiftsForDay)
  const unrouted = unroutedClosedAreaShifts(coverage, days, shiftsForDay, customTeams)

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-[var(--c-text-muted)]">
        Staff operating area <span className="text-[var(--c-text-faint)]">— where residents/PAs work at a given time (the schedule record is not changed; patients never move)</span>
      </div>
      {rules.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-wrap text-xs text-[var(--c-text-secondary)] pl-2">
          <select aria-label="Source team" value={r.match?.team ?? ''} onChange={e => update(i, { match: { ...r.match, team: e.target.value } })} className={inputCls}>
            {allTeams.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span className="text-[var(--c-text-muted)]">staff whose role ends in</span>
          <input aria-label="Role detail suffix" value={r.match?.roleDetailSuffix ?? ''} placeholder="(any)"
            onChange={e => update(i, { match: { ...r.match, roleDetailSuffix: e.target.value || undefined } })}
            className={`${inputCls} w-16`} />
          <HourSelect label="From" value={r.fromHour} onChange={v => update(i, { fromHour: v })} />
          <span className="text-[var(--c-text-faint)]">to</span>
          <HourSelect label="To" value={r.toHour} onChange={v => update(i, { toHour: v })} />
          <span className="text-[var(--c-text-muted)]">work on</span>
          <select aria-label="Destination team" value={`${r.to?.area}|${r.to?.team}`}
            onChange={e => { const [area, team] = e.target.value.split('|'); update(i, { to: { area, team } }) }} className={inputCls}>
            {AREAS.flatMap(a => teamsInArea(a, customTeams).map(t => <option key={`${a}|${t}`} value={`${a}|${t}`}>{AREA_LABEL[a]} · {t}</option>))}
          </select>
          <label className="flex items-center gap-1 text-[11px]" title="Confirmed by the department (otherwise inferred from the schedule)">
            <input type="checkbox" checked={!!r.confirmed} onChange={e => update(i, { confirmed: e.target.checked })} /> confirmed
          </label>
          <button onClick={() => set(rules.filter((_, j) => j !== i))} aria-label="Remove routing rule" className="ml-auto text-[var(--c-text-muted)] hover:text-red-400 px-1">×</button>
          <div className="w-full text-[10px] text-[var(--c-text-faint)] pl-1">
            {r.label ?? ''}{r.days?.length && r.days.length < 7 ? ` · ${r.days.map(d => d.slice(0, 3)).join(', ')}` : ''}
            {!r.confirmed && r.basis === 'role-detail-suffix' && ' · inferred from the role_detail suffix in the schedule — needs confirmation'}
          </div>
        </div>
      ))}
      <button
        onClick={() => set([...rules, { fromHour: 1, toHour: 7, match: { team: 'FastTrack' }, to: { area: 'main', team: 'Green' }, confirmed: false }])}
        className="text-[11px] text-indigo-300 hover:text-indigo-200 pl-2"
      >+ Add routing rule</button>
      <details className="text-[10px] text-[var(--c-text-faint)] pl-2">
        <summary className="cursor-pointer">{routed.length} shift{routed.length === 1 ? '' : 's'} routed this week{unrouted.length ? ` · ${unrouted.length} on duty in a closed area with no routing (credited nothing)` : ''}</summary>
        <ul className="mt-1 space-y-0.5">
          {routed.map((x, i) => <li key={`r${i}`}>{shiftText(x)} → {x.rule.to.team} ({AREA_LABEL[x.rule.to.area]}){x.rule.confirmed ? '' : ' · unconfirmed'}</li>)}
          {unrouted.map((x, i) => <li key={`u${i}`} className="text-amber-300">{shiftText(x)} — area closed, no routing rule: where does this shift work?</li>)}
        </ul>
      </details>
    </div>
  )
}
