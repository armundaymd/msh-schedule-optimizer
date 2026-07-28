import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Area,
} from 'recharts'
import { teamCapacity, attendingCapacity, extenderCapacity } from '../../utils/capacity'

// Maps team name → area key used in pph object
const AREA_KEY = { Main: 'main', FastTrack: 'fasttrack', ERU: 'eru' }

// Capacity for one team type only — apples-to-apples with per-team demand
function computeTeamCapacity(shifts, pph, customTeams, team) {
  const areaKey = AREA_KEY[team] ?? 'main'
  return Array.from({ length: 24 }, (_, h) => teamCapacity(shifts, pph, customTeams, areaKey, h))
}

const ATTENDING_LIMITED_COLOR = '#f59e0b'  // amber — matches tooltip's "(limiting)" tag
const EXTENDER_LIMITED_COLOR  = '#2dd4bf'  // teal — distinct from the blue proposed-cap line

// Small colored marker on the "Proposed cap" line showing which side is the
// bottleneck at that hour: amber = attending-limited, teal = resident/PA-limited.
function BottleneckDot({ cx, cy, payload }) {
  if (cx == null || cy == null || payload.attendingCap == null || payload.extenderCap == null) return null
  if (payload.attendingCap === payload.extenderCap) return null
  const color = payload.attendingCap < payload.extenderCap ? ATTENDING_LIMITED_COLOR : EXTENDER_LIMITED_COLOR
  return <circle cx={cx} cy={cy} r={3} fill={color} stroke="#0f1117" strokeWidth={1} />
}

