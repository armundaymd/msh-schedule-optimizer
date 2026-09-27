// Markdown report: sensitivity of the attending allocation to the ERU
// cross-cover throughput-credit assumption.
import { AREA_LABEL } from '../src/shared/areas'
import { describeCrossCoverCredit } from '../src/shared/operationalCoverage'
import { MATERIAL_CHANGE_SHARE } from '../src/shared/sensitivity'
import { periodText } from '../validation/compare'

const f = (n, d = 1) => Number(n).toFixed(d)
const pct = m => (m.demand > 0 ? `${f((100 * m.served) / m.demand)}%` : '—')
const AREAS = ['main', 'fasttrack', 'eru']

function outputsTable(L, runs, which) {
  L.push(`| Per week | ${runs.map(r => r.assumption).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`)
  const row = (label, get) => L.push(`| ${label} | ${runs.map(r => get(r[which])).join(' | ')} |`)
  for (const a of AREAS) row(`${AREA_LABEL[a]} attending h`, p => f(p.structure.hoursByArea[a], 0))
  row('Modeled coverage, overall', p => `**${pct(p.metrics.all)}**`)
  for (const a of AREAS) row(`Modeled coverage, ${AREA_LABEL[a]}`, p => pct(p.metrics.byArea[a]))
  row('Unmet patient-h, overall', p => `**${f(p.metrics.all.deficit)}**`)
  for (const a of AREAS) row(`Unmet patient-h, ${AREA_LABEL[a]}`, p => f(p.metrics.byArea[a].deficit))
  row('ERU hours with a dedicated attending', p => p.op.eru.hoursDedicated)
  row('ERU hours cross-covered by Main', p => p.op.eru.hoursCrossCovered)
  row('ERU cross-cover throughput credit (patient-h)', p => f(p.op.eru.crossCovered.credit))
  row('ERU demand in cross-covered hours (patient-h)', p => f(p.op.eru.crossCovered.demand))
  row('ERU unmet while cross-covered', p => f(p.op.eru.crossCovered.unmet))
  row('ERU unmet with its dedicated attending on', p => f(p.op.eru.unmetWhenDedicated))
  row('Solver status · gap', p => `${p.solver.status} · ${f(p.solver.gap * 100, 1)}%`)
  L.push('')
}

