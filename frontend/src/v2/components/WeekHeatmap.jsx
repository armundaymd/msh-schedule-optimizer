import { useEffect, useMemo, useRef, useState } from 'react'
import { AREA_LABEL, SCOPE_LABEL } from '../../shared/areas'
import { formatHour, formatPph } from '../../shared/coverageInsights'
import { analyzeWeek, weekCell, weekHourSummary, weekDaySummary, consistentPatterns, isShortStatus } from '../../shared/weekCoverage'
import { ROW_HEADER_W, hourPxForWidth } from './Timeline/layout'
import { STATUS_SWATCH, STATUS_TEXT, STATUS_TEXT_CLASS, statusBackground } from './coverageStyles'

const SHORT_DAY = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' }
const AREA_INITIAL = { main: 'M', fasttrack: 'F', eru: 'E' }
const LEGEND = ['deficit', 'adequate', 'excess', 'masked']
const CELL_H = 16
const STORAGE_KEY = 'v2-week-heatmap-open'

// Tooltip / aria-label text: the numbers behind a cell's colour.
function cellLabel(cell, scopeName, combined) {
  const lines = [
    `${cell.day} ${formatHour(cell.hour)} — ${cell.layer === 'all' ? scopeName : AREA_LABEL[cell.layer]}`,
    `Capacity − demand: ${formatPph(cell.net)} PPH (${STATUS_TEXT[cell.status]})`,
    `Capacity ${cell.capacity.toFixed(1)} / demand ${cell.demand.toFixed(1)}`,
  ]
  if (combined) {
    for (const a of cell.areas) lines.push(`${AREA_LABEL[a.area]}: ${formatPph(a.net)} (${STATUS_TEXT[a.status]})`)
  }
  return lines.join('\n')
}

