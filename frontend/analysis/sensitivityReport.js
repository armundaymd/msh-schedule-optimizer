// Markdown report for a one-parameter sensitivity sweep of the attending
// resource allocator. Sections are kept strictly separate:
//   OBSERVED INPUTS  -> MODEL ASSUMPTIONS -> MODEL OUTPUTS
import { AREA_LABEL, SCOPE_LABEL } from '../src/shared/areas'
import { formatHour, formatRange, EXCESS_MIN_FRACTION, EXCESS_MIN_PPH } from '../src/shared/coverageInsights'
import { MATERIAL_CHANGE_SHARE } from '../src/shared/sensitivity'
import { DEFAULT_MAX_FLEX, DEFAULT_MAX_PER_TEAM, WEEKS_PER_YEAR } from '../src/shared/staffingPlan'
import { periodText } from '../validation/compare'

const f = (n, d = 1) => Number(n).toFixed(d)
const pct = m => (m.demand > 0 ? `${f((100 * m.served) / m.demand)}%` : '—')
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const short = d => d.slice(0, 3)

// Collapse identical area + hour ranges across days: "Main from 10:00–19:00 (Mon, Tue, Wed)".
function condense(runs) {
  const groups = new Map()
  for (const r of runs) {
    const key = `${r.area}|${r.hours.join(',')}`
    if (!groups.has(key)) groups.set(key, { area: r.area, hours: r.hours, days: [] })
    groups.get(key).days.push(r.day)
  }
  return [...groups.values()]
    .sort((a, b) => b.days.length * b.hours.length - a.days.length * a.hours.length)
    .map(g => `${AREA_LABEL[g.area]} ${formatRange(g.hours)} [${g.hours.length} h] (${g.days.length === 7 ? 'every day' : g.days.sort((x, y) => DAY_ORDER.indexOf(x) - DAY_ORDER.indexOf(y)).map(short).join(', ')})`)
}

function list(items, empty, max = 8) {
  if (!items.length) return [`- ${empty}`]
  const shown = items.slice(0, max).map(x => `- ${x}`)
  if (items.length > max) shown.push(`- … and ${items.length - max} more`)
  return shown
}

function shiftGroups(shifts) {
  const groups = new Map()
  for (const s of shifts) {
    const key = `${s.area}|${s.start}|${s.length}|${s.copies}`
    if (!groups.has(key)) groups.set(key, { ...s, days: [] })
    groups.get(key).days.push(s.day)
  }
  return [...groups.values()]
    .sort((a, b) => b.days.length - a.days.length || a.area.localeCompare(b.area) || a.start - b.start)
    .map(g => `${AREA_LABEL[g.area]} ${formatHour(g.start)} + ${g.length} h${g.copies > 1 ? ` ×${g.copies}` : ''} (${g.days.length === 7 ? 'every day' : g.days.map(short).join(', ')})`)
}

