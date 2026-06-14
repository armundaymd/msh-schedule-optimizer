import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Area,
} from 'recharts'

function shiftCoversHour(s, h) {
  const hStart = h * 60
  const hEnd = hStart + 60
  if (s.endMins <= 1440) {
    return s.startMins < hEnd && s.endMins > hStart
  }
  const wrapEnd = s.endMins - 1440
  return s.startMins < hEnd || hStart < wrapEnd
}

function teamArea(teamName, customTeams) {
  if (['Green', 'Red', 'Blue'].includes(teamName)) return 'main'
  if (teamName === 'FastTrack') return 'fasttrack'
  if (teamName === 'ERU') return 'eru'
  const ct = customTeams?.find(t => t.name === teamName)
  if (!ct) return 'main'
  return ct.area === 'FastTrack' ? 'fasttrack' : ct.area === 'ERU' ? 'eru' : 'main'
}

function computeCapacity(shifts, pph, customTeams) {
  return Array.from({ length: 24 }, (_, h) => {
    let main = 0, ft = 0, eru = 0
    for (const s of shifts) {
      if (s.role_type !== 'Attending') continue
      if (!shiftCoversHour(s, h)) continue
      const area = teamArea(s.team, customTeams)
      if (area === 'main') main++
      else if (area === 'fasttrack') ft++
      else if (area === 'eru') eru++
    }
    return main * pph.main + ft * pph.fasttrack + eru * pph.eru
  })
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const byKey = Object.fromEntries(payload.map(p => [p.dataKey, p.value]))
  return (
    <div className="bg-slate-900 border border-slate-600 rounded p-2 text-xs text-slate-200 space-y-0.5">
      <div className="font-semibold mb-1">{String(label).padStart(2,'0')}:00</div>
      {byKey.demand      != null && <div>Demand:     <span className="text-sky-300">{Number(byKey.demand).toFixed(2)}</span></div>}
      {byKey.baseline    != null && <div>Baseline:   <span className="text-slate-300">{Number(byKey.baseline).toFixed(2)}</span></div>}
      {byKey.proposed    != null && <div>Proposed:   <span className="text-blue-300">{Number(byKey.proposed).toFixed(2)}</span></div>}
      {byKey.comparison  != null && <div>Comparison: <span className="text-orange-300">{Number(byKey.comparison).toFixed(2)}</span></div>}
    </div>
  )
}

export default function CapacityChart({ day, demand, shifts, baselineShifts, pph, comparisonShifts, comparisonPph, customTeams }) {
  const demandSeries = demand
    ? (demand.Main?.by_dow?.[day] ?? demand.Main?.overall ?? [])
    : Array(24).fill(0)

  const baselineCap = computeCapacity(baselineShifts, pph, customTeams)
  const proposedCap = computeCapacity(shifts, pph, customTeams)
  const comparisonCap = comparisonShifts
    ? computeCapacity(comparisonShifts, comparisonPph ?? pph, customTeams)
    : null

  const data = Array.from({ length: 24 }, (_, h) => {
    const b = parseFloat(baselineCap[h].toFixed(2))
    const p = parseFloat(proposedCap[h].toFixed(2))
    const row = {
      hour: h,
      demand: demandSeries[h] ?? 0,
      baseline: b,
      proposed: p,
      gapGreen: p >= b ? [b, p] : [b, b],
      gapRed:   p <  b ? [p, b] : [b, b],
    }
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
          tickFormatter={h => `${String(h).padStart(2,'0')}h`}
          interval={3}
        />
        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={36} />
        <Tooltip content={<CustomTooltip />} />

        <Bar dataKey="demand" name="Demand" fill="#38bdf8" opacity={0.45} barSize={10} />

        {/* green fill where proposed > baseline */}
        <Area dataKey="gapGreen" legendType="none" fill="#22c55e" stroke="none" opacity={0.35} />
        {/* red fill where proposed < baseline */}
        <Area dataKey="gapRed" legendType="none" fill="#ef4444" stroke="none" opacity={0.35} />

        <Line dataKey="baseline" name="Baseline cap" stroke="#94a3b8" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
        <Line dataKey="proposed" name="Proposed cap" stroke="#60a5fa" strokeWidth={2} dot={false} />
        {comparisonCap && (
          <Line dataKey="comparison" name="Comparison" stroke="#fb923c" strokeWidth={1.5} dot={false} strokeDasharray="5 3" />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
