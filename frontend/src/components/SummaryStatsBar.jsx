import { useMemo } from 'react'
import { capacityAllAreas } from '../utils/capacity'

function computeCapacity(shifts, pph, customTeams) {
  return Array.from({ length: 24 }, (_, h) => {
    const byArea = capacityAllAreas(shifts, pph, customTeams, h)
    return byArea.main + byArea.fasttrack + byArea.eru
  })
}

function attendingHours(shifts) {
  return shifts
    .filter(s => s.role_type === 'Attending')
    .reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
}

function MetricCard({ label, value, valueColor }) {
  return (
    <div className="bg-slate-900/60 rounded px-3 py-1.5 min-w-[90px]">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide leading-tight">{label}</div>
      <div className="text-sm font-semibold mt-0.5" style={{ color: valueColor ?? '#e2e8f0' }}>
        {value}
      </div>
    </div>
  )
}

export default function SummaryStatsBar({ shifts, baselineShifts, demand, day, pph, customTeams, weekBreakdown, activeDow }) {
  const stats = useMemo(() => {
    const proposed = attendingHours(shifts)
    const baseline = attendingHours(baselineShifts)
    const delta = proposed - baseline

    const demandSeries = demand
      ? (demand.Main?.by_dow?.[day] ?? demand.Main?.overall ?? [])
      : Array(24).fill(0)
    const proposedCap = computeCapacity(shifts, pph, customTeams)
    const overflow = demandSeries.filter((d, h) => d > proposedCap[h]).length

    return {
      totalHours: proposed,
      delta,
      extraPatients: delta !== 0 ? Math.round(delta * pph.main) : null,
      overflow,
      totalShifts: shifts.length,
    }
  }, [shifts, baselineShifts, demand, day, pph, customTeams])

  const sign = stats.delta >= 0 ? '+' : ''

  const weekTotal   = weekBreakdown?.reduce((s, d) => s + d.proposed, 0) ?? 0
  const weekDelta   = weekBreakdown?.reduce((s, d) => s + d.delta, 0) ?? 0
  const weekShifts  = weekBreakdown?.reduce((s, d) => s + d.attendingShifts, 0) ?? 0
  const yearlyHours = Math.round(weekTotal * 52)
  const wSign = weekDelta >= 0 ? '+' : ''

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-[#131620] border-b border-slate-800 shrink-0 flex-wrap">
      {/* Today metrics */}
      <MetricCard label={`${day.slice(0,3)} attending hrs`} value={stats.totalHours.toFixed(1)} />
      <MetricCard
        label="vs baseline"
        value={`${sign}${stats.delta.toFixed(1)} hrs`}
        valueColor={stats.delta > 0 ? '#22c55e' : stats.delta < 0 ? '#ef4444' : '#94a3b8'}
      />
      {stats.extraPatients !== null && (
        <MetricCard
          label="Est. extra pts/wk"
          value={(stats.extraPatients >= 0 ? '+' : '') + stats.extraPatients}
          valueColor={stats.extraPatients > 0 ? '#22c55e' : '#ef4444'}
        />
      )}
      <MetricCard
        label="Overflow hrs"
        value={stats.overflow}
        valueColor={stats.overflow > 0 ? '#f59e0b' : '#94a3b8'}
      />
      <MetricCard label="Total shifts" value={stats.totalShifts} />

      {weekBreakdown && <>
        {/* Divider */}
        <div className="w-px self-stretch bg-slate-700 mx-1" />

        {/* Week aggregate cards */}
        <MetricCard label="Week attending hrs" value={weekTotal.toFixed(1)} />
        <MetricCard
          label="Week vs baseline"
          value={`${wSign}${weekDelta.toFixed(1)} hrs`}
          valueColor={weekDelta > 0 ? '#22c55e' : weekDelta < 0 ? '#ef4444' : '#94a3b8'}
        />
        <MetricCard label="Week attending shifts" value={weekShifts} />
        <MetricCard label="Yearly hrs (×52)" value={yearlyHours.toLocaleString()} />

        {/* Divider */}
        <div className="w-px self-stretch bg-slate-700 mx-1" />

        {/* Per-day breakdown */}
        {weekBreakdown.map(({ day: d, proposed, delta }) => {
          const isActive = d === activeDow
          const deltaColor = delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#64748b'
          const s = delta >= 0 ? '+' : ''
          return (
            <div
              key={d}
              className="flex flex-col items-center px-2 py-1 rounded"
              style={{ minWidth: 44, background: isActive ? 'rgba(96,165,250,0.08)' : 'transparent', borderBottom: isActive ? '2px solid #60a5fa' : '2px solid transparent' }}
            >
              <div className="text-[9px] text-slate-500 uppercase tracking-wide leading-tight">{d.slice(0,3)}</div>
              <div className="text-xs font-semibold text-slate-200 mt-0.5">{proposed.toFixed(0)}</div>
              <div className="text-[9px] font-medium" style={{ color: deltaColor }}>{s}{delta.toFixed(0)}</div>
            </div>
          )
        })}
      </>}
    </div>
  )
}
