import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Area, ReferenceLine,
} from 'recharts'
import { scopeCapacity, scopeCapacityBreakdown, scopeTeamBreakdown } from '../../../shared/capacity'
import { getScopeDemandSeries } from '../../../shared/demandSeries'
import { analyzeScope } from '../../../shared/scopeAnalysis'
import { DISPLAY_DEFICIT_TOLERANCE_PPH, shortAreasAt } from '../../../shared/coverageInsights'
import { AREA_LABEL, scopeAreas, isCombinedScope } from '../../../shared/areas'

// Capacity for the active scope only — apples-to-apples with the scope's
// demand (one area, or the sum of a combined scope's areas).
function computeScopeCapacity(shifts, pph, customTeams, scope) {
  return Array.from({ length: 24 }, (_, h) => scopeCapacity(shifts, pph, customTeams, scope, h))
}

const SUPERVISION_LIMITED_COLOR = '#f59e0b'  // amber — matches tooltip's "(limiting)" tag
const STAFFING_LIMITED_COLOR    = '#2dd4bf'  // teal — distinct from the blue proposed-cap line

// Small colored marker on the "Proposed cap" line showing which side is the
// bottleneck at that hour: amber = supervision-limited, teal = staffing-limited.
// stroke cuts the dot out against the chart's own background, so it must
// track the theme rather than staying hardcoded to the dark app bg.
// Red marker on the demand line for hours where at least one component area
// of a combined scope is short — including hours the pooled total covers.
function ComponentDeficitDot({ cx, cy, payload, bgColor }) {
  if (cx == null || cy == null || !payload.shortAreas?.length) return null
  return <circle cx={cx} cy={cy} r={3.5} fill="#ef4444" stroke={bgColor} strokeWidth={1} />
}

function BottleneckDot({ cx, cy, payload, bgColor }) {
  if (cx == null || cy == null || payload.supervisionCeiling == null || payload.ownPlusExtender == null) return null
  if (payload.supervisionCeiling === payload.ownPlusExtender) return null
  const color = payload.supervisionCeiling < payload.ownPlusExtender ? SUPERVISION_LIMITED_COLOR : STAFFING_LIMITED_COLOR
  return <circle cx={cx} cy={cy} r={3} fill={color} stroke={bgColor} strokeWidth={1} />
}

// Supervision ceiling vs own throughput + extenders, for the tooltip bottleneck breakdown
function computeCapacityBreakdown(shifts, pph, customTeams, scope) {
  return Array.from({ length: 24 }, (_, h) => scopeCapacityBreakdown(shifts, pph, customTeams, scope, h))
}

// Per-individual-team breakdown (Green/Red/Blue, etc.), for the tooltip —
// shows which specific team is dragging the area total down and why.
function computeTeamBreakdowns(shifts, pph, customTeams, scope) {
  return Array.from({ length: 24 }, (_, h) => scopeTeamBreakdown(shifts, pph, customTeams, scope, h))
}

const fmtNet = n => `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}`

