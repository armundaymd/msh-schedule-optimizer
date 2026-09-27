// Current-vs-generated comparison under ONE set of demand assumptions.
//
// Reports the same metrics for every schedule so a human can judge whether
// the optimiser's objective lines up with an operationally sensible ED
// schedule. It deliberately makes no "better/worse" verdict: a lower
// deficit under this model is not evidence of clinical superiority.

import { AREA_LABEL, SCOPE_LABEL } from '../src/shared/areas'
import { shiftCoversHour, teamArea } from '../src/shared/capacity'
import { formatHour, formatRange, groupRuns } from '../src/shared/coverageInsights'
import { analyzeWeek } from '../src/shared/weekCoverage'
import { excessTolerance } from './invariants'

const f = (n, d = 1) => Number(n).toFixed(d)

// schedule: { label, shiftsForDay, customTeams, generatedByDay? }
// `coverage` (optional operational coverage config): score cross-covered
// hours with cross-coverage credit, as the staffing planner does.
export function scheduleMetrics({ days, demand, pph, scope, target, coverage = null }, schedule) {
  const week = analyzeWeek({ days, shiftsForDay: schedule.shiftsForDay, demand, pph, customTeams: schedule.customTeams, scope, target, coverage })
  const blank = () => ({ attendingHours: 0, demand: 0, served: 0, deficit: 0, deficitHours: 0, surplus: 0, excess: 0, excessHours: 0 })
  const byArea = Object.fromEntries(week.areas.map(a => [a, blank()]))
  const periods = []
  week.days.forEach(({ day, analysis }) => {
    for (const s of schedule.shiftsForDay(day)) {
      const a = teamArea(s.team, schedule.customTeams)
      if (s.role_type === 'Attending' && byArea[a]) byArea[a].attendingHours += (s.endMins - s.startMins) / 60
    }
    for (const area of week.areas) {
      const m = byArea[area]
      const row = h => analysis.hours[h].byArea[area]
      for (let h = 0; h < 24; h++) {
        const { demand: d, capacity: c } = row(h)
        m.demand += d; m.served += Math.min(d, c)
        if (d > c) { m.deficit += d - c; m.deficitHours++ }
        m.surplus += Math.max(0, c - d)
        const ex = Math.max(0, c - d - excessTolerance(d))
        if (ex > 0) { m.excess += ex; m.excessHours++ }
      }
      for (const run of groupRuns(h => (row(h).demand > row(h).capacity ? 'short' : null))) {
        const total = run.hours.reduce((t, h) => t + row(h).demand - row(h).capacity, 0)
        const peakHour = run.hours.reduce((b, h) => (row(h).demand - row(h).capacity > row(b).demand - row(b).capacity ? h : b), run.hours[0])
        periods.push({ area, day, hours: run.hours, total, peakHour, peak: row(peakHour).demand - row(peakHour).capacity })
      }
    }
  })
  const all = Object.values(byArea).reduce((t, m) => {
    for (const k of Object.keys(t)) t[k] += m[k]
    return t
  }, blank())
  periods.sort((a, b) => b.total - a.total)
  return { label: schedule.label, byArea, all, worst: periods.slice(0, 3), periods, week, generatedByDay: schedule.generatedByDay ?? null, note: schedule.note }
}

export function periodText(p) {
  return `${AREA_LABEL[p.area]} ${p.day} ${formatRange(p.hours)} (${p.hours.length} h): ${f(p.total)} patient-hours short (worst −${f(p.peak, 2)}/hr at ${formatHour(p.peakHour)})`
}

function shiftsByDay(byDay, days) {
  return days.map(d => {
    const byTeam = {}
    for (const s of byDay[d]) (byTeam[s.team] ??= []).push(`${s.start_time}-${s.end_time}`)
    return `- ${d.slice(0, 3)}: ${Object.entries(byTeam).map(([t, x]) => `${t} ${x.join(', ')}`).join(' · ') || '—'}`
  }).join('\n')
}

