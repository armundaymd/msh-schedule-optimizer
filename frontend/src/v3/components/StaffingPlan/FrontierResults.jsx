import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AREA_LABEL } from '../../../shared/areas'
import { diminishingReturns, marginalRows, planningUnits } from '../../../shared/attendingPlanner'
import { Tag } from './AssumptionStrip'

const fmt = (n, d = 1) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }))
const AXIS = '#94a3b8'
const LINE = '#818cf8'
const METRICS = {
  unmet: { label: 'Modeled unmet patient-h/week', get: r => r.unmet, fmt: v => fmt(v) },
  coverage: { label: 'Modeled coverage %', get: r => 100 * r.coverage, fmt: v => `${fmt(v)}%` },
}

function FrontierTooltip({ active, payload, metric }) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  return (
    <div className="bg-[var(--c-bg-panel)] border border-[var(--c-border-strong)] rounded px-2 py-1.5 text-[11px] text-[var(--c-text-secondary)] shadow-lg">
      <div className="font-semibold text-[var(--c-text-strong)]">{fmt(r.budget, 0)} h/week budget</div>
      <div>{METRICS[metric].label}: <b>{METRICS[metric].fmt(METRICS[metric].get(r))}</b></div>
      <div className="text-[var(--c-text-muted)]">
        {Object.entries(r.hoursByArea).map(([a, h]) => `${AREA_LABEL[a]} ${fmt(h, 0)} h`).join(' · ')}
      </div>
      {r.carriedForward && <div className="text-amber-300">Search did not beat the {fmt(r.carriedFrom, 0)} h plan; that plan is shown.</div>}
    </div>
  )
}