function CustomTooltip({ active, payload, label, target }) {
  if (!active || !payload?.length) return null
  // payload[].payload is the full source data row — includes fields (like
  // supervisionCeiling/ownPlusExtender) that aren't individually rendered as a Line/Bar.
  const byKey = { ...payload[0]?.payload, ...Object.fromEntries(payload.map(p => [p.dataKey, p.value])) }
  const ciLow  = byKey.ciLow != null ? Number(byKey.ciLow).toFixed(2) : null
  const ciHigh = ciLow != null && byKey.ciDiff != null
    ? (Number(byKey.ciLow) + Number(byKey.ciDiff)).toFixed(2)
    : null
  const demandLabel = target && target !== 'mean' ? `Demand (${target})` : 'Demand'
  return (
    <div className="bg-[var(--c-bg-panel)] border border-[var(--c-border-strong)] rounded p-2 text-xs text-[var(--c-text-secondary)] space-y-0.5">
      <div className="font-semibold mb-1">{String(label).padStart(2, '0')}:00</div>
      {byKey.demand    != null && <div>{demandLabel}: <span className="text-sky-300">{Number(byKey.demand).toFixed(2)}</span>{ciLow && <span className="text-[var(--c-text-muted)] ml-1">({ciLow}–{ciHigh} 95% CI)</span>}</div>}
      {byKey.meanOverlay != null && <div>Mean (reference): <span className="text-[var(--c-text-muted)]">{Number(byKey.meanOverlay).toFixed(2)}</span></div>}
      {byKey.baseline  != null && <div>Baseline cap: <span className="text-[var(--c-text-secondary)]">{Number(byKey.baseline).toFixed(2)}</span></div>}
      {byKey.proposed  != null && <div>Proposed cap: <span className="text-blue-300">{Number(byKey.proposed).toFixed(2)}</span></div>}
      {byKey.empirical != null && <div>Empirical cap: <span className="text-teal-300">{Number(byKey.empirical).toFixed(2)}</span></div>}
      {byKey.comparison != null && <div>Comparison: <span className="text-orange-300">{Number(byKey.comparison).toFixed(2)}</span></div>}
      {(byKey.supervisionCeiling != null || byKey.ownPlusExtender != null) && (
        <div className="border-t border-[var(--c-border)] mt-1 pt-1 text-[var(--c-text-muted)]">
          <div>
            Supervision ceiling: {Number(byKey.supervisionCeiling).toFixed(2)}
            {byKey.supervisionCeiling < byKey.ownPlusExtender && <span className="text-amber-400 ml-1">(supervision-limited)</span>}
          </div>
          <div>
            Own throughput + Resident/PA cap: {Number(byKey.ownPlusExtender).toFixed(2)}
            <span className="text-[var(--c-text-muted)] ml-1">(own {Number(byKey.ownThroughput).toFixed(2)} + ext {Number(byKey.extender).toFixed(2)})</span>
            {byKey.ownPlusExtender < byKey.supervisionCeiling && <span className="text-teal-400 ml-1">(staffing-limited)</span>}
          </div>
          {byKey.solo > 0 && (
            <div>
              + Solo PA cap (uncapped): <span className="text-[var(--c-text-secondary)]">{Number(byKey.solo).toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
      {byKey.areaBreakdown?.length > 1 && (
        <div className="border-t border-[var(--c-border)] mt-1 pt-1 text-[var(--c-text-muted)] space-y-0.5">
          <div>
            Aggregate net: <span className={byKey.net < 0 ? 'text-red-400' : 'text-green-400'}>{fmtNet(byKey.net)}</span>
          </div>
          {byKey.areaBreakdown.map(a => (
            <div key={a.area}>
              {AREA_LABEL[a.area]}: {fmtNet(a.net)}
              <span className="text-[var(--c-text-muted)]"> (cap {a.capacity.toFixed(2)} / demand {a.demand.toFixed(2)})</span>
              {a.net <= -DISPLAY_DEFICIT_TOLERANCE_PPH && <span className="text-red-400 ml-1">(deficit)</span>}
              {a.net < 0 && a.net > -DISPLAY_DEFICIT_TOLERANCE_PPH && <span className="text-[var(--c-text-faint)] ml-1">(short by {(-a.net).toFixed(3)} — below display threshold)</span>}
            </div>
          ))}
        </div>
      )}
      {byKey.teamBreakdown?.length > 0 && (
        <div className="border-t border-[var(--c-border)] mt-1 pt-1 text-[var(--c-text-muted)] space-y-0.5">
          <div className="text-[var(--c-text-muted)]">By team:</div>
          {byKey.teamBreakdown.map(t => {
            const ownPlusExt = t.ownThroughput + t.extender
            const limiter = t.supervisionCeiling === ownPlusExt ? null : t.supervisionCeiling < ownPlusExt ? 'supervision' : 'staffing'
            return (
              <div key={`${t.area}-${t.team}`}>
                {t.team}{byKey.areaBreakdown?.length > 1 ? ` (${AREA_LABEL[t.area]})` : ''}: cap {t.cap.toFixed(2)}
                <span className="text-[var(--c-text-muted)]"> (ceiling {t.supervisionCeiling.toFixed(2)} / own+ext {ownPlusExt.toFixed(2)}{t.solo > 0 ? ` / solo ${t.solo.toFixed(2)}` : ''})</span>
                {limiter && (
                  <span className={limiter === 'supervision' ? 'text-amber-400 ml-1' : 'text-teal-400 ml-1'}>
                    {limiter === 'supervision' ? '(supervision-limited)' : '(staffing-limited)'}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ROW_HEADER_W in Timeline/TeamRow.jsx — keeping this YAxis width the same
// lines hour 0 in the chart up with hour 0 in the timeline above it, so the
// two share one x scale (PHASE 5, 5.1).
const SHARED_ROW_HEADER_W = 96

export default function CapacityChart({
  day, demand, shifts, baselineShifts, pph,
  comparisonShifts, comparisonPph, customTeams,
  demandCI, empiricalPph, scope = 'main', target = 'mean',
  hoverHour, onHoverHour, theme = 'dark',
}) {
  const gridColor = theme === 'light' ? '#e2e8f0' : '#1e293b'
  const axisColor = theme === 'light' ? '#64748b' : '#94a3b8'
  const chartBg = theme === 'light' ? '#ffffff' : '#0f1117'
  const combined = isCombinedScope(scope)
  // Demand series for the active scope, at the selected target (mean or a percentile)
  const demandSeries = getScopeDemandSeries(demand, scope, day, target)
  // When a percentile is selected, show the mean as a faint reference line
  // so the gap between "average day" and "target" is visible.
  const meanSeries = target !== 'mean' ? getScopeDemandSeries(demand, scope, day, 'mean') : null

  // CI band is a bootstrap CI on the MEAN — only meaningful when comparing
  // against the mean target, so it's hidden once a percentile is selected.
  // Per-area CIs don't add, so there's no band for combined scopes either.
  const ciArea = AREA_LABEL[scopeAreas(scope)[0]]
  const ciSeries = target === 'mean' && demandCI && !combined
    ? (demandCI[ciArea]?.by_dow_ci?.[day] ?? demandCI[ciArea]?.overall_ci ?? null)
    : null

  // Capacity lines — filtered to the active scope only
  const baselineCap   = computeScopeCapacity(baselineShifts, pph,               customTeams, scope)
  const proposedCap   = computeScopeCapacity(shifts,         pph,               customTeams, scope)
  const proposedBreakdown = computeCapacityBreakdown(shifts, pph, customTeams, scope)
  const proposedTeamBreakdowns = computeTeamBreakdowns(shifts, pph, customTeams, scope)
  const scopeHours = combined
    ? analyzeScope({ shifts, demand, pph, customTeams, scope, day, target }).hours
    : null
  const empiricalCap  = empiricalPph
    ? computeScopeCapacity(shifts, empiricalPph, customTeams, scope)
    : null
  const comparisonCap = comparisonShifts
    ? computeScopeCapacity(comparisonShifts, comparisonPph ?? pph, customTeams, scope)
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
      supervisionCeiling: parseFloat(proposedBreakdown[h].supervisionCeiling.toFixed(2)),
      ownThroughput:      parseFloat(proposedBreakdown[h].ownThroughput.toFixed(2)),
      extender:           parseFloat(proposedBreakdown[h].extender.toFixed(2)),
      ownPlusExtender:    parseFloat((proposedBreakdown[h].ownThroughput + proposedBreakdown[h].extender).toFixed(2)),
      solo:               parseFloat(proposedBreakdown[h].solo.toFixed(2)),
      teamBreakdown: proposedTeamBreakdowns[h],
    }
    if (scopeHours) {
      row.net = scopeHours[h].net
      // Red dot: an area short by at least the display threshold (raw numbers stay in the tooltip).
      row.shortAreas = shortAreasAt(scopeHours[h], Object.keys(scopeHours[h].byArea), DISPLAY_DEFICIT_TOLERANCE_PPH)
      row.areaBreakdown = Object.entries(scopeHours[h].byArea).map(([area, v]) => ({ area, ...v }))
    }
    if (meanSeries) row.meanOverlay = meanSeries[h] ?? 0
    if (ciSeries?.[h] && ciSeries[h].ci_low != null && ciSeries[h].ci_high != null) {
      row.ciLow  = parseFloat(ciSeries[h].ci_low.toFixed(3))
      row.ciDiff = parseFloat(Math.max(0, ciSeries[h].ci_high - ciSeries[h].ci_low).toFixed(3))
    }
    if (empiricalCap)  row.empirical  = parseFloat(empiricalCap[h].toFixed(2))
    if (comparisonCap) row.comparison = parseFloat(comparisonCap[h].toFixed(2))
    return row
  })

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={data}
        margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
        onMouseMove={e => { if (e?.activeLabel != null) onHoverHour?.(e.activeLabel) }}
        onMouseLeave={() => onHoverHour?.(null)}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 10, fill: axisColor }}
          tickFormatter={h => `${String(h).padStart(2, '0')}h`}
          interval={3}
        />
        <YAxis tick={{ fontSize: 10, fill: axisColor }} width={SHARED_ROW_HEADER_W - 60} />
        <Tooltip content={<CustomTooltip target={target} />} />
        {hoverHour != null && <ReferenceLine x={hoverHour} stroke="#60a5fa" strokeOpacity={0.4} />}

        {/* 95% bootstrap CI band behind the demand bars (mean target only) */}
        {ciSeries && (
          <>
            <Area dataKey="ciLow"  stackId="ci" fill="transparent"           stroke="none" legendType="none" isAnimationActive={false} />
            <Area dataKey="ciDiff" stackId="ci" fill="rgba(56,189,248,0.13)" stroke="none" legendType="none" isAnimationActive={false} />
          </>
        )}

        <Bar dataKey="demand" name={target !== 'mean' ? `Demand (${target})` : 'Demand'} fill="#38bdf8" opacity={0.45} barSize={10} />
        {combined && <Line dataKey="demand" name="Component-area deficit" stroke="none" legendType="none" isAnimationActive={false} activeDot={false} dot={<ComponentDeficitDot bgColor={chartBg} />} />}
        {meanSeries && <Line dataKey="meanOverlay" name="Mean (reference)" stroke="#64748b" strokeWidth={1} strokeDasharray="2 3" dot={false} opacity={0.7} />}

        {/* green/red fill showing proposed vs baseline capacity delta */}
        <Area dataKey="gapGreen" legendType="none" fill="#22c55e" stroke="none" opacity={0.35} />
        <Area dataKey="gapRed"   legendType="none" fill="#ef4444" stroke="none" opacity={0.35} />

        <Line dataKey="baseline"   name="Baseline cap"  stroke="#94a3b8" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
        <Line dataKey="proposed"   name="Proposed cap"  stroke="#60a5fa" strokeWidth={2}   dot={<BottleneckDot bgColor={chartBg} />} />
        {empiricalCap  && <Line dataKey="empirical"  name="Empirical cap" stroke="#2dd4bf" strokeWidth={1.5} dot={false} strokeDasharray="6 3" />}
        {comparisonCap && <Line dataKey="comparison" name="Comparison"    stroke="#fb923c" strokeWidth={1.5} dot={false} strokeDasharray="5 3" />}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
