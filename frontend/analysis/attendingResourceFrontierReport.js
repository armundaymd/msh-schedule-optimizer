// Markdown report for analysis/attendingResourceFrontier.analysis.js.
// Sections keep OBSERVED / CONFIGURED / ASSUMED / CALCULATED apart, and
// every number comes from a solve that actually ran — nothing is filled in.
import { AREA_LABEL } from '../src/shared/areas'
import { describeRule, describeWindow } from '../src/shared/operationalCoverage'
import { diminishingReturns, marginalRows, planningUnits } from '../src/shared/attendingPlanner'
import { BOTTLENECK_LABEL, BOTTLENECK_ORDER } from '../src/shared/bottlenecks'
import { periodText } from '../validation/compare'

const AREAS = ['main', 'fasttrack', 'eru']
const f = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const pct = (x, d = 1) => (x == null ? '—' : `${f(100 * x, d)}%`)
const sgn = (n, d = 1) => (n == null ? '—' : Math.abs(n) < 0.5 * 10 ** -d ? '±0' : `${n > 0 ? '+' : '−'}${f(Math.abs(n), d)}`)
const solverText = p => (!p?.ok ? '—' : p.status === 'optimal' ? 'proven optimal' : `best found · gap ${f(100 * (p.gap ?? 0), 1)}%`)
const hoursBy = (p, a) => p?.summary?.byArea?.[a]?.attendingHours
const BANDS = [['00–06', 0, 6], ['06–10', 6, 10], ['10–14', 10, 14], ['14–18', 14, 18], ['18–22', 18, 22], ['22–24', 22, 24]]
const POLICY_LABEL = { current: 'Current ERU coverage', coreDaytime: 'Core daytime (illustrative)', allDay: '24/7 dedicated ERU' }

function hoursProof(p) {
  const pl = p.planning
  if (!pl?.hoursRequired) return ''
  return pl.hoursProven ? 'proven minimum' : `best found; proven ≥ ${f(pl.hoursLowerBound, 0)}`
}

function bottleneckTable(L, b) {
  if (!b || b.total < 0.05) { L.push('No modeled unmet demand remains.', ''); return }
  L.push('| Limiting factor | Unmet patient-h/week | Share of unmet | Main | FastTrack | ERU |', '|---|---|---|---|---|---|')
  for (const l of BOTTLENECK_ORDER.filter(x => b.byLabel[x] > 0.005)) {
    L.push(`| ${BOTTLENECK_LABEL[l]} | ${f(b.byLabel[l])} | ${f((100 * b.byLabel[l]) / b.total, 0)}% | ${AREAS.map(a => f(b.byArea[a]?.byLabel[l] ?? 0)).join(' | ')} |`)
  }
  L.push(`| **Total unmet** | **${f(b.total)}** | | ${AREAS.map(a => f(b.byArea[a]?.unmet ?? 0)).join(' | ')} |`, '')
  L.push('Exclusive split (each unmet patient-hour counted once, by its full combination of limits):', '')
  for (const [k, v] of Object.entries(b.byCombination).sort((x, y) => y[1] - x[1])) {
    L.push(`- ${k.split('+').map(x => BOTTLENECK_LABEL[x]).join(' + ')}: ${f(v)} patient-h (${f((100 * v) / b.total, 0)}%)`)
  }
  L.push('')
}

function onDutyTable(L, plans) {
  L.push(`| Plan | ${AREAS.flatMap(a => BANDS.map(([n]) => `${AREA_LABEL[a]} ${n}`)).join(' | ')} |`, `|---|${AREAS.flatMap(() => BANDS.map(() => '---')).join('|')}|`)
  for (const [label, p] of plans) {
    if (!p?.onDutyByHour) continue
    const cells = AREAS.flatMap(a => BANDS.map(([, lo, hi]) => {
      const row = p.onDutyByHour[a] ?? Array(24).fill(0)
      let m = 0
      for (let h = lo; h < hi; h++) m = Math.max(m, row[h])
      return f(m, 1)
    }))
    L.push(`| ${label} | ${cells.join(' | ')} |`)
  }
  L.push('')
}

// Observed search uncertainty: the largest unmet difference between
// independent searches of the SAME budget and rules — standard vs thorough,
// warm vs cold start, the baseline run, and the second warm-start chain
// used for the comparisons. Used to flag near-ties.
function searchComparisons(r) {
  const out = []
  const byBudget = list => Object.fromEntries(list.filter(x => x.feasible).map(x => [x.budget, x.unmet]))
  const primary = byBudget(r.frontier.primary)
  const add = (label, b, u) => { if (primary[b] != null && u != null) out.push({ label, budget: Number(b), diff: Math.abs(u - primary[b]) }) }
  for (const [b, u] of Object.entries(byBudget(r.frontier.standard))) add('standard vs thorough', b, u)
  for (const [b, u] of Object.entries(byBudget(r.expanded.currentFrontier))) add('second warm-start chain', b, u)
  for (const [b, c] of Object.entries(r.frontier.cold ?? {})) add('cold vs warm start', b, c.summary?.all?.unmet)
  add('baseline run', r.config.currentBudget, r.baseline.thorough.summary?.all?.unmet)
  return out
}
function searchNoise(r) {
  return Math.max(0, ...searchComparisons(r).map(x => x.diff))
}

