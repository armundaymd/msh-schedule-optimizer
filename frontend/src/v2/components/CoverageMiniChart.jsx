import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'

// Fixed pixel size, not ResponsiveContainer: Recharts' ResponsiveContainer
// measures its parent via ResizeObserver, which reads 0 on the first paint
// inside a just-mounted modal and never re-measures without an actual
// resize event afterward -- leaving the chart blank. A modal that renders
// once and doesn't get resized needs a fixed size instead.
//
// Shared between GeneratorResult (one "generated coverage" line) and
// OptimizeModal (a "before"/"after" pair) -- `lines` is a list of
// { key, name, color, dashed?, data } capacity series to overlay on the
// same target-demand bars.
export default function CoverageMiniChart({ label, demandSeries, lines }) {
  const data = Array.from({ length: 24 }, (_, h) => {
    const row = { hour: h, demand: demandSeries[h] ?? 0 }
    for (const line of lines) row[line.key] = parseFloat((line.data[h] ?? 0).toFixed(2))
    return row
  })
  return (
    <div className="bg-slate-950/40 rounded p-2">
      {label && <div className="text-[11px] text-slate-400 mb-1">{label}</div>}
      <ComposedChart width={280} height={110} data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={h => `${h}h`} interval={5} />
        <YAxis tick={{ fontSize: 9, fill: '#64748b' }} width={24} />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }}
          labelFormatter={h => `${String(h).padStart(2, '0')}:00`}
        />
        <Bar dataKey="demand" name="Target demand" fill="#38bdf8" opacity={0.45} barSize={6} />
        {lines.map(line => (
          <Line
            key={line.key}
            dataKey={line.key}
            name={line.name}
            stroke={line.color}
            strokeWidth={1.5}
            strokeDasharray={line.dashed ? '4 3' : undefined}
            dot={false}
          />
        ))}
      </ComposedChart>
    </div>
  )
}