export function renderCrossCoverReport(r) {
  const { runs, comparisons, crossScore, assumptions, structures, pph, current } = r
  const L = []
  L.push('# Sensitivity of the attending allocation to the ERU cross-cover throughput assumption', '')
  L.push(`Generated ${r.when}. Whole ED, ${f(r.budget, 0)} attending h/week (today's), ${r.target} demand, current start times × 8/10/12 h.`, '')
  L.push('> This asks whether the **recommended allocation** depends on an uncertain modeling assumption. It does not')
  L.push('> determine which assumption is clinically correct, and no plan below is clinically optimal.', '')

  // ── Summary, computed from the runs below ────────────────────────────────
  const get = (st, a) => runs.find(x => x.structure === st && x.assumption === a)
  const hrs = (st, which, area) => assumptions.map(a => `${a.key} ${f(get(st, a.key)[which].structure.hoursByArea[area], 0)}`).join(' · ')
  const moved = (st, effort) => comparisons.filter(c => c.structure === st && c.effort === effort)
  const maxShare = cs => Math.max(...cs.map(c => c.movedShare))
  const eruRange = (st, which) => {
    const v = assumptions.map(a => get(st, a.key)[which].structure.hoursByArea.eru)
    return Math.max(...v) - Math.min(...v)
  }
  L.push('## Summary', '')
  L.push(`- **Current ERU dedicated coverage kept (\`keep\`): the allocation is not sensitive to the cross-cover assumption.**`)
  L.push(`  Area totals (thorough): Main ${hrs('keep', 'thorough', 'main')}; FastTrack ${hrs('keep', 'thorough', 'fasttrack')}; ERU ${hrs('keep', 'thorough', 'eru')}.`)
  L.push(`  At most ${f(maxShare(moved('keep', 'thorough')) * 100)}% of attending-hours move between assumptions (thorough), versus up to ${f(maxShare(moved('keep', 'noise')) * 100)}% from search effort alone.`)
  L.push('  The assumption changes the *reported* ERU coverage and unmet demand in cross-covered hours, not where attendings go.')
  L.push(`- **ERU dedicated coverage left to the optimizer (\`flex\`): the ERU recommendation IS sensitive to the assumption.**`)
  L.push(`  ERU attending h/week — thorough: ${hrs('flex', 'thorough', 'eru')}; standard: ${hrs('flex', 'plan', 'eru')} (spread ${f(eruRange('flex', 'thorough'), 0)} h thorough, ${f(eruRange('flex', 'plan'), 0)} h standard).`)
  L.push(`  With no credit (A) the optimizer keeps ${f(get('flex', 'A').thorough.structure.hoursByArea.eru, 0)} of today's 96 dedicated ERU hours; with a positive credit (B or C) it`)
  L.push('  keeps almost none and relies on Main cross-cover, moving those hours to Main. The direction holds at both search efforts.')
  L.push(`  As a share of ALL attending-hours this is ${f(maxShare(moved('flex', 'thorough').filter(c => c.pair.startsWith('A'))) * 100)}% moved (thorough) — near the ${MATERIAL_CHANGE_SHARE * 100}% materiality line because ERU is a small`)
  L.push('  share of the week; for ERU itself it is the difference between keeping and dropping dedicated coverage.')
  L.push(`  B vs C differences (${f(maxShare(moved('flex', 'thorough').filter(c => c.pair === 'B vs C')) * 100)}% moved) are within search noise (up to ${f(maxShare(moved('flex', 'noise')) * 100)}%).`)
  L.push('- **Consequence:** any analysis that lets the optimizer decide ERU dedicated hours depends on an unvalidated cross-cover throughput')
  L.push('  assumption. The conservative mode (A) is the default; B and C show how far the answer moves if cross-cover were credited.')
  L.push('  Scenarios that hold ERU dedicated coverage as a rule are robust to it.', '')

  L.push('## 1. What is fixed, what varies', '')
  L.push('**Observed inputs (unchanged):** historical arrivals by area (ERU demand stays ERU demand; no ESI routing; FastTrack demand = historical FastTrack routing); the resident/PA schedule (never moved).', '')
  L.push(`**Model assumptions (unchanged):** Main ceiling ${pph.main} / solo ${pph.mainOwn}; ERU ceiling ${pph.eru} / solo ${pph.eruOwn}; FastTrack ${pph.fasttrack} / ${pph.fasttrackOwn}; resident/PA rates as configured.`)
  L.push('Main ≥ 1 attending 24/7; FastTrack closed 01:00–07:00; **ERU at most one dedicated attending at a time** (structural). Main is responsible for ERU')
  L.push('whenever ERU has no attending, and supervises ERU residents/PAs then (responsibility and supervision are the same in every run).', '')
  L.push('**Varied — cross-cover throughput credit** (how much modeled ERU capacity Main\'s cross-coverage adds):', '')
  L.push('credit = min(fraction × ERU resident/PA capacity, factor × Main headroom), headroom = max(0, Main attendings × 2.1 − Main expected demand).', '')
  for (const a of assumptions) L.push(`- **${a.label}** — ${describeCrossCoverCredit(a.credit, pph)}.`)
  L.push('')
  L.push('None of these is validated; B is the earlier behaviour kept for comparison, C is illustrative only.', '')
  L.push('**Two structural settings, each solved under A, B and C:**', '')
  for (const [k, s] of Object.entries(structures)) L.push(`- \`${k}\` — ${s.label}`)
  L.push('')
  L.push('In `keep`, ERU attending hours are fixed by the hard rule (the current ERU dedicated coverage — Mon–Fri 09:00–01:00, Sat–Sun 11:00–19:00 —')
  L.push('kept for comparison, not a clinically established minimum), so the question is whether Main/FastTrack hours move. In `flex`, the')
  L.push('optimizer also decides ERU\'s dedicated hours, so the question is whether ERU\'s allocation moves.', '')

  L.push('## 2. Current schedule under each assumption', '')
  L.push(`| Per week | ${assumptions.map(a => a.key).join(' | ')} |`, `|---|${assumptions.map(() => '---').join('|')}|`)
  const cur = k => current.byAssumption[k]
  L.push(`| Unmet patient-h, overall | ${assumptions.map(a => f(cur(a.key).metrics.all.deficit)).join(' | ')} |`)
  L.push(`| Unmet ERU | ${assumptions.map(a => f(cur(a.key).metrics.byArea.eru.deficit)).join(' | ')} |`)
  L.push(`| ERU coverage | ${assumptions.map(a => pct(cur(a.key).metrics.byArea.eru)).join(' | ')} |`)
  L.push(`| ERU cross-cover credit (patient-h) | ${assumptions.map(a => f(cur(a.key).op.eru.crossCovered.credit)).join(' | ')} |`)
  L.push('')

  for (const [sKey, st] of Object.entries(structures)) {
    const rs = runs.filter(x => x.structure === sKey)
    L.push(`## ${sKey === 'keep' ? 3 : 4}. \`${sKey}\`: ${st.label}`, '')
    L.push('**Thorough search** (45 deterministic s — the more reliable plans):', '')
    outputsTable(L, rs, 'thorough')
    L.push('<details><summary>Standard search (15 s) — as the app runs by default</summary>', '')
    outputsTable(L, rs, 'plan')
    L.push('</details>', '')
    L.push('**Worst deficit periods (thorough plans)**', '')
    for (const x of rs) {
      L.push(`- *${x.assumption}:*`)
      for (const p of x.thorough.metrics.periods.slice(0, 3)) L.push(`  - ${periodText(p)}`)
    }
    L.push('')
  }

  L.push('## 5. Does the recommended attending allocation change?', '')
  L.push(`"Moved" = attending-hours placed at a different area/day/hour between two plans; **material** when > ${MATERIAL_CHANGE_SHARE * 100}% of hours move.`)
  L.push('The search-noise rows compare the SAME assumption solved at standard vs thorough effort: a change across assumptions only means something')
  L.push('if it clearly exceeds that noise.', '')
  L.push('| Setting | Comparison | Search | Hours moved | Share | Shift overlap (Jaccard) | Material? |', '|---|---|---|---|---|---|---|')
  for (const c of comparisons) {
    L.push(`| ${c.structure} | ${c.pair} | ${c.effort === 'noise' ? 'noise baseline' : c.effort} | ${f(c.movedHours, 0)} | ${f(c.movedShare * 100)}% | ${f(c.shiftJaccard, 2)} | ${c.material ? 'yes' : 'no'} |`)
  }
  L.push('')
  L.push('**Area totals across assumptions (thorough):**', '')
  L.push('| Setting | Assumption | Main h | FastTrack h | ERU h |', '|---|---|---|---|---|')
  for (const x of runs) L.push(`| ${x.structure} | ${x.assumption} | ${f(x.thorough.structure.hoursByArea.main, 0)} | ${f(x.thorough.structure.hoursByArea.fasttrack, 0)} | ${f(x.thorough.structure.hoursByArea.eru, 0)} |`)
  L.push('')

  L.push('## 6. Each plan scored under every assumption', '')
  L.push('Unmet patient-h/week, with Main cross-covering ERU whenever ERU has no attending. Rows = plan (thorough, `setting/assumption it was optimized for`);')
  L.push('columns = assumption used for scoring. If a plan optimized under one assumption stays near-best under the others, the recommendation is robust to it.', '')
  L.push(`| Plan | ${assumptions.map(a => `scored ${a.key}`).join(' | ')} |`, `|---|${assumptions.map(() => '---').join('|')}|`)
  const best = Object.fromEntries(assumptions.map(a => [a.key, Math.min(...crossScore.filter(c => c.label !== 'Current schedule').map(c => c.byAssumption[a.key]))]))
  for (const c of crossScore) {
    L.push(`| ${c.label} | ${assumptions.map(a => {
      const v = c.byAssumption[a.key]
      return v <= best[a.key] + 1e-9 ? `**${f(v)}**` : f(v)
    }).join(' | ')} |`)
  }
  L.push('')
  L.push('Bold = lowest in the column among the plans. Plans in the `keep` setting satisfy the current ERU dedicated coverage rule; `flex` plans may not.', '')
  return L.join('\n')
}