export function renderFrontierReport(r) {
  const { config, observed, baseline, frontier, targets, practical } = r
  const B = config.currentBudget
  const base = baseline.thorough
  // Grid budgets within 5 h of an included one (e.g. 625 next to today's 624)
  // are solved but not shown: a 1-hour "step" is noise at shift granularity.
  const near = x => x.budget !== B && Math.abs(x.budget - B) < 5
  const rows = frontier.primary.filter(x => !near(x))
  frontier.standard = frontier.standard.filter(x => !near(x))
  const noise = searchNoise(r)
  const marg = marginalRows(rows, { noise })
  const byTo = Object.fromEntries(marg.map(m => [m.to, m]))
  const dr = diminishingReturns(rows, { noise })
  const fteH = config.units.primaryFteHours
  const rate = config.units.illustrativeRate
  const mp = practical[0]
  const cur = observed.currentScored
  const L = []

  L.push('# Attending resource frontier: how much attending coverage does this ED need?', '')
  L.push(`Generated ${r.when} (${f(r.elapsedSeconds / 60, 0)} min of solving). Whole ED, ${r.target} demand. Primary operational scenario: **Current ERU coverage**.`)
  L.push(`Primary figures: ${config.effort.primary} search; robustness: ${config.effort.robustness}. Reproduce: \`npm run analyze:frontier\` (configuration at the top of \`analysis/attendingResourceFrontier.analysis.js\`).`, '')
  L.push('> **Decision-support estimates under the configured demand, productivity and operational assumptions.** "Modeled coverage" is not')
  L.push('> observed throughput; "unmet patient-hours" are not wait times; a calculated staffing level is not a clinical staffing requirement.')
  L.push('> The model does not quantify acuity, resuscitation readiness, boarding, documentation, interruptions, procedures, consultant')
  L.push('> coordination, door-to-provider time, LOS, LWBS, or surges beyond the configured demand. Resident/PA productivity is assumed.', '')

  // ── Key tables ─────────────────────────────────────────────────────────────
  L.push('## Summary tables (finance / operations)', '')
  L.push(`**Table A — resource frontier** (Current ERU coverage, current shift structure; CALCULATED). FTE at **${f(fteH, 0)} clinical h/FTE/yr — a value configured for this report, not an institutional definition** (section 13).`, '')
  L.push('| Attending h/wk | Annual h | Approx FTE | Overall modeled coverage | Unmet patient-h/wk | Main unmet | FT unmet | ERU unmet | Marginal benefit (unmet ↓ per added h) |', '|---|---|---|---|---|---|---|---|---|')
  for (const x of rows) {
    if (!x.feasible) { L.push(`| ${f(x.budget, 0)} | — | — | *no plan: ${x.message ?? x.status}* | | | | | |`); continue }
    const u = planningUnits(x.hours, { clinicalHoursPerFte: fteH })
    const m = byTo[x.budget]
    L.push(`| ${f(x.budget, 0)}${x.budget === B ? ' (today)' : ''}${x.hours < x.budget - 0.5 ? ` (uses ${f(x.hours, 0)})` : ''}${x.carriedForward ? ' ↺' : ''} | ${f(u.annual, 0)} | ${f(u.fte, 1)} | ${pct(x.coverage)} | ${f(x.unmet)} | ${f(x.unmetByArea.main)} | ${f(x.unmetByArea.fasttrack)} | ${f(x.unmetByArea.eru)} | ${m ? `${f(m.perHour, 2)}${m.withinNoise ? ' ~' : ''}` : '—'} |`)
  }
  L.push('', `↺ = the search at this budget did not beat the previous (smaller) budget's plan, so that plan is shown (it is feasible here). ~ = step smaller than the observed search uncertainty (±${f(noise)} patient-h).`, '')

  L.push('**Table B — coverage targets** (Current ERU coverage, current shift structure; CALCULATED).', '')
  L.push('| Target modeled coverage | Minimum attending h/wk | Main h | FT h | ERU h | Achieved coverage | Feasible? |', '|---|---|---|---|---|---|---|')
  for (const t of targets) {
    if (!t.ok) {
      const best = t.planning?.bestAchievable
      L.push(`| ${t.targetPct}% | — | — | — | — | best achievable ${pct(best?.coverage)} | **No — TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS** |`)
      continue
    }
    L.push(`| ${t.targetPct}% | ${f(t.hours.total, 0)} (${hoursProof(t)}) | ${f(hoursBy(t, 'main'), 0)} | ${f(hoursBy(t, 'fasttrack'), 0)} | ${f(hoursBy(t, 'eru'), 0)} | ${pct(t.summary.all.coverage, 2)} | Yes |`)
  }
  L.push('')
  const under = targets.filter(t => t.ok && 100 * t.summary.all.coverage < t.targetPct)
  if (under.length) {
    L.push(`Achieved coverage is app-scored. ${under.map(t => `${t.targetPct}% scores ${pct(t.summary.all.coverage, 3)}`).join('; ')}: the solver meets the target on capacities rounded to 0.01 patients/hr (its coverage: ${under.map(t => pct(t.solverView?.coverage, 3)).join(', ')}); the difference is rounding, well inside the model's precision.`, '')
  }

  // ── 1 ──────────────────────────────────────────────────────────────────────
  L.push('## 1. Question', '')
  L.push('*How much ATTENDING coverage does this ED need, and where?* Answered from several directions with one OR-Tools CP-SAT model:')
  L.push('fixed budget (where do X hours go?), coverage / unmet targets (fewest hours reaching X), a minimum practical requirement (no budget),')
  L.push('and a resource frontier (best allocation at each of a series of budgets). **Attending hours are the only decision variable.**')
  L.push('Residents and PAs are fixed inputs: never added, removed, moved or re-levelled. They matter because they set how much capacity each')
  L.push('attending supports. Nothing here chooses the ED\'s staffing budget or says which ERU policy is clinically right.', '')

  // ── 2 ──────────────────────────────────────────────────────────────────────
  L.push('## 2. Observed inputs', '')
  L.push(`**OBSERVED** — \`${observed.sources.join('`, `')}\`, ${observed.nDays ?? '?'} days of arrivals.`, '')
  L.push('| Area | Historical patient-hours / week | Current attending h / week |', '|---|---|---|')
  for (const a of AREAS) L.push(`| ${AREA_LABEL[a]} | ${f(observed.demand[a])} | ${f(observed.attendingHours[a], 0)} |`)
  L.push(`| **Total** | **${f(AREAS.reduce((t, a) => t + observed.demand[a], 0))}** | **${f(AREAS.reduce((t, a) => t + observed.attendingHours[a], 0), 0)}** |`, '')
  L.push(`- Current schedule: ${Object.entries(observed.byRole).map(([k, v]) => `${v} ${k}`).join(', ')} shifts per week. Resident/PA shifts are identical in every plan (checked on every solve).`)
  L.push('- Demand stays in its own area (FastTrack = historical FastTrack routing, ERU = historical ERU arrivals). No ESI is used.', '')

  // ── 3 ──────────────────────────────────────────────────────────────────────
  L.push('## 3. Operational rules', '')
  L.push('**CONFIGURED OPERATIONAL POLICY** (hard constraints in every solve):', '')
  L.push(`- ${describeRule('main', { ...r.coverageRules.main.default, fromHour: 0, toHour: 0 })}.`)
  for (const x of r.coverageRules.fasttrack.rules ?? []) L.push(`- ${describeRule('fasttrack', x)} (its recorded demand still counts).`)
  const p = r.eruPresets.current
  L.push(`- ERU (primary scenario, Current ERU coverage): dedicated attending Mon–Fri ${describeWindow(p.weekday)}, Sat–Sun ${describeWindow(p.weekend)}; outside it Main cross-covers.`)
  L.push('- ERU: at most **one** dedicated attending at a time (structural, every scenario).')
  L.push('- Staff operating-area routing:')
  for (const x of r.staffRouting ?? []) L.push(`  - ${x.label} (${x.fromHour}:00–${x.toHour}:00)${x.confirmed ? '' : ' — inferred from the role_detail suffix; needs confirmation'}`)
  L.push(`- Team limits: one attending at a time per existing team; up to 3 additional simultaneous attendings per area on new teams (ERU capped at one overall). This lets the model add **more simultaneous attending coverage** at peaks, not just re-time today's shifts.`)
  L.push(`- Shift structure: **current** = starts ${r.structures.current.starts.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')} × ${r.structures.current.lengths.join('/')} h (${r.structures.current.patterns} patterns); **expanded** = every hour × ${r.structures.expanded.lengths.join('/')} h (${r.structures.expanded.patterns} patterns).`, '')

  // ── 4 ──────────────────────────────────────────────────────────────────────
  L.push('## 4. Model assumptions', '')
  const pph = r.pph
  L.push('**MODEL ASSUMPTIONS** (not measured):', '')
  L.push(`- Supervision ceiling / solo throughput (patients/hr per attending): Main ${pph.main}/${pph.mainOwn}, FastTrack ${pph.fasttrack}/${pph.fasttrackOwn}, ERU ${pph.eru}/${pph.eruOwn}.`)
  L.push(`- Resident/PA productivity: PGY-1…4 ${pph.pgy1}/${pph.pgy2}/${pph.pgy3}/${pph.pgy4}, off-service ${pph.offService}, PA ${pph.pa}; FastTrack PA solo ${pph.fasttrackPa}.`)
  L.push('- Team capacity = min(attendings × ceiling, attendings × solo + supervised residents/PAs) + FastTrack solo PAs. Areas never lend capacity; deficits are per area-hour, never pooled.')
  L.push(`- ERU cross-cover throughput credit: **${r.crossCoverCredit}**.`)
  L.push(`- Modeled coverage = Σ min(demand, capacity) ÷ Σ demand over area-hours. Mean demand is not a peak-service guarantee.`)
  L.push(`- Fixed-budget objective: tiered unmet demand per area-hour (weights ${r.solverInfo.deficitTierWeights.join('/')}), then excess beyond tolerance (${r.solverInfo.excessWeight}), then hours (${r.solverInfo.hourWeight}).`)
  L.push('- Target modes: (1) least achievable unmet with unlimited hours (its proven bound shows which targets are impossible); (2) fewest hours meeting the target; (3) placement of exactly those hours by the fixed-budget objective under the same target.')
  L.push(`- Minimum practical: stage (2) caps unmet at the least achievable + a tolerance of **${f(config.practicalTolerances[0], 2)} coverage points** (sensitivity: ${config.practicalTolerances.slice(1).join(', ')}).`, '')

  // ── 5 ──────────────────────────────────────────────────────────────────────
  L.push(`## 5. Current ${B}-hour baseline`, '')
  L.push(`**CALCULATED** — best allocation of ${B} attending h/week under Current ERU coverage (${solverText(base)}), vs today's schedule as recorded, scored identically.`, '')
  L.push('| | Today as scheduled | Re-allocated 624 h |', '|---|---|---|')
  L.push(`| Attending h/week | ${f(cur.all.attendingHours, 0)} | ${f(base.hours.total, 0)} |`)
  for (const a of AREAS) L.push(`| ${AREA_LABEL[a]} attending h | ${f(cur.byArea[a].attendingHours, 0)} | ${f(hoursBy(base, a), 0)} |`)
  L.push(`| **Modeled coverage** | **${pct(cur.all.coverage)}** | **${pct(base.summary.all.coverage)}** |`)
  for (const a of AREAS) L.push(`| ${AREA_LABEL[a]} coverage | ${pct(cur.byArea[a].coverage)} | ${pct(base.summary.byArea[a].coverage)} |`)
  L.push(`| **Unmet patient-h/week** | **${f(cur.all.unmet)}** | **${f(base.summary.all.unmet)}** |`)
  for (const a of AREAS) L.push(`| ${AREA_LABEL[a]} unmet | ${f(cur.byArea[a].unmet)} | ${f(base.summary.byArea[a].unmet)} |`)
  L.push(`| Excess beyond tolerance | ${f(cur.all.excess)} | ${f(base.summary.all.excess)} |`)
  L.push(`| Most Main attendings on at once | ${cur.byArea.main.maxOnDuty} | ${base.summary.byArea.main.maxOnDuty} |`, '')
  const f624 = rows.find(x => x.budget === B && x.feasible)
  if (f624 && Math.abs(f624.unmet - base.summary.all.unmet) > 0.05) {
    L.push(`The frontier's ${B} h point (warm-started from ${f(rows[rows.indexOf(f624) - 1]?.budget, 0)} h) found ${f(f624.unmet)} unmet patient-h vs ${f(base.summary.all.unmet)} here — two searches of the same problem; the difference is search uncertainty (section 14), not a model effect.`, '')
  }
  L.push('Worst remaining deficits in the re-allocated plan:', '')
  for (const w of base.summary.worst.slice(0, 5)) L.push(`- ${periodText(w)}`)
  L.push('')

  // ── 6 ──────────────────────────────────────────────────────────────────────
  L.push('## 6. Resource frontier', '')
  L.push('**CALCULATED** — each budget solved independently (warm-started from the previous point), scored with the app model. Budgets are maxima; "used" < budget means extra hours reduced no modeled deficit.', '')
  L.push('| Budget | Used | Main h | FT h | ERU h | Coverage | Main | FT | ERU | Unmet | Main | FT | ERU | Excess | Max Main on | Max FT on | Solver |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const x of rows) {
    if (!x.feasible) { L.push(`| ${f(x.budget, 0)} | *no plan (${x.status})* |||||||||||||||| |`); continue }
    L.push(`| ${f(x.budget, 0)}${x.carriedForward ? ' ↺' : ''} | ${f(x.hours, 0)} | ${AREAS.map(a => f(x.hoursByArea[a], 0)).join(' | ')} | ${pct(x.coverage)} | ${AREAS.map(a => pct(x.coverageByArea[a])).join(' | ')} | ${f(x.unmet)} | ${AREAS.map(a => f(x.unmetByArea[a])).join(' | ')} | ${f(x.excess)} | ${x.maxOnDuty.main} | ${x.maxOnDuty.fasttrack} | ${x.status === 'optimal' ? 'optimal' : `gap ${f(100 * x.gap)}%`} |`)
  }
  L.push('')
  L.push('Worst deficit periods at selected budgets:', '')
  for (const b of [rows[0]?.budget, B, rows.at(-1)?.budget]) {
    const x = rows.find(y => y.budget === b && y.feasible)
    if (!x) continue
    L.push(`- **${f(b, 0)} h:** ${x.worst.slice(0, 3).map(periodText).join('; ') || 'none'}`)
  }
  L.push('')

  // ── 7 ──────────────────────────────────────────────────────────────────────
  L.push('## 7. Marginal value of additional attending-hours', '')
  L.push('**CALCULATED** — change between consecutive budgets. Rate = reduction in modeled unmet patient-hours per additional budgeted attending-hour. This is not clinical value or patient outcome.', '')
  L.push('| From → to | Added h | Unmet ↓ | Coverage (pts) | Main ↓ | FT ↓ | ERU ↓ | Per added h |', '|---|---|---|---|---|---|---|---|')
  for (const m of marg) L.push(`| ${f(m.from, 0)} → ${f(m.to, 0)} | ${f(m.addedHours, 0)} | ${f(m.unmetReduction)}${m.withinNoise ? ' ~' : ''} | ${sgn(m.coveragePoints, 2)} | ${f(m.byArea.main)} | ${f(m.byArea.fasttrack)} | ${f(m.byArea.eru)} | ${f(m.perHour, 2)} |`)
  L.push('', '**Diminishing returns — facts:**', '')
  for (const x of dr.facts) L.push(`- ${x.text}.`)
  L.push('')
  if (dr.flattening) {
    L.push(`The largest single drop in the per-hour rate is at ${f(dr.flattening.at, 0)} h: ${f(dr.flattening.before.perHour, 2)} → ${f(dr.flattening.after.perHour, 2)} patient-h per added attending-hour.`)
  }
  if (dr.knee) {
    L.push(`Descriptive knee of this curve (the point farthest from the straight line between its end points, both axes normalised): **${f(dr.knee.budget, 0)} h/week**. This is a geometric description of the curve over the budgets tested — it moves if the range changes — and **not a recommended staffing level**.`)
  }
  L.push('')

  // ── 8 ──────────────────────────────────────────────────────────────────────
  L.push('## 8. Coverage-target requirements', '')
  L.push('**CALCULATED** — fewest attending-hours reaching each target (Current ERU coverage, current shift structure).', '')
  L.push('| Target | Status | Attending h/wk | Main | FT | ERU | Achieved (app) | Above target | Unmet | Main | FT | ERU | Proof |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const t of targets) {
    if (!t.ok) {
      const best = t.planning?.bestAchievable
      L.push(`| ${t.targetPct}% | **infeasible** | — | | | | best achievable ${pct(best?.coverage, 2)} | | ${f(best?.unmetPph)} | | | | ${best?.proven ? 'bound proven' : 'not proven'} |`)
      continue
    }
    const s = t.summary
    L.push(`| ${t.targetPct}% | feasible | **${f(t.hours.total, 0)}** | ${AREAS.map(a => f(hoursBy(t, a), 0)).join(' | ')} | ${pct(s.all.coverage, 2)} | ${sgn(100 * s.all.coverage - t.targetPct, 2)} pts | ${f(s.all.unmet)} | ${AREAS.map(a => f(s.byArea[a].unmet)).join(' | ')} | ${hoursProof(t)} |`)
  }
  L.push('')
  for (const t of targets.filter(x => !x.ok)) {
    L.push(`**${t.targetPct}%: TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS.** ${t.message.replace(/^TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS:\s*/, '')}`, '')
    if (t.bestAchievable?.bottlenecks) {
      L.push('What limits the residual deficit in the best-achievable plan (unlimited attending hours):', '')
      bottleneckTable(L, t.bestAchievable.bottlenecks)
      break
    }
  }
  L.push('**Maximum modeled unmet demand.**', '')
  L.push('| Max unmet patient-h/wk | Status | Attending h/wk | Main | FT | ERU | Achieved unmet | Coverage | Proof |', '|---|---|---|---|---|---|---|---|---|')
  for (const t of r.maxUnmet) {
    if (!t.ok) { L.push(`| ${f(t.maxUnmet, 0)} | **infeasible** | — | | | | | | ${t.message.slice(0, 120)} |`); continue }
    L.push(`| ${f(t.maxUnmet, 0)} | feasible | **${f(t.hours.total, 0)}** | ${AREAS.map(a => f(hoursBy(t, a), 0)).join(' | ')} | ${f(t.summary.all.unmet)} | ${pct(t.summary.all.coverage)} | ${hoursProof(t)} |`)
  }
  L.push('')
  L.push('**Area-specific targets** (optional; equal targets across areas are not assumed clinically appropriate; ERU throughput coverage does not measure acuity coverage).', '')
  for (const t of r.areaTargets) {
    if (!t.ok) { L.push(`- ${t.label}: **infeasible** — ${t.message}`); continue }
    L.push(`- ${t.label}: **${f(t.hours.total, 0)} h/week** (${hoursProof(t)}) — Main ${f(hoursBy(t, 'main'), 0)}, FT ${f(hoursBy(t, 'fasttrack'), 0)}, ERU ${f(hoursBy(t, 'eru'), 0)}; achieved overall ${pct(t.summary.all.coverage, 2)}, Main ${pct(t.summary.byArea.main.coverage, 2)}, FastTrack ${pct(t.summary.byArea.fasttrack.coverage, 2)}, ERU ${pct(t.summary.byArea.eru.coverage, 2)}.`)
  }
  L.push('')

  // ── 9 ──────────────────────────────────────────────────────────────────────
  L.push('## 9. Minimum-practical modeled requirement', '')
  if (mp.ok) {
    const best = mp.planning.bestAchievable
    L.push(`**Minimum practical modeled requirement under configured assumptions: ${f(mp.hours.total, 0)} attending h/week** (${hoursProof(mp)}) — Main ${f(hoursBy(mp, 'main'), 0)}, FastTrack ${f(hoursBy(mp, 'fasttrack'), 0)}, ERU ${f(hoursBy(mp, 'eru'), 0)}.`, '')
    L.push(`- Least achievable modeled unmet with **unlimited** attending hours: ${f(best.unmetPph)} patient-h/week (${pct(best.coverage, 2)} coverage; ${best.proven ? 'proven' : 'best found'}). **100% is not achievable** under these rules and this shift structure.`)
    L.push(`- Tolerance: ${f(mp.planning.tolerancePct, 2)} coverage points (${f(mp.planning.tolerancePph)} patient-h) → cap ${f(mp.planning.capsPph['*'])} unmet patient-h/week.`)
    L.push(`- Achieved (app scoring): ${pct(mp.summary.all.coverage, 2)} coverage, ${f(mp.summary.all.unmet)} unmet patient-h/week (Main ${f(mp.summary.byArea.main.unmet)}, FT ${f(mp.summary.byArea.fasttrack.unmet)}, ERU ${f(mp.summary.byArea.eru.unmet)}); excess ${f(mp.summary.all.excess)}.`)
    L.push(`- vs today (${f(B, 0)} h): ${sgn(mp.hours.total - B, 0)} h/week; vs the ${f(B, 0)} h re-allocation: coverage ${sgn(100 * (mp.summary.all.coverage - base.summary.all.coverage), 2)} pts, unmet ${sgn(mp.summary.all.unmet - base.summary.all.unmet)} patient-h.`, '')
    L.push('Tolerance sensitivity:', '')
    L.push('| Tolerance (coverage pts) | Attending h/wk | Main | FT | ERU | Coverage | Unmet | Proof |', '|---|---|---|---|---|---|---|---|')
    for (const t of practical) {
      if (!t.ok) { L.push(`| ${t.tolerancePct} | *${t.status}* | | | | | | |`); continue }
      L.push(`| ${t.tolerancePct} | ${f(t.hours.total, 0)} | ${AREAS.map(a => f(hoursBy(t, a), 0)).join(' | ')} | ${pct(t.summary.all.coverage, 2)} | ${f(t.summary.all.unmet)} | ${hoursProof(t)} |`)
    }
    L.push('', '**Where the additional attending coverage goes** — most attendings on duty at once, by area and time band (any day):', '')
    const t95 = targets.find(t => t.targetPct === 95 && t.ok)
    onDutyTable(L, [[`${B} h re-allocation`, base], ...(t95 ? [[`95% target (${f(t95.hours.total, 0)} h)`, t95]] : []), [`Minimum practical (${f(mp.hours.total, 0)} h)`, mp]])
    L.push('**Why the remaining deficits persist** (bottleneck diagnosis of the minimum-practical plan):', '')
    bottleneckTable(L, mp.bottlenecks)
    L.push('Largest remaining periods:', '')
    for (const x of mp.bottlenecks?.runs?.slice(0, 6) ?? []) L.push(`- ${x.text}`)
    L.push('')
  } else {
    L.push(`No minimum-practical plan: ${mp.message}`, '')
  }

  // ── 10 ─────────────────────────────────────────────────────────────────────
  L.push('## 10. Bottleneck diagnosis', '')
  L.push('For every area-hour with unmet demand in a plan, what would add capacity there (shared/bottlenecks.js):', '')
  L.push('- **Attending-limited** — another attending fits the team/area limits, adds capacity, and a permitted shift covering the hour puts ≥ 50% of its added capacity against unmet demand.')
  L.push('- **Resident/APP-limited** — an attending on duty has supervision headroom (or, in FastTrack, a PA works solo): one more PA would add capacity without another attending. *Diagnostic only; no resident/APP is added.*')
  L.push('- **Operational-rule-limited** — a configured rule blocks another attending: FastTrack closed, ERU cross-covered outside its window, ERU already at its one attending, or every team slot and the new-team pool full.')
  L.push('- **Shift-structure-limited** — another attending would help at that hour, but no permitted shift fits, or the best one would put < 50% of its capacity against unmet demand (the rest surplus).')
  L.push('- **Little modeled benefit** — neither another attending nor another resident/PA adds capacity.')
  L.push('Labels overlap (an hour can be limited several ways); the exclusive split counts each patient-hour once by its combination.', '')
  L.push(`### At ${B} h/week (re-allocated)`, '')
  bottleneckTable(L, base.bottlenecks)
  for (const x of base.bottlenecks?.runs?.slice(0, 6) ?? []) L.push(`- ${x.text}`)
  L.push('')
  if (mp.ok) {
    L.push(`### At the minimum practical requirement (${f(mp.hours.total, 0)} h/week)`, '')
    L.push('See section 9. As hours grow, attending-limited deficits disappear first; what remains is operational (closure, ERU cross-coverage,')
    L.push('ERU max one), shift-structure and resident/APP limits — deficits more attending-hours cannot efficiently remove under these rules.', '')
  }

  // ── 11 ─────────────────────────────────────────────────────────────────────
  L.push('## 11. Current vs expanded shift structure', '')
  L.push(`**CALCULATED** — same rules; expanded = any whole-hour start × ${r.structures.expanded.lengths.join('/')} h. Each expanded solve is warm-started from the current-menu plan (which is also valid under the expanded menu); where the search did not beat it, that plan is kept and marked ⚑ — the expanded menu is then *at least* that good.`, '')
  const ef = r.expanded.frontier, cf = r.expanded.currentFrontier
  L.push('| Budget | Current: coverage | unmet | shifts | distinct starts | Expanded: coverage | unmet | shifts | distinct starts | Δ unmet |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const e of ef) {
    const c = cf.find(x => x.budget === e.budget)
    if (!e.feasible || !c?.feasible) { L.push(`| ${e.budget} | — |||||||||`); continue }
    L.push(`| ${f(e.budget, 0)} | ${pct(c.coverage)} | ${f(c.unmet)} | ${c.plan?.shiftCount ?? '—'} | ${c.plan?.distinctStarts?.length ?? '—'} | ${pct(e.coverage)} | ${f(e.unmet)}${e.plan?.fellBack ? ' ⚑' : ''}${e.carriedForward ? ' ↺' : ''} | ${e.plan?.shiftCount ?? '—'} | ${e.plan?.distinctStarts?.length ?? '—'} | ${sgn(e.unmet - c.unmet)} |`)
  }
  L.push('', '| Target | Current: h/wk | Expanded: h/wk | Δ hours | Current shifts | Expanded shifts | Expanded distinct starts |', '|---|---|---|---|---|---|---|')
  for (const t of r.expanded.targets) {
    const c = targets.find(x => x.targetPct === t.targetPct)
    const cell = x => (x?.ok ? `${f(x.hours.total, 0)}${x.fellBack ? ' ⚑' : ''}` : 'infeasible')
    L.push(`| ${t.targetPct}% | ${cell(c)} | ${cell(t)} | ${c?.ok && t.ok ? sgn(t.hours.total - c.hours.total, 0) : '—'} | ${c?.shiftCount ?? '—'} | ${t.shiftCount ?? '—'} | ${t.distinctStarts?.length ?? '—'} |`)
  }
  const ep = r.expanded.practical[0]
  if (ep?.ok && mp.ok) {
    L.push('', `Minimum practical: current ${f(mp.hours.total, 0)} h (best achievable ${pct(mp.planning.bestAchievable.coverage, 2)}) vs expanded ${f(ep.hours.total, 0)} h${ep.fellBack ? ' ⚑' : ''} (best achievable ${pct(ep.planning?.bestAchievable?.coverage, 2)}); shifts ${mp.shiftCount} vs ${ep.shiftCount}, distinct start times ${mp.distinctStarts.length} vs ${ep.distinctStarts.length}.`)
    if (ep.bottlenecks) L.push(`Shift-structure-limited unmet: ${f(mp.bottlenecks.byLabel.SHIFT_STRUCTURE)} (current) vs ${f(ep.bottlenecks.byLabel.SHIFT_STRUCTURE)} patient-h (expanded).`)
  }
  L.push('')
  L.push(verdict(r, mp, ep), '')
  L.push('Expanded structures are shown for comparison, not recommended: more distinct start times means more handoffs and a harder roster to fill, which the model does not cost.', '')

  // ── 12 ─────────────────────────────────────────────────────────────────────
  L.push('## 12. ERU policy sensitivity', '')
  L.push('**CALCULATED** — same Main/FastTrack rules; only the ERU dedicated window changes (ERU max one throughout). Throughput cannot measure what dedicated ERU coverage provides (acuity coverage, resuscitation readiness); nothing here says which policy is clinically correct.', '')
  const pol = Object.keys(r.eru)
  L.push(`| | ${pol.map(k => POLICY_LABEL[k] ?? k).join(' | ')} |`, `|---|${pol.map(() => '---').join('|')}|`)
  L.push(`| ERU dedicated window | ${pol.map(k => `Mon–Fri ${describeWindow(r.eruPresets[k]?.weekday)}, Sat–Sun ${describeWindow(r.eruPresets[k]?.weekend)}`).join(' | ')} |`)
  L.push(`| ERU dedicated h/wk (hard rule) | ${pol.map(k => f(r.eru[k].fit?.minHours, 0)).join(' | ')} |`)
  for (const b of config.comparisonBudgets) {
    L.push(`| Unmet at ${b} h (coverage) | ${pol.map(k => { const x = r.eru[k].frontier?.find(y => y.budget === b); return x?.feasible ? `${f(x.unmet)} (${pct(x.coverage)})` : '—' }).join(' | ')} |`)
  }
  for (const t of config.targets) {
    L.push(`| Hours for ${t}% | ${pol.map(k => { const x = r.eru[k].targets?.find(y => y.targetPct === t); return !x ? '—' : x.ok ? f(x.hours.total, 0) : 'infeasible' }).join(' | ')} |`)
  }
  L.push(`| Minimum practical h/wk | ${pol.map(k => { const x = r.eru[k].practical?.[0]; return x?.ok ? `${f(x.hours.total, 0)} (${pct(x.summary.all.coverage)})` : '—' }).join(' | ')} |`)
  L.push(`| Best achievable coverage | ${pol.map(k => pct(r.eru[k].practical?.[0]?.planning?.bestAchievable?.coverage, 2)).join(' | ')} |`, '')
  const ext = r.extendedEveningFit
  L.push(`Extended evening (weekdays 09–23) is not analysed: a 14-hour window cannot be staffed with one ERU attending at a time using 8/10/12-hour shifts that stay inside the window — current menu ${ext.current?.feasible ? 'feasible' : 'infeasible'}, expanded (hourly) menu ${ext.expanded?.feasible ? `feasible (${ext.expanded.minHours} h)` : 'infeasible'} — true for any start times, since one shift is ≤ 12 h and two are ≥ 16 h.`, '')

  // ── 13 ─────────────────────────────────────────────────────────────────────
  L.push('## 13. FTE / cost translation', '')
  L.push(`**CONFIGURED FOR THIS REPORT ONLY.** No clinical FTE definition or institutional rate is built into the tool; both are inputs. FTE = annual hours ÷ clinical hours per FTE per year (options ${config.units.clinicalHoursPerFteOptions.join(' / ')}). Cost uses **$${rate}/h — the app's illustrative placeholder rate, not institutional cost**. All cost figures are illustrative planning estimates.`, '')
  L.push(`| Plan | Attending h/wk | Annual h | ${config.units.clinicalHoursPerFteOptions.map(h => `FTE @ ${f(h, 0)}`).join(' | ')} | Illustrative cost @ $${rate}/h |`, `|---|---|---|${config.units.clinicalHoursPerFteOptions.map(() => '---').join('|')}|---|`)
  const unitRows = [[`Today / ${B} h`, B], ...targets.filter(t => t.ok).map(t => [`${t.targetPct}% target`, t.hours.total]), ...(mp.ok ? [['Minimum practical', mp.hours.total]] : [])]
  for (const [label, h] of unitRows) {
    const u = planningUnits(h, { hourlyRate: rate })
    L.push(`| ${label} | ${f(h, 0)} | ${f(u.annual, 0)} | ${config.units.clinicalHoursPerFteOptions.map(x => f(planningUnits(h, { clinicalHoursPerFte: x }).fte, 1)).join(' | ')} | $${f(u.cost / 1e6, 2)}M |`)
  }
  L.push('')

  // ── 14 ─────────────────────────────────────────────────────────────────────
  L.push('## 14. Search robustness', '')
  L.push(`CP-SAT, deterministic parallel search (same inputs → same plan). "Optimal" = proven within ${f(100 * r.solverInfo.optimalityGap, 1)}%; otherwise the gap bounds how far the objective may be from the best possible. Effort: ${Object.entries(r.solverInfo.effortDeterministicSeconds).map(([k, v]) => `${k} ${v}`).join(', ')} deterministic seconds per stage.`, '')
  L.push('| Budget | Standard: unmet · gap | Thorough: unmet · gap | Difference |', '|---|---|---|---|')
  for (const x of rows) {
    const s = frontier.standard.find(y => y.budget === x.budget)
    if (!x.feasible || !s?.feasible) continue
    L.push(`| ${f(x.budget, 0)} | ${f(s.unmet)} · ${s.status === 'optimal' ? 'opt' : `${f(100 * s.gap)}%`}${s.carriedForward ? ' ↺' : ''} | ${f(x.unmet)} · ${x.status === 'optimal' ? 'opt' : `${f(100 * x.gap)}%`}${x.carriedForward ? ' ↺' : ''} | ${sgn(s.unmet - x.unmet)} |`)
  }
  L.push('')
  const coldRows = Object.entries(frontier.cold ?? {})
  if (coldRows.length) {
    L.push('Warm vs cold start (thorough):', '')
    for (const [b, c] of coldRows) {
      const w = rows.find(y => y.budget === Number(b))
      L.push(`- ${b} h: warm-started ${f(w?.unmet)} unmet · cold ${f(c.summary?.all?.unmet)} unmet (gap ${f(100 * (c.gap ?? 0))}%).`)
    }
    L.push('')
  }
  const carried = rows.filter(x => x.carriedForward).map(x => x.budget)
  const stdCarried = frontier.standard.filter(x => x.carriedForward).map(x => x.budget)
  const gaps = rows.filter(x => x.feasible).map(x => x.gap ?? 0)
  const comps = searchComparisons(r)
  const worstBy = label => comps.filter(x => x.label === label).reduce((m, x) => (x.diff > (m?.diff ?? -1) ? x : m), null)
  L.push(`- Thorough frontier gaps: ${f(100 * Math.min(...gaps))}–${f(100 * Math.max(...gaps))}%.`)
  L.push(`- Independent searches of the same budget differ in modeled unmet by up to **${f(noise)} patient-h/week** — ${['standard vs thorough', 'cold vs warm start', 'second warm-start chain', 'baseline run'].map(l => { const w = worstBy(l); return w ? `${l} ${f(w.diff)} (at ${w.budget} h)` : null }).filter(Boolean).join('; ')}. This band marks near-ties (~). Sections 11–12 use the second chain, so their Current-policy figures can differ from section 6 by up to this amount.`)
  L.push(`- Carried-forward points (search did not beat the smaller budget's plan): thorough ${carried.length ? carried.join(', ') : 'none'}; standard ${stdCarried.length ? stdCarried.join(', ') : 'none'}.`)
  const unstable = marg.filter(m => m.withinNoise).map(m => `${m.from}→${m.to}`)
  L.push(`- Frontier steps smaller than the search uncertainty (read as ties): ${unstable.length ? unstable.join(', ') : 'none'}.`)
  L.push('- Target and minimum-practical hours are solved as their own stage (fewest hours meeting the cap) and reported as "proven minimum" only when the lower bound equals the hours found. The placement stage (where those hours go) has its own gap, shown in the JSON.')
  const cc = [base, ...targets.filter(t => t.ok), ...(mp.ok ? [mp] : [])].map(x => x.crossCheck ?? 0)
  L.push(`- Solver vs app capacity agree within ${f(Math.max(...cc), 3)} patients/hr per area-hour on the reported plans (limit 0.02).`, '')

  // ── 15 ─────────────────────────────────────────────────────────────────────
  L.push('## 15. Limitations', '')
  for (const x of [
    'Modeled coverage and unmet patient-hours come from a capacity model with assumed productivity; they are not observed throughput, wait times, LOS or LWBS.',
    'Demand is the historical mean by day of week and hour. Mean demand is not a peak-service guarantee; percentile targets or surge scenarios would need more hours.',
    'Acuity, resuscitation readiness, boarding, documentation, interruptions, procedures and consultant coordination are not modeled. ERU\'s dedicated coverage value is largely outside this model.',
    'Resident/PA schedules are held fixed. Resident/APP-limited deficits indicate where the roster, not attending hours, binds; expanding it is a separate workforce question not analysed here.',
    'The cross-cover throughput credit is conservative (none) in the primary scenario; a less conservative assumption would lower ERU unmet outside its window.',
    'Team/pool limits (one per existing team, three new-team attendings per area) are planning settings; physical space, beds and nursing are not modeled.',
    'Shift structure limits are real: some deficits (short peaks, closed hours) cannot be reached efficiently with 8/10/12-hour shifts at the permitted starts.',
    'Search results are best found within a deterministic budget unless marked proven; neighbouring frontier points within the search uncertainty should be read as ties.',
    'Nothing here selects a staffing budget, an ERU policy or a shift structure. FTE and cost figures depend entirely on the configured values.',
  ]) L.push(`- ${x}`)
  L.push('')
  return L.join('\n')
}

