// Markdown report: ERU dedicated-coverage scenarios under a fixed Whole ED
// attending budget. Kept strictly separated: OBSERVED / CONFIGURED
// OPERATIONAL POLICY / MODEL ASSUMPTIONS / MODEL OUTPUT.
import { AREA_LABEL } from '../src/shared/areas'
import { describeCrossCoverCredit, describeRule, describeWindow } from '../src/shared/operationalCoverage'
import { periodText } from '../validation/compare'
import { solverStatus } from '../src/shared/solverStatus'

const f = (n, d = 1) => Number(n).toFixed(d)
const sgn = (n, d = 1) => (Math.abs(n) < 0.05 * 10 ** -(d - 1) ? '±0' : `${n > 0 ? '+' : '−'}${f(Math.abs(n), d)}`)
const pct = m => (m.demand > 0 ? (100 * m.served) / m.demand : 100)
const pctS = m => `${f(pct(m))}%`
const AREAS = ['main', 'fasttrack', 'eru']
const BANDS = [['07–15', h => h >= 7 && h < 15], ['15–23', h => h >= 15 && h < 23], ['23–07', h => h >= 23 || h < 7]]
const LARGE_GAP = 0.10

const hardHours = r => AREAS.reduce((t, a) => t + r.op[a].requiredAttendingHours, 0)
const flexHours = r => AREAS.reduce((t, a) => t + r.op[a].voluntaryAttendingHours, 0)
const band = (r, area, test) => Object.values(r.structure.onDuty[area]).reduce((t, row) => t + row.reduce((u, v, h) => u + (test(h) ? v : 0), 0), 0)
const gapFlag = r => `${solverStatus(r.solver.status, r.solver.gap).short}${r.solver.gap > LARGE_GAP ? ' ⚠' : ''}`
const winText = p => (p.weekday || p.weekend ? `Mon–Fri ${describeWindow(p.weekday)} · Sat–Sun ${describeWindow(p.weekend)}` : 'no dedicated ERU window')

