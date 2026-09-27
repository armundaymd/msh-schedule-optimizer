import { useState } from 'react'
import { AREA_LABEL } from '../../../shared/areas'
import { BOTTLENECK_LABEL, BOTTLENECK_ORDER } from '../../../shared/bottlenecks'

const fmt = (n, d = 1) => (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const HINT = {
  ATTENDING: 'Another attending fits the limits here and a permitted shift would mostly meet unmet demand.',
  RESIDENT_APP: 'An attending on duty has supervision headroom (or a FastTrack PA works solo): one more PA would add capacity without another attending. Not added — for information only.',
  OPERATIONAL: 'A configured rule blocks another attending: area closed or cross-covered, area maximum (ERU: one), or every team and the new-team pool full.',
  SHIFT_STRUCTURE: 'Another attending would help at this hour, but no permitted shift fits, or the best one would mostly add surplus.',
  MODEL: 'Neither another attending nor another resident/PA adds modeled capacity.',
}

// Why modeled deficits remain (shared/bottlenecks.js). Labels overlap: an
// hour limited two ways counts under both, so shares can sum past 100%.
export default function BottleneckPanel({ bottlenecks, title = 'Why deficits remain' }) {
  const [open, setOpen] = useState(false)
  if (!bottlenecks) return null
  const { total, byLabel, byArea, runs } = bottlenecks
  if (total < 0.05) return <div className="text-xs text-green-400">No modeled unmet demand remains.</div>
  const areas = Object.keys(byArea)
  return (
    <div className="space-y-2">
      <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-[var(--c-text-muted)] text-right">
              <th className="text-left font-normal py-1 pr-2">Unmet patient-h/week where…</th>
              <th className="font-normal py-1 px-2">All areas</th>
              <th className="font-normal py-1 px-2">Share</th>
              {areas.map(a => <th key={a} className="font-normal py-1 px-2">{AREA_LABEL[a]}</th>)}
            </tr>
          </thead>
          <tbody>
            {BOTTLENECK_ORDER.filter(l => byLabel[l] > 0.005).map(l => (
              <tr key={l} className="text-right border-t border-[var(--c-border-subtle)]">
                <td className="text-left py-1 pr-2 text-[var(--c-text-secondary)]" title={HINT[l]}>{BOTTLENECK_LABEL[l]} <span className="text-[var(--c-text-faint)]">ⓘ</span></td>
                <td className="py-1 px-2 tabular-nums">{fmt(byLabel[l])}</td>
                <td className="py-1 px-2 tabular-nums text-[var(--c-text-muted)]">{fmt((100 * byLabel[l]) / total, 0)}%</td>
                {areas.map(a => <td key={a} className="py-1 px-2 tabular-nums text-[var(--c-text-muted)]">{fmt(byArea[a].byLabel[l])}</td>)}
              </tr>
            ))}
            <tr className="text-right border-t border-[var(--c-border)] text-[var(--c-text-muted)]">
              <td className="text-left py-1 pr-2">Total unmet</td>
              <td className="py-1 px-2 tabular-nums">{fmt(total)}</td>
              <td />
              {areas.map(a => <td key={a} className="py-1 px-2 tabular-nums">{fmt(byArea[a].unmet)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-[var(--c-text-faint)]">
        An hour limited in more than one way counts in each row, so shares can exceed 100% in total. Resident/APP-limited hours are
        diagnostic only — the planner never adds, removes or moves residents or APPs.
      </div>
      <ul className="space-y-1 text-xs text-[var(--c-text-secondary)]">
        {runs.slice(0, open ? 15 : 4).map((r, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-[10px] text-[var(--c-text-faint)] shrink-0 w-28">{r.labels.map(l => BOTTLENECK_LABEL[l].replace('-limited', '')).join(' + ')}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      {runs.length > 4 && (
        <button onClick={() => setOpen(v => !v)} className="text-[11px] text-indigo-300 hover:text-indigo-200">
          {open ? 'Show fewer' : `Show ${Math.min(15, runs.length) - 4} more periods`}
        </button>
      )}
    </div>
  )
}
