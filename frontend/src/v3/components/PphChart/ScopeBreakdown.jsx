import { AREA_LABEL, SCOPE_LABEL } from '../../../shared/areas'
import { DISPLAY_DEFICIT_TOLERANCE_PPH, hourSnapshot, worstHour, formatHour, formatPph } from '../../../shared/coverageInsights'
import { STATUS_TEXT, STATUS_TEXT_CLASS } from '../coverageStyles'

// One-line readout for a combined scope: aggregate capacity − demand and each
// component area's, at the hovered hour (shared with the timeline) or, with
// nothing hovered, the day's worst hour. e.g.
//   18:00 (worst) · Whole ED −3.4 | Main −2.7 | FastTrack −1.2 | ERU +0.5
export default function ScopeBreakdown({ analysis, hoverHour }) {
  const hour = hoverHour ?? worstHour(analysis)
  const snap = hourSnapshot(analysis, hour, { deficitTolerance: DISPLAY_DEFICIT_TOLERANCE_PPH })
  const masked = snap.aggregate.status === 'masked'

  return (
    <div
      className="flex items-center gap-x-2 gap-y-0.5 px-3 pt-1.5 text-[11px] text-[var(--c-text-muted)] flex-wrap"
      title="Capacity − demand (PPH). Capacity doesn't transfer between areas, so an area below zero is understaffed whatever the total shows."
    >
      <span className="tabular-nums">
        {formatHour(hour)}
        {hoverHour == null && <span className="text-[var(--c-text-faint)]"> (worst)</span>}
      </span>
      <span className="text-[var(--c-text-faint)]">·</span>
      <span title={STATUS_TEXT[snap.aggregate.status]}>
        {SCOPE_LABEL[analysis.scope]}{' '}
        <span className={`font-semibold tabular-nums ${STATUS_TEXT_CLASS[snap.aggregate.status]}`}>{formatPph(snap.aggregate.net)}</span>
        {masked && <span className="text-red-400 ml-0.5" title="Total is covered, but an area below is short">⚠</span>}
      </span>
      {snap.areas.map(a => (
        <span key={a.area} className="flex items-center gap-1" title={`${AREA_LABEL[a.area]}: ${STATUS_TEXT[a.status]}`}>
          <span className="text-[var(--c-border-strong)]">|</span>
          {AREA_LABEL[a.area]}
          <span className={`font-semibold tabular-nums ${STATUS_TEXT_CLASS[a.status]}`}>{formatPph(a.net)}</span>
        </span>
      ))}
    </div>
  )
}
