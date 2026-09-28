import { DISPLAY_DEFICIT_TOLERANCE_PPH, formatHour, formatPph } from '../../../shared/coverageInsights'
import { STATUS_TEXT, statusBackground } from '../coverageStyles'
import HelpButton from '../Help/HelpButton'

// Rows of 24 cells directly under the timeline, coloured by coverage status
// per hour (PHASE 5, 5.2): short / covered / excess. `rows` is recomputed by
// the caller from live drag-preview shifts, not just the committed schedule,
// so dragging isn't blind to its own effect on coverage.
//
// A single-area scope is one row. A combined scope is an aggregate row plus
// a thinner row per component area, so a deficit in one area stays visible
// even where the aggregate is covered (that aggregate cell is red-striped).
//   rows: [{ key, label, net: number[24], status: string[24], minor? }]
export default function CoverageRibbon({ hourPx, rowHeaderW, rows, hoverHour }) {
  return (
    <div className="relative border-b border-[var(--c-border-subtle)]">
      {rows.map((row, i) => {
        const height = row.minor ? 10 : 14
        return (
          <div key={row.key} className="flex">
            <div
              style={{ width: rowHeaderW, height }}
              className={`shrink-0 flex items-center px-2 uppercase tracking-wide leading-none truncate ${
                row.minor ? 'pl-4 text-[9px] text-[var(--c-text-faint)]' : 'text-[10px] text-[var(--c-text-muted)]'
              }`}
            >
              {row.label}
              {i === 0 && <HelpButton section="colors" label="What do the coverage colours mean?" className="ml-1" />}
            </div>
            <div className="flex" style={{ width: hourPx * 24, height }}>
              {row.net.map((v, h) => (
                <div
                  key={h}
                  title={`${row.label} ${formatHour(h)} — ${formatPph(v)} PPH vs target (${STATUS_TEXT[row.status[h]]})${v < 0 && v > -DISPLAY_DEFICIT_TOLERANCE_PPH ? ` · short by ${(-v).toFixed(3)}, below the ${DISPLAY_DEFICIT_TOLERANCE_PPH} PPH display threshold` : ''}`}
                  style={{ width: hourPx, height: '100%', background: statusBackground(row.status[h], v) }}
                />
              ))}
            </div>
          </div>
        )
      })}
      {hoverHour != null && (
        <div style={{ position: 'absolute', left: rowHeaderW + hoverHour * hourPx, top: 0, bottom: 0, width: hourPx, outline: '1px solid rgba(255,255,255,0.5)', outlineOffset: -1, pointerEvents: 'none' }} />
      )}
    </div>
  )
}