// Attending-only vs extender-only capacity, for the tooltip bottleneck breakdown
function computeCapacityBreakdown(shifts, pph, customTeams, team) {
  const areaKey = AREA_KEY[team] ?? 'main'
  return Array.from({ length: 24 }, (_, h) => ({
    attending: attendingCapacity(shifts, pph, customTeams, areaKey, h),
    extender:  extenderCapacity(shifts, pph, customTeams, areaKey, h),
  }))
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  // payload[].payload is the full source data row — includes fields (like
  // attendingCap/extenderCap) that aren't individually rendered as a Line/Bar.
  const byKey = { ...payload[0]?.payload, ...Object.fromEntries(payload.map(p => [p.dataKey, p.value])) }
  const ciLow  = byKey.ciLow != null ? Number(byKey.ciLow).toFixed(2) : null
  const ciHigh = ciLow != null && byKey.ciDiff != null
    ? (Number(byKey.ciLow) + Number(byKey.ciDiff)).toFixed(2)
    : null
  return (
    <div className="bg-slate-900 border border-slate-600 rounded p-2 text-xs text-slate-200 space-y-0.5">
      <div className="font-semibold mb-1">{String(label).padStart(2, '0')}:00</div>
      {byKey.demand    != null && <div>Demand: <span className="text-sky-300">{Number(byKey.demand).toFixed(2)}</span>{ciLow && <span className="text-slate-500 ml-1">({ciLow}–{ciHigh} 95% CI)</span>}</div>}
      {byKey.baseline  != null && <div>Baseline cap: <span className="text-slate-300">{Number(byKey.baseline).toFixed(2)}</span></div>}
      {byKey.proposed  != null && <div>Proposed cap: <span className="text-blue-300">{Number(byKey.proposed).toFixed(2)}</span></div>}
      {byKey.empirical != null && <div>Empirical cap: <span className="text-teal-300">{Number(byKey.empirical).toFixed(2)}</span></div>}
      {byKey.comparison != null && <div>Comparison: <span className="text-orange-300">{Number(byKey.comparison).toFixed(2)}</span></div>}
      {(byKey.attendingCap != null || byKey.extenderCap != null) && (
        <div className="border-t border-slate-700 mt-1 pt-1 text-slate-400">
          <div>
            Attending cap: {Number(byKey.attendingCap).toFixed(2)}
            {byKey.attendingCap < byKey.extenderCap && <span className="text-amber-400 ml-1">(limiting)</span>}
          </div>
          <div>
            Resident/PA cap: {Number(byKey.extenderCap).toFixed(2)}
            {byKey.extenderCap < byKey.attendingCap && <span className="text-amber-400 ml-1">(limiting)</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function CapacityChart({
  day, demand, shifts, baselineShifts, pph,
  comparisonShifts, comparisonPph, customTeams,
  demandCI, empiricalPph, activeTeam = 'Main',
}) {
  // Demand series for the active team only
  const demandSeries = demand
    ? (demand[activeTeam]?.by_dow?.[day] ?? demand[activeTeam]?.overall ?? [])
    : Array(24).fill(0)

  // CI series for the active team
  const ciSeries = demandCI
    ? (demandCI[activeTeam]?.by_dow_ci?.[day] ?? demandCI[activeTeam]?.overall_ci ?? null)
    : null

  // Capacity lines — filtered to active team only
  const baselineCap   = computeTeamCapacity(baselineShifts, pph,               customTeams, activeTeam)
  const proposedCap   = computeTeamCapacity(shifts,         pph,               customTeams, activeTeam)
  const proposedBreakdown = computeCapacityBreakdown(shifts, pph, customTeams, activeTeam)
  const empiricalCap  = empiricalPph
    ? computeTeamCapacity(shifts, empiricalPph, customTeams, activeTeam)
    : null
  const comparisonCap = comparisonShifts
    ? computeTeamCapacity(comparisonShifts, comparisonPph ?? pph, customTeams, activeTeam)
    : null

  const data = Array.from({ length: 24 }, (_, h) => {
    const b = parseFloat(baselineCap[h].toFixed(2))
    const p = parseFloat(proposedCap[h].toFixed(2))
    const row = {
      hour:     h,
      demand:   demandSeries[h] ?? 0,
      baseline: b,
      proposed: p,
      gapGreen: p >= b ? [b, p] : [b, b],
      gapRed:   p <  b ? [p, b] : [b, b],
      attendingCap: parseFloat(proposedBreakdown[h].attending.toFixed(2)),
      extenderCap:  parseFloat(proposedBreakdown[h].extender.toFixed(2)),
    }
    if (ciSeries?.[h]) {
      row.ciLow  = parseFloat(ciSeries[h].ci_low.toFixed(3))
      row.ciDiff = parseFloat(Math.max(0, ciSeries[h].ci_high - ciSeries[h].ci_low).toFixed(3))
    }
    if (empiricalCap)  row.empirical  = parseFloat(empiricalCap[h].toFixed(2))
    if (comparisonCap) row.comparison = parseFloat(comparisonCap[h].toFixed(2))
    return row
  })

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickFormatter={h => `${String(h).padStart(2, '0')}h`}
          interval={3}
        />
        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={36} />
        <Tooltip content={<CustomTooltip />} />

        {/* 95% bootstrap CI band behind the demand bars */}
        {ciSeries && (
          <>
            <Area dataKey="ciLow"  stackId="ci" fill="transparent"           stroke="none" legendType="none" isAnimationActive={false} />
            <Area dataKey="ciDiff" stackId="ci" fill="rgba(56,189,248,0.13)" stroke="none" legendType="none" isAnimationActive={false} />
          </>
        )}

        <Bar dataKey="demand" name="Demand" fill="#38bdf8" opacity={0.45} barSize={10} />

        {/* green/red fill showing proposed vs baseline capacity delta */}
        <Area dataKey="gapGreen" legendType="none" fill="#22c55e" stroke="none" opacity={0.35} />
        <Area dataKey="gapRed"   legendType="none" fill="#ef4444" stroke="none" opacity={0.35} />

        <Line dataKey="baseline"   name="Baseline cap"  stroke="#94a3b8" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
        <Line dataKey="proposed"   name="Proposed cap"  stroke="#60a5fa" strokeWidth={2}   dot={<BottleneckDot />} />
        {empiricalCap  && <Line dataKey="empirical"  name="Empirical cap" stroke="#2dd4bf" strokeWidth={1.5} dot={false} strokeDasharray="6 3" />}
        {comparisonCap && <Line dataKey="comparison" name="Comparison"    stroke="#fb923c" strokeWidth={1.5} dot={false} strokeDasharray="5 3" />}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
