import { describeCrossCoverCredit, describeWindow, ERU_SCENARIO_PRESETS } from '../../../shared/operationalCoverage'
import { PLANNING_MODES } from '../../../shared/attendingPlanner'
import { PLAN_START_MODES } from '../../utils/patterns'

// What every planner result rests on, tagged by where each value comes from:
//   OBSERVED   from data (historical arrivals, today's schedule)
//   CONFIGURED chosen in the planner (rules, targets, shift menu)
//   ASSUMED    model assumptions (productivity, cross-cover credit)
//   CALCULATED solver / model output
const PROVENANCE = {
  OBSERVED: 'text-sky-300 border-sky-700/60',
  CONFIGURED: 'text-indigo-300 border-indigo-700/60',
  ASSUMED: 'text-amber-300 border-amber-700/60',
  CALCULATED: 'text-emerald-300 border-emerald-700/60',
}

export function Tag({ kind }) {
  return <span className={`text-[9px] font-semibold tracking-wide border rounded px-1 py-px ${PROVENANCE[kind]}`}>{kind}</span>
}

function eruText(settings) {
  if (!settings.useCoverage) return 'operational rules off (ERU max one still applies)'
  const sc = settings.eruScenario ?? { preset: 'config' }
  if (sc.preset === 'config') return 'as in the coverage rules'
  const p = ERU_SCENARIO_PRESETS[sc.preset]
  return `${p?.label ?? 'Custom'} — Mon–Fri ${describeWindow(sc.weekday)}, Sat–Sun ${describeWindow(sc.weekend)}`
}

// resultText: the attending-hours result line (CALCULATED), or null.
export default function AssumptionStrip({ settings, pph, resultText }) {
  const credit = settings.useCoverage ? describeCrossCoverCredit(settings.coverage?.areas?.eru?.crossCoverCredit, pph) : 'n/a'
  const rows = [
    ['CONFIGURED', 'Planning question', PLANNING_MODES[settings.planningMode]?.label ?? '—'],
    ['CONFIGURED', 'Operational scenario', eruText(settings)],
    ['OBSERVED', 'Demand', `historical arrivals by area, day and hour — ${settings.target === 'mean' ? 'mean' : settings.target} (configured statistic)`],
    ['ASSUMED', 'Cross-cover throughput', credit],
    ['CONFIGURED', 'Shift structure', `${PLAN_START_MODES[settings.startMode]?.label ?? settings.startMode} × ${settings.lengths.join('/')} h`],
    ['OBSERVED', 'Residents/APPs', 'today\'s schedule, fixed — never added, removed or moved; productivity per level is ASSUMED'],
    ...(resultText ? [['CALCULATED', 'Attending-hours result', resultText]] : []),
  ]
  return (
    <div className="text-[10px] border border-[var(--c-border)] rounded px-2 py-1.5 space-y-0.5">
      {rows.map(([kind, label, text]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <span className="w-[74px] shrink-0"><Tag kind={kind} /></span>
          <span className="text-[var(--c-text-muted)] w-36 shrink-0">{label}</span>
          <span className="text-[var(--c-text-secondary)]">{text}</span>
        </div>
      ))}
      <div className="text-[var(--c-text-faint)] pt-0.5">
        Modeled coverage is not observed throughput; unmet patient-hours are not wait times; a calculated staffing level is not a clinical staffing requirement.
      </div>
    </div>
  )
}
