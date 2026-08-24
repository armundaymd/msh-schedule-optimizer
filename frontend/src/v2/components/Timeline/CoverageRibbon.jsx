const MAX_MAGNITUDE = 6 // deviation (patients/hr) at which color saturates

function colorFor(v) {
  const mag = Math.min(Math.abs(v), MAX_MAGNITUDE) / MAX_MAGNITUDE
  const alpha = 0.12 + mag * 0.6
  return v >= 0 ? `rgba(34,197,94,${alpha})` : `rgba(239,68,68,${alpha})`
}

// One row of 24 cells directly under the timeline, coloured by
// capacity - target per hour (PHASE 5, 5.2). `values[h]` is recomputed by
// the caller from live drag-preview shifts, not just the committed
// schedule, so dragging isn't blind to its own effect on coverage.
export default function CoverageRibbon({ hourPx, rowHeaderW, values, hoverHour }) {
  return (
    <div className="flex border-b border-[var(--c-border-subtle)]">
      <div style={{ width: rowHeaderW }} className="shrink-0 flex items-center px-2 text-[10px] text-[var(--c-text-muted)] uppercase tracking-wide">
        Coverage
      </div>
      <div className="relative flex" style={{ width: hourPx * 24, height: 14 }}>
        {values.map((v, h) => (
          <div
            key={h}
            title={`${String(h).padStart(2, '0')}:00 — ${v >= 0 ? '+' : ''}${v.toFixed(1)} vs target`}
            style={{ width: hourPx, height: '100%', background: colorFor(v) }}
          />
        ))}
        {hoverHour != null && (
          <div style={{ position: 'absolute', left: hoverHour * hourPx, top: 0, bottom: 0, width: hourPx, outline: '1px solid rgba(255,255,255,0.5)', outlineOffset: -1, pointerEvents: 'none' }} />
        )}
      </div>
    </div>
  )
}
