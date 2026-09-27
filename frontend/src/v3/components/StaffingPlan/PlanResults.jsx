import { useState } from 'react'
import { AREA_LABEL, SCOPE_LABEL } from '../../../shared/areas'
import { formatHour } from '../../../shared/coverageInsights'
import { consistentPatterns } from '../../../shared/weekCoverage'
import { WEEKS_PER_YEAR } from '../../../shared/staffingPlan'
import { planningUnits } from '../../../shared/attendingPlanner'
import WeekHeatmap from '../WeekHeatmap'
import AssumptionStrip, { Tag } from './AssumptionStrip'
import BottleneckPanel from './BottleneckPanel'

const SHORT_DAY = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' }
const fmt = (n, d = 1) => (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtH = n => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })

function Tile({ label, value, sub, tone }) {
  return (
    <div className="bg-[var(--c-bg-tile)] rounded px-3 py-2 min-w-[120px]">
      <div className="text-[10px] text-[var(--c-text-muted)] uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 ${tone ?? 'text-[var(--c-text-strong)]'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--c-text-faint)] mt-0.5">{sub}</div>}
    </div>
  )
}

function H({ children }) {
  return <div className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide mb-1.5">{children}</div>
}

// "12.0 → 4.3" with the change coloured green/red when lower is better;
// neutral (lowerIsBetter = null) for quantities that aren't good or bad
// in themselves, like hours allocated.
function Delta({ before, after, digits = 1, lowerIsBetter = true }) {
  const diff = after - before
  const better = lowerIsBetter !== null && diff < -1e-9
  const worse = lowerIsBetter !== null && diff > 1e-9
  return (
    <span className="tabular-nums">
      <span className="text-[var(--c-text-muted)]">{fmt(before, digits)}</span>
      <span className="text-[var(--c-text-faint)]"> → </span>
      <span className={better ? 'text-green-400' : worse ? 'text-red-400' : 'text-[var(--c-text-secondary)]'}>{fmt(after, digits)}</span>
    </span>
  )
}

