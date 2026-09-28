// Markdown report: current schedule vs unconstrained vs operationally
// constrained attending allocation. Sections are kept strictly separate:
//   OBSERVED INPUTS -> CONFIGURED OPERATIONAL REQUIREMENTS -> MODEL
//   ASSUMPTIONS -> OPTIMIZATION OUTPUTS
import { AREA_LABEL, SCOPE_LABEL } from '../src/shared/areas'
import { describeCrossCoverCredit, describeRule } from '../src/shared/operationalCoverage'
import { DEFAULT_MAX_FLEX, DEFAULT_MAX_PER_TEAM, WEEKS_PER_YEAR } from '../src/shared/staffingPlan'
import { periodText } from '../validation/compare'

const f = (n, d = 1) => Number(n).toFixed(d)
const sgn = (n, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${f(Math.abs(n), d)}`
const pct = m => (m.demand > 0 ? `${f((100 * m.served) / m.demand)}%` : '—')
const AREAS = ['main', 'fasttrack', 'eru']
const short = d => d.slice(0, 3)
const sum = (s, get) => AREAS.reduce((t, a) => t + get(s, a), 0)

function shiftLines(plannedByDay) {
  const groups = new Map()
  for (const [day, shifts] of Object.entries(plannedByDay)) {
    for (const s of shifts) {
      const key = `${s.team}|${s.start_time}|${s.end_time}`
      if (!groups.has(key)) groups.set(key, { team: s.team, time: `${s.start_time}–${s.end_time}`, days: [] })
      groups.get(key).days.push(day)
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.team.localeCompare(b.team) || a.time.localeCompare(b.time))
    .map(g => `- ${g.team} ${g.time} (${g.days.length === 7 ? 'every day' : g.days.map(short).join(', ')})`)
}

function rulesBlock(L, coverage) {
  for (const a of AREAS) {
    const ac = coverage.areas[a]
    if (!ac) continue
    L.push(`- **${AREA_LABEL[a]}** — otherwise: ${describeRule(a, { ...ac.default, fromHour: 0, toHour: 0 }).replace(/^\S+ every day 24 h: /, '')}`)
    for (const rule of ac.rules) L.push(`  - ${rule.label ? `${rule.label}: ` : ''}${describeRule(a, rule)}`)
  }
}

export function renderCoverageReport(r) {
  const { schedules, coverage, observed, assumptions, budget, thorough } = r
  const by = Object.fromEntries(schedules.map(s => [s.key, s]))
  const cur = by.current, unc = by.unconstrained, flex = by.eruFlexible, con = by.constrained
  const cols = [cur, unc, con]
  const L = []

  L.push('# Operational coverage: current vs unconstrained vs operationally constrained allocation', '')
  L.push(`Generated ${r.when}. Scope: ${SCOPE_LABEL[r.scope]}. Attending budget: ${f(budget, 0)} h/week (today's). Demand: ${r.target}.`, '')
  L.push('> **Decision-support estimates, not staffing requirements.** Coverage figures are outputs of a capacity model')
  L.push('> built on the assumptions in section 3. The operational requirements in section 2 are configuration read off')
  L.push('> today\'s schedule and historical arrivals, not validated clinical rules. None of the schedules below is')
  L.push('> "clinically optimal"; the constrained plan is the best this model found *given* the configured requirements.', '')

  // ── 1. Observed ─────────────────────────────────────────────────────────
  L.push('## 1. Observed historical inputs', '')
  L.push(`Source: \`${observed.sources.join('`, `')}\`. ${observed.nDays ?? '?'} days of arrivals.`, '')
  L.push('| Area | Historical patient-hours / week | Current attending h / week |', '|---|---|---|')
  for (const a of AREAS) L.push(`| ${AREA_LABEL[a]} | ${f(observed.demand[a])} | ${f(cur.structure.hoursByArea[a], 0)} |`)
  L.push('')
  L.push('- Current attending windows (schedule): ERU Mon–Fri 09:00–01:00 and Sat–Sun 11:00–19:00; FastTrack 09:00–01:00 daily; Main ≥ 2 at every hour.')
  L.push('- ERU residents are on 24/7 (Tuesday overnight: a PA instead).')
  L.push('- FastTrack historical arrivals are < 0.5/hr at every hour 01:00–06:59. FastTrack demand is historical FastTrack routing — never inferred from ESI.', '')

  // ── 2. Configured requirements ──────────────────────────────────────────
  L.push('## 2. Configured operational requirements', '')
  L.push('Last matching rule wins, else the area default. Windows are on the circular 24-hour day template.', '')
  rulesBlock(L, coverage)
  L.push('')
  for (const n of coverage.notes ?? []) L.push(`- _Basis:_ ${n}`)
  L.push('')

  // ── 3. Assumptions ──────────────────────────────────────────────────────
  const p = assumptions.pph
  const sv = assumptions.solver
  L.push('## 3. Model assumptions', '')
  L.push(`- Throughput (patients/hr): Main ceiling ${p.main} / solo ${p.mainOwn}; FastTrack ${p.fasttrack} / ${p.fasttrackOwn}; ERU ${p.eru} / ${p.eruOwn};`)
  L.push(`  PA ${p.pa}; FastTrack PA solo ${p.fasttrackPa}; PGY-1…4 ${p.pgy1}/${p.pgy2}/${p.pgy3}/${p.pgy4}; off-service ${p.offService}.`)
  L.push('- Team capacity = min(attendings × ceiling, attendings × solo + supervised residents/PAs) + solo FastTrack PAs. Areas never lend capacity.')
  L.push('- **Cross-coverage.** Outside ERU\'s dedicated hours Main is responsible for ERU and supervises its residents/PAs. The THROUGHPUT that')
  L.push(`  adds is an explicit assumption; this report uses: ${describeCrossCoverCredit(coverage.areas.eru?.crossCoverCredit, p)}.`)
  L.push('  (See cross-cover-sensitivity.md for the same analysis under other credit assumptions.) ERU demand stays ERU\'s; Main\'s capacity is unchanged.')
  L.push('- **Closed hours.** No attending placed; historical demand recorded in those hours still counts (unmet unless covered).')
  L.push('- Residents/PAs with no attending and no cross-coverage are credited 0 and reported as unsupervised.')
  L.push(`- Objective (unchanged): tiered unmet demand per area-hour (weights ${sv.deficitTierWeights.join('/')} at ${sv.deficitTierBoundsPph.join('/')} patients/hr), then excess (weight ${sv.excessWeight}), then hours.`)
  L.push(`- At most ${DEFAULT_MAX_PER_TEAM} attending per existing team; up to ${DEFAULT_MAX_FLEX} on new teams per area. Shift menu: ${r.menu}. Residents/PAs as scheduled. No locked shifts.`)
  L.push(`- Solver: OR-Tools CP-SAT, deterministic, "standard" effort (thorough re-runs in 4.3), stops at ${f(sv.optimalityGap * 100, 1)}% of the proven bound.`, '')
  L.push('**Scoring.** Every schedule is scored with the same capacity model: Main cross-covers ERU in *any* hour ERU has no attending')
  L.push('(so plans that drop current ERU dedicated hours get Main cross-cover there too, under the same credit assumption). Compliance with the configured')
  L.push('requirements is counted separately. "Legacy" scoring (no cross-coverage: ERU residents without an ERU attending count for')
  L.push('nothing) is shown for continuity with the Main-ceiling sensitivity report, where the unconstrained plan was produced.', '')

  // ── 4. Outputs ──────────────────────────────────────────────────────────
  L.push('## 4. Optimization outputs', '')
  L.push(`| Per week | ${cols.map(s => s.label).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`)
  const row = (label, get, list = cols) => L.push(`| ${label} | ${list.map(get).join(' | ')} |`)
  row('Total attending h', s => f(s.structure.totalHours, 0))
  for (const a of AREAS) row(`${AREA_LABEL[a]} attending h`, s => f(s.structure.hoursByArea[a], 0))
  row('Hard-rule attending h (current ERU dedicated coverage + Main 24/7)', s => f(sum(s, (x, a) => x.operational[a].requiredAttendingHours), 0))
  row('… of which staffed', s => f(sum(s, (x, a) => x.operational[a].requiredAttendingHoursMet), 0))
  row('Flexible attending h (beyond the rule)', s => f(sum(s, (x, a) => x.operational[a].voluntaryAttendingHours), 0))
  row('**Hard-rule violations** (area-hours)', s => `**${sum(s, (x, a) => x.operational[a].requiredShortfallHours)}**`)
  row('Modeled coverage, overall', s => `**${pct(s.metrics.all)}**`)
  for (const a of AREAS) row(`Modeled coverage, ${AREA_LABEL[a]}`, s => pct(s.metrics.byArea[a]))
  row('Unmet patient-h, overall', s => `**${f(s.metrics.all.deficit)}**`)
  for (const a of AREAS) row(`Unmet patient-h, ${AREA_LABEL[a]}`, s => f(s.metrics.byArea[a].deficit))
  row('Unmet patient-h, overall (legacy scoring)', s => f(s.legacy.all.deficit))
  row('Excess beyond tolerance (patient-h)', s => f(s.metrics.all.excess))
  row('Surplus capacity (patient-h)', s => f(s.metrics.all.surplus))
  row('Hours with a dedicated attending (Main / FT / ERU)', s => AREAS.map(a => s.coverageUse[a].hoursDedicated).join(' / '))
  row('Hours cross-covered (ERU by Main)', s => s.coverageUse.eru.hoursCrossCovered)
  row('Hours flexible with no attending (FT)', s => s.coverageUse.fasttrack.hoursFlexibleUncovered)
  row('Hours closed (FT)', s => s.coverageUse.fasttrack.hoursClosedUncovered)
  row('Unsupervised resident/PA area-hours', s => sum(s, (x, a) => x.coverageUse[a].unsupervisedExtenderHours))
  row('Solver status · gap', s => (s.solver ? `${s.solver.status} · ${f(s.solver.gap * 100, 1)}%` : '—'))
  L.push('')

  L.push('### 4.1 ERU detail', '')
  L.push(`| ERU, per week | ${cols.map(s => s.label).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`)
  const e = s => s.coverageUse.eru
  row('Hours with a dedicated ERU attending', s => e(s).hoursDedicated)
  row('Hours cross-covered by Main (not dedicated)', s => e(s).hoursCrossCovered)
  row('… of which inside the current ERU dedicated window', s => s.operational.eru.requiredShortfallHours)
  row('ERU attending h in the hard rule', s => f(s.operational.eru.requiredAttendingHours, 0))
  row('ERU attending h beyond the rule (voluntary)', s => f(s.operational.eru.voluntaryAttendingHours, 0))
  row('ERU demand (patient-h)', s => f(e(s).demand))
  row('ERU demand in cross-covered hours', s => f(e(s).crossCovered.demand))
  row('ERU unmet, total', s => f(e(s).unmet))
  row('ERU unmet while dedicated', s => f(e(s).unmetWhenDedicated))
  row('ERU unmet while cross-covered', s => f(e(s).crossCovered.unmet))
  row('ERU patients handled under Main responsibility', s => f(s.coverageUse.main.coveringLoad.eru ?? 0))
  L.push('')
  L.push('Cross-covered hours are not equivalent to dedicated ERU coverage: the model credits only ERU\'s residents/PAs, capped by')
  L.push('Main\'s supervision headroom under the configured credit assumption, and nothing for an attending physically present in ERU.', '')

  L.push('### 4.2 Fast Track closed hours', '')
  const ft = s => s.coverageUse.fasttrack
  L.push(`- ${ft(con).configuredHours.CLOSED} configured closed hours per week, with ${f(ft(con).closed.demand)} patient-h/week of historical FastTrack demand recorded in them.`)
  L.push('- That demand is identical in every schedule: nothing is created, deleted, or re-routed.')
  L.push(`- Unmet during closed hours: ${cols.map(s => `${s.label} ${f(ft(s).closed.unmet)}`).join('; ')}.`)
  L.push('- Overnight FastTrack-team residents/PAs are routed to Main while FastTrack is closed (see limitations), so they add Main capacity, not FastTrack.', '')

  L.push('### 4.3 Search sensitivity', '')
  L.push('CP-SAT stops at a deterministic work budget, so plans are "best found", not proven optimal. The same instances at 3× the budget:', '')
  L.push('| Plan | Standard: unmet · gap | Thorough: unmet · gap |', '|---|---|---|')
  L.push(`| ${con.label} | ${f(con.metrics.all.deficit)} · ${f(con.solver.gap * 100, 1)}% | ${f(thorough.constrained.metrics.all.deficit)} · ${f(thorough.constrained.solver.gap * 100, 1)}% |`)
  L.push(`| ${flex.label} | ${f(flex.metrics.all.deficit)} · ${f(flex.solver.gap * 100, 1)}% | ${f(thorough.eruFlexible.metrics.all.deficit)} · ${f(thorough.eruFlexible.solver.gap * 100, 1)}% |`)
  L.push('')
  L.push('Differences of a few patient-hours between plans are within search noise; treat them as ties.', '')

  // ── 5. Cost of constraints ──────────────────────────────────────────────
  const unmet = s => s.metrics.all.deficit
  const cov = s => (100 * s.metrics.all.served) / s.metrics.all.demand
  L.push('## 5. The cost of the operational constraints', '')
  L.push('Same budget, same capacity model (section 3 scoring), same objective. Only the operational coverage layer differs.', '')
  L.push(`| Per week | ${[unc, flex, con].map(s => s.label).join(' | ')} |`, '|---|---|---|---|')
  const r3 = (label, get) => row(label, get, [unc, flex, con])
  r3('Operational layer in the optimizer', s => (s === unc ? 'none' : s === flex ? 'Main 24/7, FT closed, ERU cross-cover; current ERU dedicated coverage **left to the optimizer**' : 'Main 24/7, FT closed, ERU cross-cover; current ERU dedicated coverage **kept as a hard rule**'))
  for (const a of AREAS) r3(`${AREA_LABEL[a]} attending h`, s => f(s.structure.hoursByArea[a], 0))
  r3('Hard-rule violations (area-hours)', s => sum(s, (x, a) => x.operational[a].requiredShortfallHours))
  r3('Unmet patient-h, overall', s => `**${f(unmet(s))}**`)
  for (const a of AREAS) r3(`Unmet patient-h, ${AREA_LABEL[a]}`, s => f(s.metrics.byArea[a].deficit))
  r3('Modeled coverage, overall', s => pct(s.metrics.all))
  L.push('')
  const eruReq = con.operational.eru.requiredAttendingHours
  const costEru = unmet(con) - unmet(flex)
  const costEruT = unmet(thorough.constrained) - unmet(thorough.eruFlexible)
  const vsUnc = unmet(con) - unmet(unc)
  L.push('**Reading.**', '')
  L.push(`- **Cost of keeping the current ERU dedicated coverage as a hard rule: ${sgn(costEru)} patient-h/week** of modeled unmet demand (${sgn(cov(con) - cov(flex), 1)} pp coverage).`)
  L.push(`  This compares the constrained plan with the same model and cross-cover, but ERU dedicated hours left to the optimizer. It is ${sgn(costEruT)} at thorough search.`)
  L.push('  Both plans improve with more search, but the flexible-ERU plan (largest gap) improves most, so the thorough figure is the better estimate.')
  L.push(`  About ${f(costEru / Math.max(1, eruReq), 2)} patient-h per ERU attending-hour held by the rule (${f(eruReq, 0)} h/week).`)
  L.push(`  When free to choose, the optimizer keeps ${f(flex.structure.hoursByArea.eru, 0)} ERU attending-h/week, relies on Main cross-cover for the rest of ERU, and moves those hours to Main/FastTrack peaks.`)
  L.push(`- **Versus the original unconstrained plan: ${sgn(vsUnc)} patient-h/week.** That plan was optimized without cross-coverage or closures.`)
  L.push(`  It violates ${sum(unc, (x, a) => x.operational[a].requiredShortfallHours)} hard-rule area-hours; it is scored here with Main cross-covering ERU in those hours.`)
  L.push('- These are modeled throughput numbers exchanged for keeping today\'s ERU dedicated coverage — whether that coverage is clinically necessary is not something this model establishes. They are a decision-support input, not a verdict against the requirement.')
  L.push('- ERU\'s value is acuity and resuscitation readiness, which a throughput model does not measure.', '')

  // ── 6. Worst periods ────────────────────────────────────────────────────
  L.push('## 6. Worst deficit periods', '')
  for (const s of cols) {
    L.push(`**${s.label}**`, '')
    L.push(...(s.metrics.periods.length ? s.metrics.periods.slice(0, 5).map(x => `- ${periodText(x)}`) : ['- none']), '')
  }

  // ── 7. Constrained plan shifts ─────────────────────────────────────────
  L.push('## 7. Operationally constrained plan — attending shifts', '')
  L.push(...shiftLines(con.plannedByDay), '')
  L.push(`Annualised: ${f(con.structure.totalHours * WEEKS_PER_YEAR, 0)} attending h/year (× ${WEEKS_PER_YEAR}).`, '')

  // ── 8. Limitations ──────────────────────────────────────────────────────
  L.push('## 8. Limitations', '')
  L.push('- Cross-coverage throughput is an unvalidated assumption (conservative by default: none). See cross-cover-sensitivity.md.')
  L.push('  - When credit is on, a Main attending\'s own direct patient care in ERU is still not credited, and Main\'s expected demand is counted first.')
  L.push('- Covering responsibility is pooled across all Main attendings on duty, not assigned to a named team.')
  L.push('- Acuity, resuscitation readiness and time-to-attending are not modelled. The ERU dedicated window is today\'s schedule kept as a rule, not a model output or an established clinical minimum.')
  L.push('- FastTrack-team residents/PAs scheduled overnight (e.g. "EM3/4-Green" 23:00–07:00) are routed to the Main team in their role_detail')
  L.push('  suffix while FastTrack is closed — a confirmed operational routing rule.')
  L.push('- Day templates are circular: an overnight window wraps into the early hours of the same weekday.')
  L.push('- Operational capacity applies in the staffing planner and these reports; the main schedule chart and heatmap show capacity as scheduled (labelled).')
  L.push('- No patient redistribution: extending FastTrack hours, ESI routing and counterfactual flows are out of scope.', '')
  return L.join('\n')
}