// Week-at-a-glance coverage for the active scope: days as rows, hours as
// columns on the same x scale as the timeline above it. Collapsible, so it
// never takes room from the schedule editor unless asked. Clicking a cell
// selects that day and focuses that hour in the timeline.
export default function WeekHeatmap({
  days, activeDow, shiftsForDay, demand, pph, customTeams, scope, target,
  hoverHour, onSelectCell,
}) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  })
  const [layerChoice, setLayerChoice] = useState('all')
  const [width, setWidth] = useState(0)
  const ref = useRef(null)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0') } catch { /* storage disabled */ }
  }, [open])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // shiftsForDay's identity only changes when schedule data does, so hover
  // re-renders elsewhere in the app don't recompute the week.
  const week = useMemo(
    () => analyzeWeek({ days, shiftsForDay, demand, pph, customTeams, scope, target }),
    [days, shiftsForDay, demand, pph, customTeams, scope, target],
  )
  const combined = week.areas.length > 1
  // A stale per-area layer (from a previous scope) falls back to 'all'.
  const layer = layerChoice !== 'all' && week.areas.includes(layerChoice) ? layerChoice : 'all'
  const scopeName = SCOPE_LABEL[scope]
  const hourSummary = useMemo(() => weekHourSummary(week, layer), [week, layer])
  const daySummary = useMemo(() => weekDaySummary(week, layer), [week, layer])
  const patterns = useMemo(() => consistentPatterns(week, { layer }), [week, layer])
  const totalShort = daySummary.reduce((s, d) => s + d.shortHours, 0)
  const firstShort = patterns.find(p => p.kind === 'short')

  const hourPx = hourPxForWidth(width)
  const showInitials = combined && layer === 'all' && hourPx >= 26

  return (
    <div ref={ref} className="shrink-0 border-t border-[var(--c-border)] bg-[var(--c-bg-panel)]">
      {/* Header — always visible; the summary alone answers "is the week OK?" */}
      <div className="flex items-center gap-2 px-3 flex-wrap" style={{ minHeight: 28 }}>
        <button
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
        >
          <span className="text-[var(--c-text-faint)]">{open ? '▾' : '▸'}</span>
          Week coverage — {layer === 'all' ? scopeName : `${scopeName} › ${AREA_LABEL[layer]}`}
        </button>
        <span className={`text-[11px] ${totalShort > 0 ? 'text-red-400' : 'text-[var(--c-text-muted)]'}`}>
          {totalShort} short hr{totalShort === 1 ? '' : 's'}
        </span>
        {firstShort && (
          <span className="text-[11px] text-[var(--c-text-muted)] truncate">
            · consistently short {firstShort.hours.length >= 24 ? 'all day' : `${formatHour(firstShort.startHour)}–${formatHour(firstShort.endHour)}`}
          </span>
        )}
        {open && combined && (
          <div className="ml-auto flex rounded overflow-hidden border border-[var(--c-border)]" role="group" aria-label="Heatmap area">
            {['all', ...week.areas].map(l => (
              <button
                key={l}
                onClick={() => setLayerChoice(l)}
                aria-pressed={layer === l}
                className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  layer === l ? 'bg-blue-700 text-white' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
                }`}
              >
                {l === 'all' ? 'All' : AREA_LABEL[l]}
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="pb-2">
          <div className="overflow-x-auto">
            <div style={{ width: ROW_HEADER_W + hourPx * 24 }} className="relative">
              {/* Hour axis */}
              <div className="flex text-[9px] text-[var(--c-text-faint)]" style={{ height: 12 }}>
                <div style={{ width: ROW_HEADER_W }} className="shrink-0" />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{ width: hourPx }} className="text-center leading-3">
                    {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
                  </div>
                ))}
              </div>

              {week.days.map((d, i) => {
                const isActive = d.day === activeDow
                const { shortHours } = daySummary[i]
                return (
                  <div key={d.day} className="flex" style={{ height: CELL_H }}>
                    <button
                      onClick={() => onSelectCell(d.day, null)}
                      style={{ width: ROW_HEADER_W }}
                      className={`shrink-0 flex items-center justify-between px-2 text-[10px] ${
                        isActive ? 'text-blue-300 font-semibold' : 'text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
                      }`}
                      title={`${d.day}: ${shortHours} short hour${shortHours === 1 ? '' : 's'}`}
                    >
                      <span>{isActive ? '▸ ' : ''}{SHORT_DAY[d.day]}</span>
                      {shortHours > 0 && <span className="text-red-400 font-normal">{shortHours}h</span>}
                    </button>
                    {Array.from({ length: 24 }, (_, h) => {
                      const cell = weekCell(week, i, h, layer)
                      const label = cellLabel(cell, scopeName, combined)
                      return (
                        <button
                          key={h}
                          onClick={() => onSelectCell(d.day, h)}
                          title={label}
                          aria-label={label.replace(/\n/g, '. ')}
                          style={{
                            width: hourPx,
                            background: statusBackground(cell.status, cell.net),
                            boxShadow: isActive ? 'inset 0 1px 0 rgba(96,165,250,0.6), inset 0 -1px 0 rgba(96,165,250,0.6)' : undefined,
                          }}
                          className="h-full border-r border-b border-[var(--c-bg-panel)] text-[8px] font-semibold leading-none text-white/90 hover:outline hover:outline-1 hover:outline-white/70 hover:-outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
                        >
                          {showInitials && isShortStatus(cell.status) ? cell.shortAreas.map(a => AREA_INITIAL[a]).join('') : ''}
                        </button>
                      )
                    })}
                  </div>
                )
              })}

              {/* Days-short per hour: "consistently" at a glance */}
              <div className="flex mt-0.5" style={{ height: 13 }}>
                <div style={{ width: ROW_HEADER_W }} className="shrink-0 px-2 text-[9px] text-[var(--c-text-faint)] uppercase tracking-wide leading-[13px] truncate">
                  Days short
                </div>
                {hourSummary.map(s => (
                  <div
                    key={s.hour}
                    style={{ width: hourPx, background: s.shortDays ? `rgba(239,68,68,${0.1 + 0.6 * s.shortDays / week.days.length})` : undefined }}
                    className={`text-center text-[9px] leading-[13px] tabular-nums ${s.shortDays ? 'text-[var(--c-text-strong)]' : 'text-[var(--c-text-faint)]'}`}
                    title={`${formatHour(s.hour)}: short on ${s.shortDays} of ${week.days.length} days, excess on ${s.excessDays}`}
                  >
                    {s.shortDays || '·'}
                  </div>
                ))}
              </div>

              {hoverHour != null && (
                <div style={{ position: 'absolute', left: ROW_HEADER_W + hoverHour * hourPx, top: 12, bottom: 0, width: hourPx, outline: '1px solid rgba(255,255,255,0.5)', outlineOffset: -1, pointerEvents: 'none' }} />
              )}
            </div>
          </div>

          <div className="flex items-start gap-3 px-3 pt-1.5 flex-wrap">
            <ul className="flex-1 min-w-[200px] space-y-0.5">
              {patterns.length === 0 && (
                <li className="text-[11px] text-[var(--c-text-muted)]">No hour is consistently short or over-staffed across the week.</li>
              )}
              {patterns.slice(0, 3).map(p => (
                <li key={`${p.kind}-${p.startHour}`} className="text-[11px] text-[var(--c-text-secondary)] flex gap-1.5">
                  <span className={`shrink-0 ${STATUS_TEXT_CLASS[p.kind === 'short' ? 'deficit' : 'excess']}`}>{p.kind === 'short' ? '▼' : '▲'}</span>
                  {p.message}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 text-[9px] text-[var(--c-text-faint)] pt-0.5">
              {LEGEND.map(s => (
                <span key={s} className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2" style={{ background: STATUS_SWATCH[s] }} />
                  {s === 'masked' ? 'hidden short' : STATUS_TEXT[s]}
                </span>
              ))}
              {showInitials && <span>· M/F/E = short area</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
