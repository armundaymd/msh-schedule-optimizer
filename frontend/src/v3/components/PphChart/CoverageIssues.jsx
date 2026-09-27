import { useState } from 'react'
import { STATUS_SWATCH, STATUS_TEXT } from '../coverageStyles'
import HelpButton from '../Help/HelpButton'

const TONE_ICON = { deficit: '▼', masked: '⚠', excess: '▲' }
const TONE_CLASS = { deficit: 'text-red-400', masked: 'text-red-400', excess: 'text-sky-400' }
const LEGEND = ['deficit', 'adequate', 'excess', 'masked']

// Deterministic coverage insights (shared/coverageInsights.js) as a short,
// collapsible list. Hovering an item highlights its worst hour on the chart
// and timeline via the shared hover hour.
export default function CoverageIssues({ insights, onHoverHour }) {
  const [open, setOpen] = useState(true)
  const shortCount = insights.filter(i => i.tone !== 'excess').length
  const excessCount = insights.length - shortCount

  return (
    <div className="shrink-0 border-t border-[var(--c-border-subtle)]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex items-center gap-1.5 text-[10px] text-[var(--c-text-muted)] uppercase tracking-wide hover:text-[var(--c-text-secondary)]"
        >
          Coverage issues
          <span className={`normal-case tracking-normal ${shortCount > 0 ? 'text-red-400' : 'text-[var(--c-text-faint)]'}`}>
            {shortCount} short
          </span>
          {excessCount > 0 && <span className="normal-case tracking-normal text-sky-400">{excessCount} excess</span>}
          <span className="text-[var(--c-text-faint)]">{open ? '▲' : '▼'}</span>
        </button>
        <HelpButton section="coverage-issues" label="What do these findings mean?" />
        <div className="ml-auto flex items-center gap-2 text-[9px] text-[var(--c-text-faint)]">
          {LEGEND.map(s => (
            <span key={s} className="flex items-center gap-1" title={STATUS_TEXT[s]}>
              <span className="inline-block w-2.5 h-2" style={{ background: STATUS_SWATCH[s] }} />
              {s === 'masked' ? 'hidden short' : STATUS_TEXT[s]}
            </span>
          ))}
        </div>
      </div>
      {open && (
        <ul className="max-h-32 overflow-y-auto px-3 pb-2 space-y-0.5">
          {insights.length === 0 && (
            <li className="text-xs text-[var(--c-text-muted)]">Every hour is covered in every area, with no notable excess.</li>
          )}
          {insights.map(i => (
            <li
              key={i.id}
              onMouseEnter={() => onHoverHour?.(i.peakHour)}
              onMouseLeave={() => onHoverHour?.(null)}
              className={`flex gap-1.5 text-xs rounded px-1 -mx-1 hover:bg-[var(--c-bg-surface-hover)] ${
                i.tone === 'excess' ? 'text-[var(--c-text-muted)]' : 'text-[var(--c-text-secondary)]'
              }`}
            >
              <span className={`shrink-0 text-[10px] mt-0.5 ${TONE_CLASS[i.tone]}`}>{TONE_ICON[i.tone]}</span>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