// markers: { current, selected, target: { hours, unmet, coverage, label }, minPractical: {...} }
export default function FrontierResults({ rows, markers = {}, units = {}, onViewPoint, noise = 0 }) {
  const [metric, setMetric] = useState('unmet')
  const ok = rows.filter(r => r.feasible)
  const marg = marginalRows(rows, { noise })
  const dr = diminishingReturns(rows, { noise })
  const M = METRICS[metric]
  const val = m => (metric === 'unmet' ? m.unmet : 100 * m.coverage)
  const pointMarkers = [
    markers.target && { ...markers.target, name: markers.target.label ?? 'Coverage target', color: '#34d399' },
    markers.minPractical && { ...markers.minPractical, name: 'Minimum practical', color: '#f59e0b' },
  ].filter(Boolean)
  const perHour = Object.fromEntries(marg.map(m => [m.to, m]))
  const anyUnits = planningUnits(1, units)

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide">Resource frontier</span>
          <Tag kind="CALCULATED" />
          <div className="ml-auto flex rounded overflow-hidden border border-[var(--c-border)]" role="group" aria-label="Frontier metric">
            {Object.entries(METRICS).map(([k, m]) => (
              <button key={k} onClick={() => setMetric(k)} aria-pressed={metric === k}
                className={`px-2 py-0.5 text-[10px] ${metric === k ? 'bg-indigo-700 text-white' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)]'}`}>{m.label}</button>
            ))}
          </div>
        </div>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={ok} margin={{ top: 16, right: 16, bottom: 18, left: 4 }}>
              <CartesianGrid stroke="var(--c-border-subtle)" vertical={false} />
              <XAxis dataKey="budget" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10, fill: AXIS }}
                label={{ value: 'Attending-hours / week', position: 'insideBottom', offset: -10, fontSize: 10, fill: AXIS }} />
              <YAxis tick={{ fontSize: 10, fill: AXIS }} width={44} domain={['auto', 'auto']} />
              <Tooltip content={<FrontierTooltip metric={metric} />} />
              {markers.current != null && <ReferenceLine x={markers.current} stroke={AXIS} strokeDasharray="3 3"
                label={{ value: `today ${fmt(markers.current, 0)} h`, position: 'top', fontSize: 10, fill: AXIS }} />}
              {markers.selected != null && Math.abs(markers.selected - (markers.current ?? -1)) > 0.5 && (
                <ReferenceLine x={markers.selected} stroke={LINE} strokeDasharray="2 4"
                  label={{ value: `selected ${fmt(markers.selected, 0)} h`, position: 'insideTopRight', fontSize: 10, fill: LINE }} />
              )}
              <Line dataKey={r => M.get(r)} name={M.label} stroke={LINE} strokeWidth={2} isAnimationActive={false}
                dot={{ r: 4, fill: LINE, stroke: 'var(--c-bg-panel)', strokeWidth: 2 }} activeDot={{ r: 6 }} />
              {pointMarkers.map(m => (
                <ReferenceDot key={m.name} x={m.hours} y={val(m)} r={6} fill={m.color} stroke="var(--c-bg-panel)" strokeWidth={2}
                  label={{ value: m.name, position: 'right', fontSize: 10, fill: 'var(--c-text-secondary)' }} ifOverflow="extendDomain" />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="text-[10px] text-[var(--c-text-faint)]">
          Each point: the best attending allocation found at that budget, scored with the app&apos;s capacity model. Hover for the
          area split; click a table row to open that plan. Points are warm-started from the previous one and never shown worse than it.
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-[var(--c-text-muted)] text-right">
              <th className="text-left font-normal py-1 pr-2">Budget h/wk</th>
              <th className="font-normal py-1 px-1.5">Used</th>
              <th className="font-normal py-1 px-1.5">Main</th>
              <th className="font-normal py-1 px-1.5">FT</th>
              <th className="font-normal py-1 px-1.5">ERU</th>
              {anyUnits.fte != null && <th className="font-normal py-1 px-1.5">≈FTE</th>}
              <th className="font-normal py-1 px-1.5">Coverage</th>
              <th className="font-normal py-1 px-1.5">Unmet</th>
              <th className="font-normal py-1 px-1.5">Main</th>
              <th className="font-normal py-1 px-1.5">FT</th>
              <th className="font-normal py-1 px-1.5">ERU</th>
              <th className="font-normal py-1 px-1.5">Excess</th>
              <th className="font-normal py-1 px-1.5" title="Reduction in modeled unmet patient-h per additional budgeted attending-hour, vs the previous row">Δ unmet / h</th>
              <th className="font-normal py-1 px-1.5">Solver</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (r.feasible ? (
              <tr key={r.budget} onClick={() => onViewPoint?.(r.budget)} className="text-right border-t border-[var(--c-border-subtle)] cursor-pointer hover:bg-[var(--c-bg-surface)]">
                <td className="text-left py-1 pr-2 text-[var(--c-text-secondary)] tabular-nums">{fmt(r.budget, 0)}{r.carriedForward && <span className="text-amber-300" title={`Search did not beat the ${r.carriedFrom} h plan; that plan is shown`}> ↺</span>}</td>
                <td className="py-1 px-1.5 tabular-nums">{fmt(r.hours, 0)}</td>
                {['main', 'fasttrack', 'eru'].map(a => <td key={a} className="py-1 px-1.5 tabular-nums text-[var(--c-text-muted)]">{fmt(r.hoursByArea[a], 0)}</td>)}
                {anyUnits.fte != null && <td className="py-1 px-1.5 tabular-nums text-[var(--c-text-muted)]">{fmt(planningUnits(r.hours, units).fte, 1)}</td>}
                <td className="py-1 px-1.5 tabular-nums">{fmt(100 * r.coverage)}%</td>
                <td className="py-1 px-1.5 tabular-nums">{fmt(r.unmet)}</td>
                {['main', 'fasttrack', 'eru'].map(a => <td key={a} className="py-1 px-1.5 tabular-nums text-[var(--c-text-muted)]">{fmt(r.unmetByArea[a])}</td>)}
                <td className="py-1 px-1.5 tabular-nums text-[var(--c-text-muted)]">{fmt(r.excess)}</td>
                <td className="py-1 px-1.5 tabular-nums">{perHour[r.budget] ? <>{fmt(perHour[r.budget].perHour, 2)}{perHour[r.budget].withinNoise && <span className="text-[var(--c-text-faint)]" title="Within search uncertainty"> ~</span>}</> : '—'}</td>
                <td className="py-1 px-1.5 text-[var(--c-text-faint)] whitespace-nowrap">{r.status === 'optimal' ? 'optimal' : `gap ${fmt(100 * (r.gap ?? 0))}%`}</td>
              </tr>
            ) : (
              <tr key={r.budget} className="border-t border-[var(--c-border-subtle)] text-amber-300">
                <td className="py-1 pr-2 tabular-nums">{fmt(r.budget, 0)}</td>
                <td colSpan={13} className="py-1 px-1.5">No plan: {r.message}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide">Marginal value of additional attending-hours</div>
        <ul className="text-xs text-[var(--c-text-secondary)] space-y-0.5">
          {dr.facts.map(f => <li key={f.to}>{f.text}.</li>)}
        </ul>
        {dr.knee && (
          <div className="text-[11px] text-[var(--c-text-muted)]">
            Descriptive knee (the point farthest from the straight line between the ends of this curve): {fmt(dr.knee.budget, 0)} h/week.
            This describes the curve&apos;s shape — it is not a recommended staffing level.
          </div>
        )}
        <div className="text-[10px] text-[var(--c-text-faint)]">
          Modeled unmet demand reduction is not clinical value or patient outcome. Gaps of a few percent mean neighbouring points
          that differ by a few patient-hours should be read as ties{noise > 0 ? ` (~ = within ${fmt(noise)} patient-h)` : ''}.
        </div>
      </div>
    </div>
  )
}
