import { useMemo } from 'react'
import { teamCapacity } from '../../shared/capacity'
import { getDemandSeries } from '../../shared/demandSeries'
import { computeShiftCost } from '../../shared/cost'

const AREAS = ['main', 'fasttrack', 'eru']
const AREA_LABEL = { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }

// Per-area deficit: each area's demand can only be met by that area's own
// capacity (Main demand vs whole-ED capacity was the bug — see PHASE 2, 2.1).
// Returns the count of distinct hours where ANY area is short, plus a
// per-area breakdown for the tooltip.
function computeOverflowByArea(shifts, demand, pph, day, customTeams, target) {
  const hoursShort = new Set()
  const byArea = {}
  for (const area of AREAS) {
    const series = getDemandSeries(demand, AREA_LABEL[area], day, target)
    let count = 0
    for (let h = 0; h < 24; h++) {
      const cap = teamCapacity(shifts, pph, customTeams, area, h)
      if ((series[h] ?? 0) > cap) {
        count++
        hoursShort.add(h)
      }
    }
    byArea[AREA_LABEL[area]] = count
  }
  return { anyAreaHours: hoursShort.size, byArea }
}

function attendingHours(shifts) {
  return shifts
    .filter(s => s.role_type === 'Attending')
    .reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
}

function MetricCard({ label, value, valueColor, title }) {
  return (
    <div className="bg-[var(--c-bg-tile)] rounded px-3 py-1.5 min-w-[90px]" title={title}>
      <div className="text-[10px] text-[var(--c-text-muted)] uppercase tracking-wide leading-tight">{label}</div>
      <div className="text-sm font-semibold mt-0.5" style={{ color: valueColor ?? 'var(--c-text-strong)' }}>
        {value}
      </div>
    </div>
  )
}

const currency = n => `$${Math.round(n).toLocaleString()}`

export default function SummaryStatsBar({ shifts, baselineShifts, demand, day, pph, customTeams, weekBreakdown, activeDow, costRates, costModeEnabled, target = 'mean' }) {
  const stats = useMemo(() => {
    const proposed = attendingHours(shifts)
    const baseline = attendingHours(baselineShifts)
    const delta = proposed - baseline

    const { anyAreaHours, byArea } = computeOverflowByArea(shifts, demand, pph, day, customTeams, target)

    const cost = costRates ? computeShiftCost(shifts, costRates) : 0
    const costBaseline = costRates ? computeShiftCost(baselineShifts, costRates) : 0

    return {
      totalHours: proposed,
      delta,
      extraPatients: delta !== 0 ? Math.round(delta * pph.main) : null,
      overflow: anyAreaHours,
      overflowByArea: byArea,
      totalShifts: shifts.length,
      cost,
      costDelta: cost - costBaseline,
    }
  }, [shifts, baselineShifts, demand, day, pph, customTeams, costRates, target])

  const sign = stats.delta >= 0 ? '+' : ''

  const weekTotal   = weekBreakdown?.reduce((s, d) => s + d.proposed, 0) ?? 0
  const weekDelta   = weekBreakdown?.reduce((s, d) => s + d.delta, 0) ?? 0
  const weekShifts  = weekBreakdown?.reduce((s, d) => s + d.attendingShifts, 0) ?? 0
  const yearlyHours = Math.round(weekTotal * 52)
  const wSign = weekDelta >= 0 ? '+' : ''

  const weekCost      = weekBreakdown?.reduce((s, d) => s + (d.cost ?? 0), 0) ?? 0
  const weekCostBase  = weekBreakdown?.reduce((s, d) => s + (d.costBaseline ?? 0), 0) ?? 0
  const weekCostDelta = weekCost - weekCostBase

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-[var(--c-bg-panel)] border-b border-[var(--c-border-subtle)] shrink-0 flex-wrap">
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
        title={`Hours where any area is short of capacity. By area: ${
          Object.entries(stats.overflowByArea).map(([a, n]) => `${a} ${n}`).join(', ')
        }`}
      />
      <MetricCard label="Total shifts" value={stats.totalShifts} />
      {costModeEnabled && (
        <>
          <MetricCard label={`${day.slice(0,3)} est. cost`} value={currency(stats.cost)} />
          <MetricCard
            label="Cost vs baseline"
            value={`${stats.costDelta >= 0 ? '+' : '-'}${currency(Math.abs(stats.costDelta))}`}
            valueColor={stats.costDelta > 0 ? '#ef4444' : stats.costDelta < 0 ? '#22c55e' : '#94a3b8'}
          />
        </>
      )}

      {weekBreakdown && <>
        {/* Divider */}
        <div className="w-px self-stretch bg-[var(--c-btn-bg)] mx-1" />

        {/* Week aggregate cards */}
        <MetricCard label="Week attending hrs" value={weekTotal.toFixed(1)} />
        <MetricCard
          label="Week vs baseline"
          value={`${wSign}${weekDelta.toFixed(1)} hrs`}
          valueColor={weekDelta > 0 ? '#22c55e' : weekDelta < 0 ? '#ef4444' : '#94a3b8'}
        />
        <MetricCard label="Week attending shifts" value={weekShifts} />
        <MetricCard label="Yearly hrs (×52)" value={yearlyHours.toLocaleString()} />
        {costModeEnabled && (
          <MetricCard
            label="Week est. cost"
            value={currency(weekCost)}
            valueColor={weekCostDelta > 0 ? '#ef4444' : weekCostDelta < 0 ? '#22c55e' : undefined}
          />
        )}

        {/* Divider */}
        <div className="w-px self-stretch bg-[var(--c-btn-bg)] mx-1" />

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
              <div className="text-[9px] text-[var(--c-text-muted)] uppercase tracking-wide leading-tight">{d.slice(0,3)}</div>
              <div className="text-xs font-semibold text-[var(--c-text-secondary)] mt-0.5">{proposed.toFixed(0)}</div>
              <div className="text-[9px] font-medium" style={{ color: deltaColor }}>{s}{delta.toFixed(0)}</div>
            </div>
          )
        })}
      </>}
    </div>
  )
}