function CoverageTable({ before, after, scope }) {
  const rows = [...Object.keys(after.byArea).map(a => [AREA_LABEL[a], before.byArea[a], after.byArea[a], false])]
  if (rows.length > 1) rows.push([`${SCOPE_LABEL[scope]} (pooled)`, before.aggregate, after.aggregate, true])
  const cols = [
    ['Uncovered patients/hr·h', 'uncoveredPphHours', 1, 'Sum over the week of how far demand exceeds capacity, hour by hour'],
    ['Short hours', 'deficitHours', 0, 'Hours where demand exceeds capacity'],
    ['Severe hours', 'severeDeficitHours', 0, 'Hours more than 2 patients/hr short'],
    ['No attending, demand', 'unattendedDemandHours', 0, 'Hours with expected patients, no attending in the area, and (with operational coverage on) no cross-coverage'],
    ['Excess hours', 'excessHours', 0, 'Hours with surplus beyond the excess threshold'],
    ['Attending h/wk', 'attendingHours', 1, null],
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-[var(--c-text-muted)] text-right">
            <th className="text-left font-normal py-1 pr-2">Current → proposed, per week</th>
            {cols.map(([label, , , title]) => <th key={label} className="font-normal py-1 px-2 whitespace-nowrap" title={title ?? undefined}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, b, a, pooled]) => (
            <tr key={label} className={`text-right border-t border-[var(--c-border-subtle)] ${pooled ? 'text-[var(--c-text-muted)]' : ''}`}>
              <td className="text-left py-1 pr-2 text-[var(--c-text-secondary)] whitespace-nowrap"
                title={pooled ? 'Pooled totals can hide a short area behind another area\'s surplus — shown for reference only; the optimizer never uses them.' : undefined}>
                {label}{pooled && <span className="text-[var(--c-text-faint)]"> ⓘ</span>}
              </td>
              {cols.map(([l, key, digits]) => (
                <td key={l} className="py-1 px-2">
                  {pooled && key === 'unattendedDemandHours' ? <span className="text-[var(--c-text-faint)]">—</span>
                    : <Delta before={b[key]} after={a[key]} digits={digits} lowerIsBetter={key !== 'attendingHours' ? true : null} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// How each area's hours were covered, and what the operational rules cost.
// Cross-covered hours are shown apart from dedicated ones: they are not
// equivalent to the area having its own attending.
function OperationalTable({ before, after }) {
  const areas = Object.keys(after.byArea)
  const rows = [
    ['Attending h/wk', m => m.attendingHours, 1, null, 'Attending-hours in the area'],
    ['Hard-rule hours', m => m.requiredAttendingHours, 1, null, 'Attending-hours the hard dedicated-coverage rules ask for (minimum × hours) — e.g. current ERU dedicated coverage'],
    ['Beyond the rules', m => m.voluntaryAttendingHours, 1, null, 'Attending-hours placed beyond the hard rules — chosen for throughput'],
    ['Hard-rule hours unmet', m => m.requiredShortfallHours, 0, true, 'Hours in a hard-rule window with fewer attendings than the rule (always 0 in a plan)'],
    ['Dedicated attending (h)', m => m.hoursDedicated, 0, null, 'Hours the area had its own attending'],
    ['Cross-covered (h)', m => m.hoursCrossCovered, 0, null, 'Hours with no own attending, covering area responsible — not the same as a dedicated attending'],
    ['Flexible, no attending (h)', m => m.hoursFlexibleUncovered, 0, null, 'Flexible hours with no attending and no covering area'],
    ['Closed (h)', m => m.hoursClosedUncovered, 0, null, 'Closed hours (demand still counted)'],
    ['Unmet patient-h', m => m.unmet, 1, true, 'Demand above modeled capacity, summed over the week'],
    ['Cross-cover throughput credit', m => m.crossCovered.credit, 1, null, 'Patient-hours of capacity credited to cross-covered hours under the selected assumption (0 when conservative)'],
    ['… unmet during cross-cover', m => m.crossCovered.unmet, 1, true, 'Unmet demand in cross-covered hours'],
    ['… while closed', m => m.closed.unmet, 1, true, 'Historical demand recorded in closed hours that nothing covers'],
    ['Unsupervised resident/PA h', m => m.unsupervisedExtenderHours, 0, true, 'Hours residents/PAs are on with no attending and no cross-coverage (their work is credited as 0)'],
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-[var(--c-text-muted)] text-right">
            <th className="text-left font-normal py-1 pr-2">Current → proposed, per week</th>
            {areas.map(a => <th key={a} className="font-normal py-1 px-2">{AREA_LABEL[a]}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, get, digits, lowerIsBetter, title]) => (
            <tr key={label} className="text-right border-t border-[var(--c-border-subtle)]">
              <td className="text-left py-1 pr-2 text-[var(--c-text-secondary)] whitespace-nowrap" title={title}>{label}</td>
              {areas.map(a => (
                <td key={a} className="py-1 px-2">
                  <Delta before={get(before.operational[a])} after={get(after.operational[a])} digits={digits} lowerIsBetter={lowerIsBetter} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {Object.entries(after.operational).map(([a, m]) => Object.entries(m.coveringLoad).map(([covered, load]) => (
        <div key={`${a}-${covered}`} className="text-[10px] text-[var(--c-text-faint)] mt-1">
          {AREA_LABEL[covered]} patients credited as served under {AREA_LABEL[a]} cross-cover: {fmt(load)} patient-h/wk in the proposed plan (depends on the throughput-credit assumption; responsibility is the same either way).
        </div>
      )))}
    </div>
  )
}

// Scenario vs the same run with Current ERU coverage: where attending-hours
// moved and what changed in modeled coverage / unmet demand. Decision
// support only — throughput does not measure ERU's acuity coverage.
function EruComparison({ plan }) {
  const base = plan.eruBaseline
  const areas = Object.keys(plan.after.byArea)
  const parts = [['07–15', h => h >= 7 && h < 15], ['15–23', h => h >= 15 && h < 23], ['23–07', h => h >= 23 || h < 7]]
  // Attending-hours on duty in an area within a time band, over the week.
  const onDuty = (m, area, test) => m.week.days.reduce((t, { analysis }) =>
    t + analysis.hours.filter(r => test(r.hour)).reduce((u, r) => u + (r.byArea[area]?.coverage?.ownAttendings ?? 0), 0), 0)
  const pct = m => (m.demand > 0 ? (100 * m.served) / m.demand : 100)
  const rows = [
    ...areas.map(a => [`${AREA_LABEL[a]} attending h`, m => m.byArea[a].attendingHours, 0, null]),
    ...areas.flatMap(a => parts.map(([lbl, test]) => [`  ${AREA_LABEL[a]} on duty ${lbl} (attending-h)`, m => onDuty(m, a, test), 0, null])),
    ['Unmet patient-h (all areas)', m => m.componentUncoveredPphHours, 1, true],
    ...areas.map(a => [`Unmet ${AREA_LABEL[a]}`, m => m.byArea[a].uncoveredPphHours, 1, true]),
    ['Modeled coverage %', m => pct(Object.values(m.operational).reduce((t, x) => ({ demand: t.demand + x.demand, served: t.served + x.served }), { demand: 0, served: 0 })), 1, false],
    ['ERU dedicated hours', m => m.operational.eru?.hoursDedicated ?? 0, 0, null],
    ['ERU cross-covered hours', m => m.operational.eru?.hoursCrossCovered ?? 0, 0, null],
  ]
  const gap = r => `${r.result.status === 'optimal' ? 'optimal' : 'best found'} · gap ${fmt((r.result.stats?.relativeGap ?? 0) * 100, 1)}%`
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-[var(--c-text-muted)] text-right">
            <th className="text-left font-normal py-1 pr-2">Per week, same budget</th>
            <th className="font-normal py-1 px-2">Current ERU coverage</th>
            <th className="font-normal py-1 px-2">This scenario</th>
            <th className="font-normal py-1 px-2">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, get, digits, lowerIsBetter]) => {
            const b = get(base.after), a = get(plan.after), d = a - b
            const tone = lowerIsBetter === null || Math.abs(d) < 1e-9 ? '' : (lowerIsBetter ? d < 0 : d > 0) ? 'text-green-400' : 'text-red-400'
            return (
              <tr key={label} className="text-right border-t border-[var(--c-border-subtle)]">
                <td className="text-left py-1 pr-2 text-[var(--c-text-secondary)] whitespace-pre">{label}</td>
                <td className="py-1 px-2 tabular-nums">{fmt(b, digits)}</td>
                <td className="py-1 px-2 tabular-nums">{fmt(a, digits)}</td>
                <td className={`py-1 px-2 tabular-nums ${tone}`}>{d > 0 ? '+' : ''}{fmt(d, digits)}</td>
              </tr>
            )
          })}
          <tr className="text-right border-t border-[var(--c-border-subtle)] text-[var(--c-text-muted)]">
            <td className="text-left py-1 pr-2">Solver</td>
            <td className="py-1 px-2">{gap(base)}</td>
            <td className="py-1 px-2">{gap(plan)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <div className="text-[10px] text-[var(--c-text-faint)] mt-1">
        Modeled throughput opportunity cost only. Dedicated ERU coverage also provides acuity coverage and resuscitation readiness that
        this model does not measure. Differences of a few patient-hours are within search noise — try Thorough search before comparing closely.
      </div>
    </div>
  )
}

function Bars({ items, unit = 'h', max }) {
  const top = max ?? Math.max(1, ...items.map(i => i.value))
  return (
    <div className="flex items-end gap-1 h-16">
      {items.map(i => (
        <div key={i.key} className="flex-1 flex flex-col items-center justify-end h-full min-w-0" title={`${i.label}: ${fmtH(i.value)} ${unit}${i.title ? ` — ${i.title}` : ''}`}>
          <div className="w-full rounded-t bg-indigo-500/70" style={{ height: `${(i.value / top) * 100}%`, minHeight: i.value > 0 ? 2 : 0 }} />
          <div className="text-[9px] text-[var(--c-text-faint)] mt-0.5 truncate">{i.short ?? i.label}</div>
        </div>
      ))}
    </div>
  )
}

function Allocation({ after, days, annual }) {
  const areas = Object.entries(after.byArea)
  const total = areas.reduce((t, [, m]) => t + m.attendingHours, 0)
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      <div>
        <div className="text-[11px] text-[var(--c-text-muted)] mb-1">By area</div>
        <div className="space-y-1">
          {areas.map(([a, m]) => (
            <div key={a} className="text-xs">
              <div className="flex justify-between text-[var(--c-text-secondary)]">
                <span>{AREA_LABEL[a]}</span>
                <span className="tabular-nums">{fmtH(m.attendingHours)} h/wk{annual && <span className="text-[var(--c-text-faint)]"> · {fmtH(m.attendingHours * WEEKS_PER_YEAR)} h/yr</span>}</span>
              </div>
              <div className="h-1.5 rounded bg-[var(--c-bg-surface)] mt-0.5">
                <div className="h-full rounded bg-indigo-500/70" style={{ width: `${total ? (m.attendingHours / total) * 100 : 0}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[11px] text-[var(--c-text-muted)] mb-1">By day (attending hours)</div>
        <Bars items={days.map(d => ({ key: d, label: d, short: SHORT_DAY[d], value: after.byDay[d] }))} />
      </div>
      <div>
        <div className="text-[11px] text-[var(--c-text-muted)] mb-1">By time of day (attendings on, summed over the week)</div>
        <Bars unit="attending-hours" items={after.byHour.map((v, h) => ({ key: h, label: formatHour(h), short: h % 6 === 0 ? String(h).padStart(2, '0') : '', value: v }))} />
      </div>
    </div>
  )
}

function RemainingProblems({ after, scope, onRequireCoverage }) {
  const patterns = consistentPatterns(after.week).filter(p => p.kind === 'short')
  const unattended = Object.entries(after.byArea).filter(([, m]) => m.unattendedDemandHours > 0)
  const excess = consistentPatterns(after.week).filter(p => p.kind === 'excess')
  if (!patterns.length && !unattended.length && !excess.length) {
    return <div className="text-xs text-green-400">No area is consistently short, and every hour with demand has an attending.</div>
  }
  return (
    <ul className="space-y-1 text-xs text-[var(--c-text-secondary)]">
      {unattended.map(([a, m]) => (
        <li key={`u-${a}`} className="flex gap-1.5 items-start">
          <span className="text-red-400 shrink-0">⚠</span>
          <span>
            {AREA_LABEL[a]} has expected patients but no attending for {m.unattendedDemandHours} h/week.{' '}
            <button onClick={() => onRequireCoverage(a)} className="text-indigo-300 hover:text-indigo-200 underline">
              Require an attending in {AREA_LABEL[a]} at all times and re-run
            </button>
          </span>
        </li>
      ))}
      {patterns.slice(0, 4).map(p => (
        <li key={`s-${p.startHour}`} className="flex gap-1.5"><span className="text-red-400 shrink-0">▼</span>{p.message}</li>
      ))}
      {excess.slice(0, 2).map(p => (
        <li key={`e-${p.startHour}`} className="flex gap-1.5 text-[var(--c-text-muted)]"><span className="text-sky-400 shrink-0">▲</span>{p.message}</li>
      ))}
      {!patterns.length && <li className="text-[var(--c-text-muted)]">No hour is short on 4+ days of the week in {SCOPE_LABEL[scope]}.</li>}
    </ul>
  )
}

function ShiftList({ plannedByDay, days }) {
  const [open, setOpen] = useState(false)
  const total = days.reduce((t, d) => t + plannedByDay[d].length, 0)
  return (
    <div>
      <button onClick={() => setOpen(v => !v)} className="text-xs text-[var(--c-text-muted)] uppercase tracking-wide hover:text-[var(--c-text-secondary)]">
        Recommended shifts ({total}) {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 text-xs">
          {days.map(d => {
            const byTeam = {}
            for (const s of plannedByDay[d]) (byTeam[s.team] ??= []).push(`${s.start_time}–${s.end_time}`)
            return (
              <div key={d} className="flex gap-2">
                <span className="w-8 shrink-0 text-[var(--c-text-muted)]">{SHORT_DAY[d]}</span>
                <span className="text-[var(--c-text-secondary)]">
                  {Object.entries(byTeam).map(([team, times]) => `${team} ${times.join(', ')}`).join(' · ') || '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Headline for the capped planning modes: what was asked, the hours
// found (and their proven lower bound), and what was achievable at all.
function RequirementTiles({ plan }) {
  const { result, settings, summary } = plan
  const pl = result.planning ?? {}
  const best = pl.bestAchievable
  const asked = {
    target: `≥ ${settings.targetCoveragePct}% modeled coverage`,
    maxUnmet: `≤ ${fmt(settings.maxUnmetPph)} unmet patient-h/wk`,
    minPractical: `within ${settings.practicalTolerancePct} coverage pts of best achievable`,
  }[settings.planningMode]
  const areaAsk = Object.entries(pl.requested?.areaTargetCoverage ?? {}).map(([a, v]) => `${AREA_LABEL[a]} ≥ ${fmt(100 * v, 1)}%`).join(', ')
  const achieved = 100 * summary.all.coverage
  return (
    <>
      <Tile label={<>Requested <Tag kind="CONFIGURED" /></>} value={asked} sub={areaAsk || (settings.planningMode === 'minPractical' ? `= ≤ ${fmt(pl.capsPph?.['*'])} unmet patient-h/wk` : undefined)} />
      <Tile label={<>Attending h required <Tag kind="CALCULATED" /></>} value={`${fmtH(result.hours.total)} h/wk`}
        sub={pl.hoursProven ? 'proven minimum for this menu and rules' : `best found; proven ≥ ${fmtH(pl.hoursLowerBound)} h/wk`} />
      <Tile label="Achieved modeled coverage" value={`${fmt(achieved)}%`}
        sub={settings.planningMode === 'target' ? `${achieved - settings.targetCoveragePct >= 0 ? '+' : ''}${fmt(achieved - settings.targetCoveragePct, 2)} pts vs target · ${fmt(summary.all.unmet)} unmet patient-h` : `${fmt(summary.all.unmet)} unmet patient-h/wk`} />
      {best?.coverage != null && (
        <Tile label="Best achievable (unlimited hours)" value={`${fmt(100 * best.coverage)}%`}
          sub={`${fmt(best.unmetPph)} unmet patient-h/wk${best.proven ? ' · proven' : ''}`} />
      )}
    </>
  )
}

function UnitsTile({ hours, units }) {
  const u = planningUnits(hours, units)
  if (u.fte == null && u.cost == null) return null
  return (
    <Tile label={<>Planning units <Tag kind="CONFIGURED" /></>}
      value={u.fte != null ? `≈ ${fmt(u.fte, 1)} FTE` : `${fmtH(u.annual)} h/yr`}
      sub={[u.fte != null && `at ${fmtH(u.clinicalHoursPerFte)} clinical h/FTE/yr`, u.cost != null && `illustrative $${Math.round(u.cost).toLocaleString()}/yr at $${u.hourlyRate}/h — not institutional cost`].filter(Boolean).join(' · ')} />
  )
}

export default function PlanResults({ plan, days, demand, pph, currentShiftsForDay, customTeams, onRequireCoverage }) {
  const [view, setView] = useState('proposed')
  const { result, settings, weekly, before, after, crossCheck, proposedByDay, newTeams, plannedByDay } = plan
  const hours = result.hours
  const pm = settings.planningMode ?? settings.mode
  const annual = pm === 'budget' && settings.period === 'annual'
  const gap = result.stats?.relativeGap ?? 0
  const resultText = `${fmtH(hours.total)} attending h/week (${fmtH(hours.total * WEEKS_PER_YEAR)} h/yr) — ${Object.entries(after.byArea).map(([a, m]) => `${AREA_LABEL[a]} ${fmtH(m.attendingHours)}`).join(', ')}`

  return (
    <div className="space-y-5">
      <AssumptionStrip settings={settings} pph={pph} resultText={resultText} />
      <div className="flex flex-wrap gap-2">
        {['target', 'maxUnmet', 'minPractical'].includes(pm) ? <RequirementTiles plan={plan} /> : pm === 'budget' ? (
          <>
            <Tile label="Available" value={`${fmtH(weekly)} h/wk`} sub={annual ? `${fmtH(settings.amount)} h/yr` : `${fmtH(weekly * WEEKS_PER_YEAR)} h/yr`} />
            <Tile label="Allocated" value={`${fmtH(hours.total)} h/wk`}
              sub={`${hours.locked ? `${fmtH(hours.locked)} locked + ${fmtH(hours.optimized)} planned · ` : ''}${fmtH(hours.total * WEEKS_PER_YEAR)} h/yr`} />
            <Tile label="Unallocated" value={`${fmtH(hours.unallocated)} h/wk`}
              sub={hours.unallocated >= 0.5 ? 'more hours than can reduce any deficit' : hours.unallocated > 0 ? 'below the half-hour shift granularity' : 'budget fully used'}
              tone={hours.unallocated >= 0.5 ? 'text-sky-300' : undefined} />
          </>
        ) : (
          <Tile label="Hours needed" value={`${fmtH(hours.total)} h/wk`} sub={`${fmtH(hours.total * WEEKS_PER_YEAR)} h/yr${hours.locked ? ` · incl. ${fmtH(hours.locked)} locked` : ''}`} />
        )}
        <UnitsTile hours={hours.total} units={settings.units} />
        <Tile label="Uncovered demand" value={<Delta before={before.componentUncoveredPphHours} after={after.componentUncoveredPphHours} />}
          sub="patients/hr·h per week, summed per area" />
        <Tile label="Solver"
          value={result.status === 'optimal' ? 'Optimal' : 'Best found'}
          sub={`${fmt(result.stats?.solveSeconds, 1)} s · ${result.status === 'optimal' ? 'proven' : `within ${fmt(gap * 100, 1)}%`} of best possible`} />
      </div>

      {crossCheck > 0.05 && (
        <div className="text-xs text-amber-300 border border-amber-700/60 rounded px-2 py-1.5">
          The solver's capacity differs from the app's by up to {fmt(crossCheck, 2)} patients/hr in some hour — treat these numbers with caution.
        </div>
      )}

      <div>
        <H>Coverage improvement</H>
        <CoverageTable before={before} after={after} scope={settings.scope} />
      </div>

      {plan.eruBaseline && (
        <div>
          <H>ERU scenario vs Current ERU coverage</H>
          <EruComparison plan={plan} />
        </div>
      )}

      {after.operational && before.operational && (
        <div>
          <H>Operational coverage</H>
          <OperationalTable before={before} after={after} />
        </div>
      )}

      <div>
        <H>Recommended allocation</H>
        <Allocation after={after} days={days} annual={annual} />
      </div>

      <BottleneckPanel bottlenecks={plan.bottlenecks} />

      <div>
        <H>Remaining problems</H>
        <RemainingProblems after={after} scope={settings.scope} onRequireCoverage={onRequireCoverage} />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <H>Current vs proposed</H>
          <div className="flex rounded overflow-hidden border border-[var(--c-border)] -mt-1.5" role="group" aria-label="Schedule shown">
            {[['current', 'Current'], ['proposed', 'Proposed']].map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} aria-pressed={view === k}
                className={`px-2 py-0.5 text-[10px] font-medium ${view === k ? 'bg-indigo-700 text-white' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)]'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="border border-[var(--c-border)] rounded overflow-hidden">
          <WeekHeatmap
            embedded title={view === 'current' ? 'Current' : 'Proposed'}
            days={days} activeDow={null}
            shiftsForDay={view === 'current' ? currentShiftsForDay : plan.proposedFor}
            demand={demand} pph={pph}
            customTeams={view === 'current' ? customTeams : [...customTeams, ...newTeams]}
            scope={settings.scope} target={settings.target} hoverHour={null}
            coverage={settings.useCoverage ? settings.coverage : null}
          />
        </div>
      </div>

      <ShiftList plannedByDay={plannedByDay} days={days} proposedByDay={proposedByDay} />
    </div>
  )
}