export function renderSensitivityReport(r) {
  const { param, variants, current, robust, cross, observed, assumptions, fixed } = r
  const areas = Object.keys(current.metricsByVariant[0].byArea)
  const L = []

  L.push(`# Sensitivity of the attending allocator to: ${param.label}`, '')
  L.push(`Generated ${r.when}. Scope: ${SCOPE_LABEL[fixed.scope]}. Tested values: ${variants.map(v => v.label + (v.isBaseline ? ' (configured default)' : '')).join(', ')}.`, '')
  L.push('> **Decision-support estimates, not staffing requirements.** Every coverage figure and recommended shift below is the')
  L.push('> output of a model built on the assumptions listed in section 2. None has been validated as a clinical staffing')
  L.push('> requirement. A recommendation that is stable across assumptions is *mathematically robust within this model*;')
  L.push('> that is not evidence that it is clinically correct. Review with the people who run the department.', '')

  // ── 1. Observed inputs ──────────────────────────────────────────────────
  L.push('## 1. Observed inputs', '')
  L.push(`Measured or recorded, not modelled. Source: \`${observed.sources.join('`, `')}\`.`, '')
  L.push(`**Historical demand** (${observed.target} arrivals per hour by day of week${observed.nDays ? `, ${observed.nDays} days of data` : ''}):`, '')
  L.push('| Area | Patient-hours / week | Busiest hour (day) | Quietest hour (day) |', '|---|---|---|---|')
  for (const a of areas) {
    const d = observed.demand[a]
    L.push(`| ${AREA_LABEL[a]} | ${f(d.weekly)} | ${f(d.peak.v, 2)}/hr at ${formatHour(d.peak.h)} (${short(d.peak.day)}) | ${f(d.low.v, 2)}/hr at ${formatHour(d.low.h)} (${short(d.low.day)}) |`)
  }
  L.push('', `**Current schedule:** ${observed.shiftCount} shifts per week — ${Object.entries(observed.byRole).map(([k, v]) => `${v} ${k}`).join(', ')}.`, '')
  L.push(`**Current attending hours per week:** ${areas.map(a => `${AREA_LABEL[a]} ${f(observed.attendingHours[a], 0)}`).join(' · ')} · total ${f(observed.attendingTotal, 0)} (${f(observed.attendingTotal * WEEKS_PER_YEAR, 0)} per year).`, '')

  // ── 2. Model assumptions ────────────────────────────────────────────────
  L.push('## 2. Model assumptions', '')
  L.push('Chosen or estimated inputs. Changing any of these changes the outputs.', '')
  L.push('**Throughput / capacity (patients per hour)** — the swept parameter is marked ◀:', '')
  L.push('| Parameter | Value |', '|---|---|')
  for (const [k, v] of Object.entries(assumptions.pph)) L.push(`| \`${k}\` | ${v}${param.keys?.includes(k) ? ' ◀ swept' : ''} |`)
  L.push('', '**Supervision rules** (per team, per hour):', '')
  L.push('- Team capacity = min(attendings × ceiling, attendings × solo throughput + supervised residents/PAs) + solo FastTrack PA capacity.')
  L.push('- With no attending on, residents and supervised PAs count for nothing; FastTrack PAs still see patients solo.')
  L.push('- Area capacity = sum of its teams; areas never lend capacity to each other (deficits are counted per area).', '')
  L.push('**Demand statistic:** ' + (r.fixed.target === 'mean' ? 'mean arrivals per hour.' : `${r.fixed.target} of arrivals per hour.`), '')
  L.push('**Optimization (allocator objective and limits):**', '')
  const s = assumptions.solver
  L.push(`- Minimise tiered unmet demand per area-hour: weight ${s.deficitTierWeights.join(' / ')} for the first ${s.deficitTierBoundsPph[0]}, next ${s.deficitTierBoundsPph[1] - s.deficitTierBoundsPph[0]}, and beyond ${s.deficitTierBoundsPph[1]} patients/hr short (severe shortfalls cost most);`)
  L.push(`  then excess capacity beyond max(${EXCESS_MIN_PPH}/hr, ${EXCESS_MIN_FRACTION * 100}% of demand) at weight ${s.excessWeight}; then hours used (weight ${s.hourWeight} per half-hour). Units: 1/${s.pphScale} patient/hr.`)
  L.push(`- At most ${DEFAULT_MAX_PER_TEAM} attending per existing team at a time; up to ${DEFAULT_MAX_FLEX} on new teams per area (no residents/PAs).`)
  L.push(`- Fixed for every run: budget ${f(fixed.budget, 0)} attending h/week (today's), shift menu ${fixed.menu}, no minimum-coverage rules, no locked shifts; residents/PAs kept as scheduled.`)
  L.push(`- Solver: OR-Tools CP-SAT, deterministic search, "${fixed.effort}" effort (${s.effortDeterministicSeconds[fixed.effort]} deterministic seconds), stops at ${s.optimalityGap * 100}% of proven optimum.`, '')

  // ── 3. Model outputs ────────────────────────────────────────────────────
  L.push('## 3. Model outputs', '')
  L.push(`### 3.1 Recommended allocation under each assumption`, '')
  L.push(`Each plan is scored under the assumption it was optimised for. "Today" = the current schedule scored under the same assumption.`, '')
  const cols = variants.map(v => `${v.label}${v.isBaseline ? ' ★' : ''}`)
  L.push(`| ${param.short} | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`)
  const row = (label, fn) => L.push(`| ${label} | ${variants.map(fn).join(' | ')} |`)
  row('Total attending h/wk', v => f(v.metrics.all.attendingHours, 0))
  for (const a of areas) row(`${AREA_LABEL[a]} attending h/wk`, v => `${f(v.metrics.byArea[a].attendingHours, 0)}`)
  row('Overall coverage (today → plan)', (v, i) => `${pct(current.metricsByVariant[i].all)} → **${pct(v.metrics.all)}**`)
  for (const a of areas) row(`${AREA_LABEL[a]} coverage (today → plan)`, (v, i) => `${pct(current.metricsByVariant[i].byArea[a])} → ${pct(v.metrics.byArea[a])}`)
  row('Unmet patient-h/wk, total (today → plan)', (v, i) => `${f(current.metricsByVariant[i].all.deficit)} → **${f(v.metrics.all.deficit)}**`)
  for (const a of areas) row(`Unmet ${AREA_LABEL[a]}`, v => f(v.metrics.byArea[a].deficit))
  row('Excess beyond tolerance (patient-h)', v => f(v.metrics.all.excess))
  row('Surplus capacity (patient-h)', v => f(v.metrics.all.surplus))
  row(`Hours with no attending (${areas.map(a => AREA_LABEL[a]).join(' / ')})`, v => areas.map(a => v.unattended[a] ?? 0).join(' / '))
  row('Solver status · gap · time', v => `${v.solver.status} · ${f(100 * v.solver.gap, 1)}% · ${f(v.solver.seconds, 1)} s`)
  L.push('', '★ configured default.', '')

  L.push('### 3.2 Worst deficit periods remaining in each plan', '')
  for (const v of variants) {
    L.push(`**${param.short} = ${v.label}${v.isBaseline ? ' ★' : ''}**`, '')
    L.push(...list(v.metrics.worst.map(periodText), 'none'), '')
  }

  L.push('### 3.3 Does the recommended shift structure change?', '')
  L.push(`Compared with the ★ plan. "Moved" = attending-hours placed at a different area/day/hour; a change is **material** when more than ${MATERIAL_CHANGE_SHARE * 100}% of attending-hours move.`, '')
  L.push(`| ${param.short} | Shifts in common with ★ | Shift overlap (Jaccard) | Attending-hours moved | Material? |`, '|---|---|---|---|---|')
  for (const v of variants) {
    const c = v.vsBaseline
    L.push(`| ${v.label}${v.isBaseline ? ' ★' : ''} | ${c.sharedShifts} of ${v.shiftCount} | ${f(c.shiftJaccard, 2)} | ${f(c.movedHours, 0)} h (${f(100 * c.movedShare)}%) | ${v.isBaseline ? '—' : c.material ? '**yes**' : 'no'} |`)
  }
  L.push('')

  L.push('### 3.4 Robustness across the tested assumptions', '')
  L.push('Stable = true under **every** tested value. Mathematically robust within this model only.', '')
  L.push('**Every plan adds attending coverage compared with today**', '')
  L.push(...list(condense(robust.alwaysAdds), 'no period'), '')
  L.push('**Every plan removes attending coverage compared with today**', '')
  L.push(...list(condense(robust.alwaysRemoves), 'no period'), '')
  L.push('**Today\'s schedule is short under every tested assumption**', '')
  L.push(...list(condense(robust.currentShortEverywhere), 'no period'), '')
  L.push('**Today\'s schedule has excess capacity under every tested assumption**', '')
  L.push(...list(condense(robust.currentExcessEverywhere), 'no period'), '')
  L.push('**Still short in every plan** (the budget, shift menu and team limits cannot close these under any tested value)', '')
  L.push(...list(condense(robust.planShortEverywhere), 'no period'), '')
  L.push(`**Shifts that appear in every plan** (${robust.stableShifts.length} area/day/start/length combinations)`, '')
  L.push(...list(shiftGroups(robust.stableShifts), 'none', 12), '')
  if (robust.commonShifts.length) {
    L.push('**Shifts in most (≥80%) but not all plans**', '')
    L.push(...list(shiftGroups(robust.commonShifts), 'none', 8), '')
  }
  L.push('**Allocation decisions that depend on the assumption**', '')
  for (const a of areas) {
    const x = robust.areaHourRange[a]
    const swing = x.max - x.min
    const direction = x.min > x.current ? '; **every plan gives more than today**' : x.max < x.current ? '; **every plan gives less than today**' : ''
    L.push(`- ${AREA_LABEL[a]}: ${f(x.min, 0)}–${f(x.max, 0)} attending h/wk across plans (today ${f(x.current, 0)})${swing >= 8 ? ` — **swings by ${f(swing, 0)} h**, at least one shift, depending on the assumption` : ' — stable to within one shift'}${direction}`)
  }
  L.push('')

  L.push('### 3.5 Cross-evaluation: each plan if a different assumption were true', '')
  L.push('Unmet patient-hours per week (coverage). Rows = schedule, columns = the assumption used to score it. The diagonal is what each plan was optimised for; off-diagonal cells show the cost of being wrong about the assumption.', '')
  L.push(`| Schedule \\ scored with | ${variants.map(v => v.label).join(' | ')} |`, `|---|${variants.map(() => '---').join('|')}|`)
  cross.forEach((cells, i) => {
    const label = i === 0 ? 'Today' : `Plan @ ${variants[i - 1].label}`
    L.push(`| ${label} | ${cells.map((c, j) => { const t = `${f(c.unmet)} (${f(c.coveragePct)}%)`; return i - 1 === j ? `**${t}**` : t }).join(' | ')} |`)
  })
  L.push('')
  // Worst-case regret: how much more unmet demand a plan leaves than the
  // best tested plan, under whichever tested assumption is worst for it.
  const planRows = cross.slice(1)
  const bestPerCol = variants.map((_, j) => Math.min(...planRows.map(rw => rw[j].unmet)))
  const regrets = planRows.map(rw => Math.max(...rw.map((c, j) => c.unmet - bestPerCol[j])))
  const minRegret = Math.min(...regrets)
  const beatsToday = planRows.every(rw => rw.every((c, j) => c.unmet < cross[0][j].unmet))
  const diagonalBest = planRows.every((rw, i) => rw[i].unmet <= bestPerCol[i] + 1e-9)
  L.push('**Summary of the cross-evaluation**', '')
  L.push(`- ${beatsToday ? 'Every plan leaves less unmet demand than today\'s schedule under every tested assumption.' : 'Not every plan beats today\'s schedule under every tested assumption — see the table.'}`)
  L.push(`- Worst-case regret (extra unmet patient-h/wk vs the best tested plan, under the least favourable tested value): ${variants.map((v, i) => `${v.label}: ${f(regrets[i])}`).join(' · ')}.`
    + ` Smallest: **plan @ ${variants[regrets.indexOf(minRegret)].label}** (${f(minRegret)}).`)
  if (!diagonalBest) {
    L.push('- Some plans are beaten on their own assumption by a plan built for a different one. That is expected here: the solver stops within the stated gap of the best possible, and it minimises tiered shortfalls plus excess rather than plain unmet patient-hours. Differences of a few patient-hours between plans should not be read as meaningful.')
  }
  L.push('')

  L.push('## 4. Reading this report', '')
  L.push('- Coverage here means modelled capacity (from the throughput assumptions) against historical average demand. It is not observed patient flow or wait times.')
  L.push('- Plans were optimised with a fixed budget equal to today\'s attending hours, no minimum-coverage rules and no locks. An area left without an attending (see "Hours with no attending") may be operationally unacceptable even where the model shows little unmet demand.')
  L.push('- Solver plans are within the stated gap of the best possible *for the model*; small differences between plans can come from the search rather than the assumption.')
  L.push('- To test other assumptions: `SENS_PARAM=<fasttrackCeiling|eruCeiling|residentProductivity|paProductivity|demandTarget> npm run analyze:sensitivity` (optionally `SENS_VALUES=a,b,c`).', '')
  return L.join('\n')
}