// "Does this ED need more attending HOURS, different TIMING, or both?"
// Stated from the computed numbers, with the comparison it rests on.
function verdict(r, mp, ep) {
  const cf = r.expanded.currentFrontier, ef = r.expanded.frontier
  const at = (list, b) => list.find(x => x.budget === b && x.feasible)
  const b = r.config.currentBudget
  const c0 = at(cf, b), e0 = at(ef, b)
  const parts = []
  if (c0 && e0) parts.push(`At ${b} h, allowing hourly starts changes modeled unmet by ${sgn(e0.unmet - c0.unmet)} patient-h/week (${f(c0.unmet)} → ${f(e0.unmet)}).`)
  const t95c = r.targets.find(t => t.targetPct === 95), t95e = r.expanded.targets.find(t => t.targetPct === 95)
  if (t95c?.ok && t95e?.ok) parts.push(`Reaching 95% needs ${f(t95c.hours.total, 0)} h with current starts vs ${f(t95e.hours.total, 0)} h with hourly starts (${sgn(t95e.hours.total - t95c.hours.total, 0)} h).`)
  if (mp?.ok && ep?.ok) parts.push(`The minimum practical requirement is ${f(mp.hours.total, 0)} h (current) vs ${f(ep.hours.total, 0)} h (expanded), and the best achievable coverage ${pct(mp.planning.bestAchievable.coverage, 2)} vs ${pct(ep.planning?.bestAchievable?.coverage, 2)}.`)
  const base = r.baseline.thorough
  if (t95c?.ok) parts.push(`Against today's ${b} h, the 95% target alone asks for ${sgn(t95c.hours.total - b, 0)} attending h/week under the current structure.`)
  const timing = c0 && e0 ? c0.unmet - e0.unmet : 0
  const hours = t95c?.ok ? t95c.hours.total - b : null
  let answer = '**Under this model:** '
  if (hours != null && hours > 0 && timing > 2) answer += 'both — more attending hours are needed to reach high modeled coverage targets, and better attending timing recovers part of the gap at a fixed budget.'
  else if (hours != null && hours > 0) answer += 'mainly more attending hours — changing start times recovers little at a fixed budget.'
  else if (timing > 2) answer += 'mainly timing — the expanded start grid recovers a meaningful share of unmet demand at today\'s hours.'
  else answer += 'neither hours nor timing changes modeled coverage much in the tested range; the residual is operational or resident/APP-limited.'
  void base
  return `${parts.join(' ')}\n\n${answer} This describes modeled throughput only; it is not a recommendation to change the shift structure or the budget.`
}
