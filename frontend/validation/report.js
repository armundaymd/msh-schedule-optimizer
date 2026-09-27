// Human-readable Markdown report for the validation suite.

import { AREA_LABEL, SCOPE_LABEL, scopeAreas } from '../src/shared/areas'

const f = (n, d = 2) => Number(n).toFixed(d)
const hh = h => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`
const ICON = { PASS: '✅', FAIL: '❌', LIMITATION: '⚠️', SUBOPTIMAL: '🔸', 'N/A': '➖', SKIPPED: '⏭️' }

// Runs of consecutive hours with the same values: "08:00-16:00 d 2.00 / cap 2.00".
function hourlyRuns(values, fmt, isZero) {
  const runs = []
  for (let h = 0; h < 24; h++) {
    const label = fmt(values[h])
    const last = runs.at(-1)
    if (last && last.label === label && last.end === h) last.end = h + 1
    else runs.push({ start: h, end: h + 1, label, zero: isZero(values[h]) })
  }
  const shown = runs.filter(r => !r.zero)
  if (!shown.length) return 'zero all day'
  return shown.map(r => `${hh(r.start)}-${hh(r.end)} ${r.label}`).join(' · ') + (shown.length < runs.length ? ' · (zero elsewhere)' : '')
}

function describeInput(sc) {
  const lines = []
  lines.push(`- **Scope:** ${SCOPE_LABEL[sc.scope]} · **Days:** ${sc.days.join(', ')}`)
  for (const a of scopeAreas(sc.scope)) {
    lines.push(`- **${AREA_LABEL[a]} demand (patients/hr):** ${hourlyRuns(sc.demandSeries[a], v => f(v), v => v === 0)}`)
  }
  const cur = sc.currentFor(sc.days[0])
  lines.push(`- **Existing shifts:** ${cur.length ? cur.map(s => `${s.team} ${s.role_type}${s.resident_level ? ` (${s.resident_level})` : ''} ${s.start_time}-${s.end_time}`).join('; ') : 'none'}`)
  const lens = [...new Set(sc.patterns.map(p => p.length))].join('/')
  const starts = [...new Set(sc.patterns.map(p => p.start))]
  lines.push(`- **Allowed shifts:** ${sc.patterns.length} patterns — ${lens} h, starting ${starts.length === 24 ? 'any hour' : starts.map(hh).join(', ')}`)
  lines.push(`- **Budget:** ${sc.budget == null ? 'unlimited' : `${sc.budget} h`}${sc.generator?.hourBudget != null ? ` (generator hourBudget ${sc.generator.hourBudget} h)` : ''}`)
  if (sc.lockRules.length) lines.push(`- **Locks:** ${sc.lockRules.map(r => `${AREA_LABEL[r.area]} shifts starting ${hh(r.fromHour)}-${hh(r.toHour)}${r.fromHour === r.toHour ? ' (all day)' : ''}`).join('; ')}`)
  if (sc.minRules.length) lines.push(`- **Minimum coverage:** ${sc.minRules.map(r => `${AREA_LABEL[r.area]} >= ${r.min} attending ${r.fromHour === r.toHour ? 'all day' : `${hh(r.fromHour)}-${hh(r.toHour)}`}`).join('; ')}`)
  lines.push(`- **PPH:** ${Object.entries(sc.pph).filter(([k]) => scopeAreas(sc.scope).some(a => k.startsWith(a)) || ['pa', 'pgy2', 'pgy4'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  return lines.join('\n')
}

function engineSection(r) {
  const out = [`#### ${r.engine === 'generator' ? 'Generator' : 'Resource allocator'} — ${ICON[r.outcome]} ${r.outcome}`]
  if (r.outcome === 'N/A' || r.outcome === 'SKIPPED') {
    out.push(`- **Reason:** ${r.reason}`)
    return out.join('\n')
  }
  if (r.noSchedule) {
    out.push(`- **Solver status:** ${r.status} — ${r.message}`)
  } else {
    const t = r.metrics
    out.push(`- **Generated shifts:** ${r.shifts || 'none'}`)
    out.push(`- **Total hours:** ${f(r.hours, 1)} h generated${r.lockedHours ? ` + ${f(r.lockedHours, 1)} h locked` : ''}${r.budget != null ? ` (budget ${f(r.budget, 1)} h)` : ''}`)
    out.push(`- **Coverage:** ${f(t.served, 1)} of ${f(t.demand, 1)} patient-hours served (${f(t.coveragePct, 1)}%)`)
    for (const [area, days] of Object.entries(r.measured)) {
      out.push(`  - ${AREA_LABEL[area]}: ${hourlyRuns(days[0].map(x => x), x => `d ${f(x.d)} / cap ${f(x.cap)}`, x => x.d === 0 && x.cap === 0)}`)
    }
    out.push(`- **Deficit:** ${f(t.deficit)} patient-hours unmet over ${t.deficitHours} area-hour(s)${t.worst ? `; worst ${AREA_LABEL[t.worst.area]} ${hh(t.worst.hour)} (−${f(t.worst.deficit)}/hr)` : ''}`)
    out.push(`- **Excess:** ${f(t.surplus)} patient-hours of surplus capacity; ${f(t.excess)} beyond the excess tolerance over ${t.excessHours} area-hour(s)`)
  }
  out.push(`- **Result:** ${ICON[r.outcome]} ${r.outcome}`)
  out.push(`- **Reason:** ${r.reason}`)
  out.push('')
  out.push('<details><summary>All checks</summary>\n')
  for (const c of r.checks) {
    const mark = c.pass === true ? '✓' : c.pass === false ? '✗' : 'ℹ'
    out.push(`- ${mark} ${c.level ? `[${c.level}] ` : `[${c.group}] `}${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  out.push('\n</details>')
  return out.join('\n')
}

export function renderReport(results, meta) {
  const engines = ['generator', 'allocator']
  const lines = [
    '# Schedule generator & resource allocator — validation report',
    '',
    `Generated ${meta.when} · ${results.length} scenarios · solver: ${meta.solver}`,
    '',
    'Outcomes: ✅ PASS (all invariants and expectations hold) · ❌ FAIL (an invariant or operational requirement is violated) ·',
    '⚠️ LIMITATION (invariants hold; the engine diverges from the expected behaviour for a documented modelling reason) ·',
    '🔸 SUBOPTIMAL (invariants and requirements hold; a better schedule exists) · ➖ N/A (feature not supported by that engine).',
    '',
    'Every generated schedule is checked for: total hours, allowed lengths, allowed (start, length) patterns, start/end',
    'arithmetic, overnight coverage (against an independent minute walk), app capacity vs an independent capacity oracle,',
    'deficit and excess arithmetic, supervision limits, one-attending-per-team, locked-shift preservation, untouched',
    'out-of-scope shifts, budget compliance, and demand conservation (served + unmet = demand).',
    '',
    '| Scenario | Generator | Allocator |',
    '|---|---|---|',
    ...results.map(r => `| ${r.sc.id} ${r.sc.title} | ${engines.map(e => `${ICON[r.byEngine[e].outcome]} ${r.byEngine[e].outcome}`).join(' | ')} |`),
    '',
  ]
  for (const r of results) {
    lines.push(`## ${r.sc.id} — ${r.sc.title}`, '', '**Input**', '', describeInput(r.sc), '', `**Expected behaviour:** ${r.sc.expected}`, '')
    for (const e of engines) lines.push(engineSection(r.byEngine[e]), '')
  }
  return lines.join('\n')
}