export function renderEruScenarioReport(r) {
  const { scenarios, curve, routing, observed, base, pph, budget } = r
  const cur = curve.find(p => p.key === 'current')
  const T = p => p.thorough
  // Search noise: largest standard-vs-thorough unmet difference seen.
  const noise = Math.max(...curve.filter(p => !p.infeasible).map(p => Math.abs(p.standard.metrics.all.deficit - p.thorough.metrics.all.deficit)))
  const L = []

  L.push('# ERU dedicated-coverage scenarios under a fixed attending budget', '')
  L.push(`Generated ${r.when}. Whole ED, **${budget} attending h/week** in every scenario (today's total). Primary figures: thorough search.`, '')
  L.push('> **Decision-support estimates.** Coverage and unmet demand are outputs of a capacity model, not observed throughput or')
  L.push('> wait times. The throughput model does not measure what dedicated ERU coverage provides — acuity coverage,')
  L.push('> resuscitation readiness, immediate attending availability. Nothing here says which ERU window is clinically right.', '')

  // ── 1 ────────────────────────────────────────────────────────────────────
  L.push('## 1. Question being tested', '')
  L.push('Each scenario **fixes** when ERU has a dedicated attending (the allocator is not deciding whether ERU deserves one). With the')
  L.push(`total held at ${budget} h/week, the allocator places the remaining attending-hours across Main and FastTrack to minimise modeled`)
  L.push('unmet demand. The question: *what modeled throughput opportunity cost elsewhere is associated with dedicating more — or fewer —')
  L.push('attending-hours to ERU, and where does it appear?*', '')

  // ── 2 ────────────────────────────────────────────────────────────────────
  L.push('## 2. Observed inputs', '')
  L.push(`**OBSERVED** — \`${observed.sources.join('`, `')}\`: the committed processed-data snapshot (arrivals 2025-08-04 → 2026-05-31). Demand = patients roomed on each area's team per hour, averaged over ${observed.nDays ?? '?'} distinct roomed dates. (The app's live local database is a later, larger extract.)`, '')
  L.push('| Area | Historical patient-hours / week | Current attending h / week |', '|---|---|---|')
  for (const a of AREAS) L.push(`| ${AREA_LABEL[a]} | ${f(observed.demand[a])} | ${f(observed.attendingHours[a], 0)} |`)
  L.push('')
  L.push(`- Current schedule: ${Object.entries(observed.byRole).map(([k, v]) => `${v} ${k}`).join(', ')} shifts per week. Residents/PAs are fixed in every scenario.`)
  L.push('- FastTrack demand is historical FastTrack routing; ERU demand is historical ERU patients (by roomed hour). Neither is re-routed; no ESI is used.')
  L.push(`- Overnight FastTrack-team residents/PAs on duty while FastTrack is closed (01:00–07:00): ${routing.routed.length} shifts/week, each with a Main-team suffix in the schedule's role_detail:`)
  for (const x of routing.routed) L.push(`  - ${x.day.slice(0, 3)} ${x.shift.role_type} "${x.shift.role_detail}" ${x.shift.start_time}–${x.shift.end_time} → operates on ${x.rule.to.team} ${x.hours[0] < 10 ? '0' : ''}${x.hours[0]}:00–07:00`)
  L.push('')

  // ── 3 ────────────────────────────────────────────────────────────────────
  L.push('## 3. Fixed operational rules', '')
  L.push('**CONFIGURED OPERATIONAL POLICY** (same in every scenario except the ERU window):', '')
  L.push(`- ${describeRule('main', { ...base.areas.main.default, fromHour: 0, toHour: 0 })}.`)
  for (const x of base.areas.fasttrack.rules) L.push(`- ${describeRule('fasttrack', x)} (demand recorded then still counts).`)
  L.push('- ERU: at most **one** dedicated attending at a time (structural). Outside its dedicated window ERU is cross-covered by Main: Main is')
  L.push('  responsible and supervises ERU residents/PAs.')
  L.push('- Staff operating-area routing:')
  for (const x of routing.rules) L.push(`  - ${x.label} (${x.fromHour}:00–${x.toHour}:00)${x.confirmed ? ' — confirmed operational routing rule' : ' — **not confirmed (scenario only)**'}`)
  L.push(`- Shift menu: starts ${[...new Set(r.patterns.map(p => p.start))].map(h => `${String(h).padStart(2, '0')}:00`).join(', ')} × ${[...new Set(r.patterns.map(p => p.length))].join('/')} h.`, '')
  L.push('**MODEL ASSUMPTIONS:**', '')
  L.push(`- Supervision ceilings / solo throughput (patients/hr): Main ${pph.main}/${pph.mainOwn}, FastTrack ${pph.fasttrack}/${pph.fasttrackOwn}, ERU ${pph.eru}/${pph.eruOwn}.`)
  L.push(`- Resident/PA productivity (assumed): PGY-1…4 ${pph.pgy1}/${pph.pgy2}/${pph.pgy3}/${pph.pgy4}, off-service ${pph.offService}, PA ${pph.pa}, FastTrack solo PA ${pph.fasttrackPa}.`)
  L.push('- Team capacity = min(attendings × ceiling, attendings × solo + supervised residents/PAs) + FastTrack solo PAs; areas never lend capacity.')
  L.push(`- ERU cross-cover throughput credit: **${describeCrossCoverCredit(base.areas.eru.crossCoverCredit, pph)}** (conservative).`)
  L.push(`- Demand target: ${r.target} historical patients roomed per hour, by day of week.`)
  L.push(`- Objective: minimise tiered unmet demand per area-hour, then excess, then hours (${r.solverInfo.deficitTierWeights.join('/')} / ${r.solverInfo.excessWeight} / ${r.solverInfo.hourWeight}). OR-Tools CP-SAT, deterministic.`, '')

  // ── 4 ────────────────────────────────────────────────────────────────────
  L.push('## 4. Scenario definitions', '')
  L.push('| Scenario | ERU dedicated window | ERU attending h/week needed | Representable with the shift menu? |', '|---|---|---|---|')
  for (const p of curve) {
    const repr = p.infeasible
      ? `**No** — ${p.fit.byDay.filter(d => !d.feasible).map(d => `${d.day.slice(0, 3)} ${d.required} h`).join(', ')}: no non-overlapping 8/10/12 h shifts fit`
      : `yes (${[...new Set(p.fit.byDay.filter(d => d.shifts.length).map(d => d.shifts.map(s => `${String(s.start).padStart(2, '0')}:00+${s.length}h`).join(' + ')))].join('; ') || 'no ERU shifts'})`
    L.push(`| ${p.label}${MAIN_MARK(p)} | ${winText(p)} | ${p.fit ? (p.fit.minHours ?? '—') : 0} | ${repr} |`)
  }
  L.push('')
  L.push('★ = one of the four requested comparison scenarios. Only **Current** describes practice (today\'s schedule — not a clinically')
  L.push('validated minimum); every other window is an illustrative analysis scenario, not a recommendation. Windows are editable in')
  L.push('`analysis/eruCoverageScenarios.analysis.js` and in the Staffing Planner.', '')
  const ext = curve.find(p => p.key === 'extendedEvening')
  if (ext?.infeasible) {
    L.push(`**Extended evening is infeasible as defined.** A 14-hour weekday window cannot be covered by 8/10/12-hour shifts without two ERU`)
    L.push('attendings overlapping or a dedicated shift running outside the window (one shift is at most 12 h; two are at least 16 h) — true')
    L.push(`for any start times. ${ext.solverRefused ? 'The solver also refuses it rather than violating a rule.' : ''} The curve includes the nearest representable`)
    L.push('windows (weekdays 09–21, and 07–23 which is 16 h like today but earlier).', '')
  }

  // ── 5 ────────────────────────────────────────────────────────────────────
  L.push('## 5. Results table', '')
  L.push('**MODEL OUTPUT** — modeled allocation, best found (thorough search), per week.', '')
  const feas = scenarios.filter(p => !p.infeasible)
  const cols = scenarios
  L.push(`| | ${cols.map(p => p.preset?.short ?? p.label).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`)
  const row = (label, get) => L.push(`| ${label} | ${cols.map(p => (p.infeasible ? '*infeasible*' : get(T(p)))).join(' | ')} |`)
  row('Total attending h', x => f(x.structure.totalHours, 0))
  for (const a of AREAS) row(`${AREA_LABEL[a]} attending h`, x => f(x.structure.hoursByArea[a], 0))
  row('Hard-rule hours (Main 24/7 + ERU window)', x => f(hardHours(x), 0))
  row('Remaining flexible hours', x => f(flexHours(x), 0))
  row('**Modeled coverage, overall**', x => `**${pctS(x.metrics.all)}**`)
  for (const a of AREAS) row(`Coverage, ${AREA_LABEL[a]}`, x => pctS(x.metrics.byArea[a]))
  row('**Unmet patient-h, overall**', x => `**${f(x.metrics.all.deficit)}**`)
  for (const a of AREAS) row(`Unmet, ${AREA_LABEL[a]}`, x => f(x.metrics.byArea[a].deficit))
  row('Excess beyond tolerance (patient-h)', x => f(x.metrics.all.excess))
  row('ERU hours with dedicated attending', x => x.op.eru.hoursDedicated)
  row('ERU hours cross-covered by Main', x => x.op.eru.hoursCrossCovered)
  row('ERU unmet while cross-covered', x => f(x.op.eru.crossCovered.unmet))
  row('Solver (thorough)', x => gapFlag(x))
  L.push('')
  L.push(`Current schedule as recorded, scored with the same operational model: coverage ${pctS(r.currentScored.metrics.all)}, unmet ${f(r.currentScored.metrics.all.deficit)} patient-h`)
  L.push(`(Main ${f(r.currentScored.metrics.byArea.main.deficit)}, FastTrack ${f(r.currentScored.metrics.byArea.fasttrack.deficit)}, ERU ${f(r.currentScored.metrics.byArea.eru.deficit)}).`, '')

  // ── 6 ────────────────────────────────────────────────────────────────────
  L.push('## 6. Marginal opportunity-cost comparison', '')
  L.push('**MODEL OUTPUT** — each point vs **Current ERU coverage**, same 624 h. Negative unmet = fewer modeled unmet patient-hours.')
  L.push(`Differences within the search-noise band (±${f(noise)} patient-h, the largest standard-vs-thorough difference seen) are marked ~ and`)
  L.push('should be read as ties. ⚠ = large optimality gap: do not rank precisely.', '')
  L.push('| Point | ERU h | Δ ERU h | Δ Main h | Δ FastTrack h | Δ unmet overall | Δ Main | Δ FastTrack | Δ ERU | Δ coverage (pp) | Gap |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  const c0 = T(cur)
  for (const p of curve) {
    if (p.infeasible) { L.push(`| ${p.label} | — | infeasible with the shift menu | | | | | | | | |`); continue }
    const x = T(p)
    const d = get => get(x) - get(c0)
    const du = d(y => y.metrics.all.deficit)
    L.push(`| ${p.label}${MAIN_MARK(p)} | ${f(x.structure.hoursByArea.eru, 0)} | ${sgn(d(y => y.structure.hoursByArea.eru), 0)} | ${sgn(d(y => y.structure.hoursByArea.main), 0)} | ${sgn(d(y => y.structure.hoursByArea.fasttrack), 0)} | **${sgn(du)}**${p.key !== 'current' && Math.abs(du) <= noise ? ' ~' : ''} | ${sgn(d(y => y.metrics.byArea.main.deficit))} | ${sgn(d(y => y.metrics.byArea.fasttrack.deficit))} | ${sgn(d(y => y.metrics.byArea.eru.deficit))} | ${sgn(d(y => pct(y.metrics.all)), 1)} | ${f(x.solver.gap * 100, 1)}%${x.solver.gap > LARGE_GAP ? ' ⚠' : ''} |`)
  }
  L.push('')
  // Segment slopes between consecutive feasible points (ordered by ERU hours).
  const pts = curve.filter(p => !p.infeasible).sort((a, b) => T(a).structure.hoursByArea.eru - T(b).structure.hoursByArea.eru)
  L.push('**Marginal slope between consecutive windows** (thorough). Slope = Δ modeled unmet ÷ Δ dedicated ERU attending-hours.', '')
  L.push('| From → to | Δ ERU h | Δ unmet | Slope (patient-h per ERU h) | Hours came from / went to |', '|---|---|---|---|---|')
  for (let i = 1; i < pts.length; i++) {
    const a = T(pts[i - 1]), b = T(pts[i])
    const dh = b.structure.hoursByArea.eru - a.structure.hoursByArea.eru
    const du = b.metrics.all.deficit - a.metrics.all.deficit
    const moves = ['main', 'fasttrack'].map(x => `${AREA_LABEL[x]} ${sgn(b.structure.hoursByArea[x] - a.structure.hoursByArea[x], 0)}`).join(', ')
    L.push(`| ${pts[i - 1].label} → ${pts[i].label} | ${sgn(dh, 0)} | ${sgn(du)}${Math.abs(du) <= noise ? ' ~' : ''} | ${dh ? f(du / dh, 2) : '— (same hours, different timing)'} | ${moves} |`)
  }
  L.push('')
  const minPt = pts.reduce((m, p) => (T(p).metrics.all.deficit < T(m).metrics.all.deficit ? p : m), pts[0])
  L.push(`**Reading.** Under this model and the conservative cross-cover assumption the curve is not linear. Removing dedicated ERU hours`)
  L.push('entirely raises modeled unmet demand (with no cross-cover credit, uncovered ERU demand counts in full); across the short-to-medium')
  L.push(`windows the totals are close (lowest: "${minPt.label}", ${f(T(minPt).metrics.all.deficit)} patient-h, ${f(T(minPt).structure.hoursByArea.eru, 0)} ERU h); beyond that point each`)
  L.push('additional dedicated ERU hour displaces Main/FastTrack hours and modeled unmet rises, more steeply the further ERU extends overnight. The slope is a modeled throughput opportunity cost — the')
  L.push('throughput the same hours would add in Main/FastTrack under this model — not a "cost of ERU", and it says nothing about clinical')
  L.push('desirability (section 10). Thorough-search gaps are ~3–5%, so differences of a few patient-hours between neighbouring windows')
  L.push('are indicative only; the ~ marks the stricter observed standard-vs-thorough band.', '')

  // ── 7 ────────────────────────────────────────────────────────────────────
  L.push('## 7. Where attending-hours move', '')
  L.push('**MODEL OUTPUT** — attending-hours on duty per week by area and time band, change vs Current (thorough plans).', '')
  L.push(`| Point | ${AREAS.flatMap(a => BANDS.map(([b]) => `${AREA_LABEL[a]} ${b}`)).join(' | ')} |`)
  L.push(`|---|${AREAS.flatMap(() => BANDS.map(() => '---')).join('|')}|`)
  for (const p of curve) {
    if (p.infeasible) continue
    L.push(`| ${p.label} | ${AREAS.flatMap(a => BANDS.map(([, t]) => sgn(band(T(p), a, t) - band(c0, a, t), 0))).join(' | ')} |`)
  }
  L.push('')
  L.push(`Current plan (reference), attending-hours on duty: ${AREAS.map(a => `${AREA_LABEL[a]} ${BANDS.map(([b, t]) => `${b} ${f(band(c0, a, t), 0)}`).join(', ')}`).join(' · ')}.`, '')

  // ── 8 ────────────────────────────────────────────────────────────────────
  L.push('## 8. Worst remaining deficits', '')
  for (const p of feas) {
    L.push(`**${p.preset?.short ?? p.label}**`, '')
    L.push(...T(p).metrics.periods.slice(0, 4).map(x => `- ${periodText(x)}`), '')
  }

  // ── 9 ────────────────────────────────────────────────────────────────────
  L.push('## 9. Search sensitivity', '')
  L.push('Plans are "best found" within a deterministic search budget; "gap" bounds how far from the best possible they may be.', '')
  L.push('| Point | Standard: unmet · gap | Thorough: unmet · gap | Difference |', '|---|---|---|---|')
  for (const p of curve) {
    if (p.infeasible) continue
    L.push(`| ${p.label} | ${f(p.standard.metrics.all.deficit)} · ${f(p.standard.solver.gap * 100, 1)}% | ${f(p.thorough.metrics.all.deficit)} · ${f(p.thorough.solver.gap * 100, 1)}% | ${sgn(p.thorough.metrics.all.deficit - p.standard.metrics.all.deficit)} |`)
  }
  L.push('')
  L.push(`Search-noise band used above: ±${f(noise)} patient-h/week. Gaps above ${LARGE_GAP * 100}% are flagged ⚠. No plan here is proven optimal unless it says so.`, '')
  const pw = routing.planWithout
  L.push('**Staff-routing robustness.** Current ERU coverage re-solved WITHOUT the (confirmed) FastTrack→Main routing, to show how much it matters: ')
  L.push(pw.infeasible ? `infeasible — without routing, FastTrack's overnight residents would stay on FastTrack while it is closed, where no attending may supervise them (${String(pw.message ?? '').slice(0, 160)}…).` : `unmet ${f(pw.metrics.all.deficit)} vs ${f(c0.metrics.all.deficit)} with routing; Main/FastTrack/ERU hours ${AREAS.map(a => f(pw.structure.hoursByArea[a], 0)).join('/')} vs ${AREAS.map(a => f(c0.structure.hoursByArea[a], 0)).join('/')}.`)
  const uw = routing.currentWith, uo = routing.currentWithout
  const unsup = s => AREAS.reduce((t, a) => t + s.op[a].unsupervisedExtenderHours, 0)
  L.push(`On today's schedule the routing reclassifies unsupervised resident/PA area-hours from ${unsup(uo)} to ${unsup(uw)}`)
  L.push(`(${uo.op.fasttrack.unsupervisedExtenderHours} → ${uw.op.fasttrack.unsupervisedExtenderHours} in FastTrack); ${routing.unroutedWith.length} closed-area shifts remain unrouted.`, '')

  // ── 10 ───────────────────────────────────────────────────────────────────
  L.push('## 10. Limitations — what the model does NOT measure', '')
  L.push('- Modeled coverage is not observed throughput; modeled unmet patient-hours are not patient wait times or boarding.')
  L.push('- Acuity, resuscitation readiness and immediate attending availability in ERU are not quantified. ERU scenario comparisons do')
  L.push('  not determine the clinically correct coverage window.')
  L.push('- Resident/PA productivity and attending ceilings are assumptions, not measurements.')
  L.push(`- Demand target is ${r.target} historical roomed patients per hour; peaks above the mean are not represented.`)
  L.push('- Cross-cover throughput credit is conservative (none): outside its window ERU demand is counted unmet unless an ERU attending is on.')
  L.push('  cross-cover-sensitivity.md shows allocations with ERU windows held fixed are robust to this assumption.')
  L.push('- Staff routing of FastTrack overnight residents/APPs to Main is a confirmed operational rule (staff move; patient demand does not).')
  L.push('- Day templates are circular (an overnight window wraps into the same weekday); no handoffs, fatigue or unit geography.', '')
  return L.join('\n')
}

const MAIN_MARK = p => (['current', 'coreDaytime', 'extendedEvening', 'allDay'].includes(p.key) ? ' ★' : '')