export function renderComparison(ctx, results, meta) {
  const areas = Object.keys(results[0].byArea)
  const pct = m => (m.demand > 0 ? `${f((100 * m.served) / m.demand)}%` : '—')
  const lines = [
    `# Current vs generated schedules — ${SCOPE_LABEL[ctx.scope]}, ${ctx.target} demand`,
    '',
    `Generated ${meta.when}. Data: ${meta.source}. PPH: app defaults.`,
    '',
    '> **Read this as input to human review, not as a verdict.** Every schedule is measured with the same demand',
    '> and the same capacity model. A generated schedule scoring better here means it fits *this model* better — not',
    '> that it is clinically better. Check the worst periods, the per-area hours and the actual shifts for things the',
    '> model cannot see: handoffs, fatigue, skill mix, unit geography, and whether an area can safely go without an attending.',
    '',
    '## Summary (per week; deficits summed per area, never pooled)',
    '',
    `| Metric | ${results.map(r => r.label).join(' | ')} |`,
    `|---|${results.map(() => '---').join('|')}|`,
    `| Attending hours | ${results.map(r => f(r.all.attendingHours)).join(' | ')} |`,
    `| Demand coverage (served / demand) | ${results.map(r => pct(r.all)).join(' | ')} |`,
    `| Short area-hours | ${results.map(r => r.all.deficitHours).join(' | ')} |`,
    `| Unmet demand (patient-hours) | ${results.map(r => f(r.all.deficit)).join(' | ')} |`,
    `| Surplus capacity (patient-hours) | ${results.map(r => f(r.all.surplus)).join(' | ')} |`,
    `| Excess beyond tolerance (patient-hours) | ${results.map(r => f(r.all.excess)).join(' | ')} |`,
    '',
    '## By area',
    '',
    `| Area · metric | ${results.map(r => r.label).join(' | ')} |`,
    `|---|${results.map(() => '---').join('|')}|`,
  ]
  for (const a of areas) {
    lines.push(`| **${AREA_LABEL[a]}** attending h | ${results.map(r => f(r.byArea[a].attendingHours)).join(' | ')} |`)
    lines.push(`| ${AREA_LABEL[a]} coverage | ${results.map(r => pct(r.byArea[a])).join(' | ')} |`)
    lines.push(`| ${AREA_LABEL[a]} unmet (short hours) | ${results.map(r => `${f(r.byArea[a].deficit)} (${r.byArea[a].deficitHours})`).join(' | ')} |`)
    lines.push(`| ${AREA_LABEL[a]} excess beyond tolerance | ${results.map(r => f(r.byArea[a].excess)).join(' | ')} |`)
  }
  lines.push('')
  for (const r of results) {
    lines.push(`## ${r.label}`, '')
    if (r.note) lines.push(r.note, '')
    lines.push('**Worst deficit periods**', '')
    lines.push(...(r.worst.length ? r.worst.map(p => `- ${periodText(p)}`) : ['- none']), '')
    if (r.generatedByDay) lines.push('**Generated / recommended attending shifts**', '', shiftsByDay(r.generatedByDay, ctx.days), '')
  }
  return lines.join('\n')
}

// Hours each schedule has at least one attending on, per area — a quick
// operational sanity number for reviewers (e.g. "ERU unattended 60 h/week").
export function unattendedHours(ctx, schedule) {
  const out = {}
  for (const day of ctx.days) {
    const shifts = schedule.shiftsForDay(day).filter(s => s.role_type === 'Attending')
    for (const area of Object.keys(AREA_LABEL)) {
      for (let h = 0; h < 24; h++) {
        if (!shifts.some(s => teamArea(s.team, schedule.customTeams) === area && shiftCoversHour(s, h))) out[area] = (out[area] ?? 0) + 1
      }
    }
  }
  return out
}
