// Unsupervised resident/APP audit: every interval where the Staffing
// Planner's default Whole-ED plan leaves residents/PAs on a team with no
// attending (so their modeled capacity is zero), plus every area-hour with
// expected demand and no attending at all.
//   npx vitest run --config vitest.analysis.config.js analysis/unsupervisedStaffAudit
// Writes analysis/reports/unsupervised-staff-audit.md (+ .json).
//
// It reproduces the planner exactly as the v3 UI runs it with its defaults
// (fixed attending hours = today's, Whole ED, mean demand, current start
// times x 8/10/12 h, default operational coverage, standard search), on the
// same data the UI shows: the local API's schedule and demand (AUDIT_API,
// default http://localhost:8000), falling back to the committed snapshot.
// It changes nothing: no constraint is added, no plan is applied. It does
// NOT judge whether an interval is clinically acceptable.
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AREAS, AREA_LABEL } from '../src/shared/areas'
import { attendingCountForTeam, extenderCapacityForTeam, shiftCoversHour, teamArea } from '../src/shared/capacity'
import {
  COVERAGE_MODE, DEFAULT_OPERATIONAL_COVERAGE, areaMaxAttendings, attendingsInArea, cloneCoverageConfig, effectiveShifts,
  resolveCoverage,
} from '../src/shared/operationalCoverage'
import { DEFAULT_PPH } from '../src/shared/pph'
import { DEFAULT_MAX_FLEX, DEFAULT_MAX_PER_TEAM, UNATTENDED_DEMAND_PPH, schedulePlanMetrics } from '../src/shared/staffingPlan'
import { DEFAULT_PLANNER_INPUTS, planAndScore } from '../src/shared/attendingPlanner'
import { hourlyPatterns } from '../src/shared/bottlenecks'
import { analyzeScope } from '../src/shared/scopeAnalysis'
import { normalizeShifts } from '../src/shared/hooks/useScheduleState'
import { solverStatus } from '../src/shared/solverStatus'
import { planPatterns } from '../src/v3/utils/patterns'
import { loadCurrentSchedule, loadDemand } from './realData'
import { solveInstance, solverAvailable } from './solver'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'reports', 'unsupervised-staff-audit')
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const API = process.env.AUDIT_API ?? 'http://localhost:8000'
const SCOPE = 'wholeEd'
const TARGET = 'mean'
const PPH = DEFAULT_PPH
const EXT = s => s.role_type === 'Resident' || s.role_type === 'PA'
const solver = solverAvailable()

const f = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const hh = h => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`
const t = m => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

async function loadInputs() {
  try {
    const get = async p => { const r = await fetch(`${API}${p}`); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json() }
    const [schedule, demand, summary] = await Promise.all([get('/api/schedule'), get('/api/demand'), get('/api/summary')])
    return { source: `local API ${API} (the local Postgres the v3 UI reads): ${summary.total_encounters?.toLocaleString()} encounters, ${summary.date_range}`, shifts: normalizeShifts(schedule), demand }
  } catch (e) {
    return { source: `committed snapshot (API unavailable: ${e.message}) — data/Current_Schedule_Block.csv + data/processed/demand.json`, shifts: loadCurrentSchedule(), demand: loadDemand() }
  }
}

// Consecutive hours (same day) sharing a key → intervals.
function intervals(items, keyOf) {
  const sorted = [...items].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || keyOf(a).localeCompare(keyOf(b)) || a.hour - b.hour)
  const out = []
  for (const it of sorted) {
    const last = out.at(-1)
    if (last && last.day === it.day && last.key === keyOf(it) && last.hours.at(-1) === it.hour - 1) { last.hours.push(it.hour); last.items.push(it) }
    else out.push({ day: it.day, key: keyOf(it), hours: [it.hour], items: [it] })
  }
  return out
}

describe('Unsupervised resident/APP audit (Staffing Planner default Whole-ED plan)', () => {
  it.skipIf(!solver.ok)('writes the report', async () => {
    const { source, shifts, demand } = await loadInputs()
    const currentFor = d => shifts.filter(s => s.day === d)
    const coverage = cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE)
    const patterns = planPatterns('current', [8, 10, 12])
    const weekly = shifts.filter(s => s.role_type === 'Attending').reduce((x, s) => x + (s.endMins - s.startMins) / 60, 0)
    const common = {
      days: DAYS, shiftsForDay: currentFor, customTeams: [], pph: PPH, demand, target: TARGET, scope: SCOPE, patterns, coverage,
      lockRules: [], minCoverageRules: [], maxAttendingsByArea: areaMaxAttendings(coverage), maxFlex: DEFAULT_MAX_FLEX,
      effort: 'standard', allowedDeficitPph: 0, expandedPatterns: hourlyPatterns(patterns), solve: inst => solveInstance(inst),
    }
    const plan = await planAndScore({ ...common, inputs: { ...DEFAULT_PLANNER_INPUTS, planningMode: 'budget' }, weeklyBudgetHours: weekly, hint: [] })
    expect(plan.ok).toBe(true)
    const before = schedulePlanMetrics({ days: DAYS, shiftsForDay: currentFor, customTeams: [], demand, pph: PPH, scope: SCOPE, target: TARGET, coverage })
    const after = plan.after
    const teams = plan.newTeams
    const proposedFor = plan.proposedFor

    // Going rate: modeled unmet reduction from 8 more budgeted hours, placed by the solver.
    const plus8 = await planAndScore({ ...common, inputs: { ...DEFAULT_PLANNER_INPUTS, planningMode: 'budget' }, weeklyBudgetHours: weekly + 8, hint: plan.result.shifts })
    const goingRate = plus8.ok ? (plan.summary.all.unmet - plus8.summary.all.unmet) / 8 : null

    const dayUnmet = (day, list, tms) => {
      const a = analyzeScope({ shifts: list, demand, pph: PPH, customTeams: tms, scope: SCOPE, day, target: TARGET, coverage })
      return a.hours.reduce((x, r) => x + Object.values(r.byArea).reduce((y, v) => y + Math.max(0, v.demand - v.capacity), 0), 0)
    }
    // Value of every attending shift the plan kept: unmet increase if removed.
    const kept = []
    for (const day of DAYS) {
      const list = proposedFor(day)
      const base = dayUnmet(day, list, teams)
      for (const s of list.filter(x => x.role_type === 'Attending')) {
        const len = (s.endMins - s.startMins) / 60
        kept.push({ day, team: s.team, start: s.startMins, end: s.endMins, len, value: dayUnmet(day, list.filter(x => x !== s), teams) - base })
      }
    }
    kept.forEach(k => { k.perHour = k.value / k.len })
    const keptSorted = [...kept].sort((a, b) => a.perHour - b.perHour)
    const minKeptPerHour = keptSorted[0]?.perHour ?? null
    const medianKeptPerHour = keptSorted[Math.floor(keptSorted.length / 2)]?.perHour ?? null

    // ── Unsupervised area-hours (the planner's own definition) ───────────────
    function unsupervised(week, shiftsForDay, tms) {
      const items = []
      week.days.forEach(({ day, analysis }) => {
        const all = shiftsForDay(day)
        for (let h = 0; h < 24; h++) {
          const on = effectiveShifts(all, coverage, day, h)
          for (const area of week.areas) {
            const row = analysis.hours[h].byArea[area]
            if (!(row.coverage?.unsupervisedExtender > 0)) continue
            const tset = new Set(on.filter(s => EXT(s) && shiftCoversHour(s, h) && teamArea(s.team, tms) === area).map(s => s.team))
            for (const team of tset) {
              if (attendingCountForTeam(on, team, h) > 0) continue
              const staff = on.filter(s => EXT(s) && s.team === team && shiftCoversHour(s, h))
              items.push({ day, hour: h, area, team, staff, hasResident: staff.some(s => s.role_type === 'Resident'), demand: row.demand, capacity: row.capacity,
                unmet: Math.max(0, row.demand - row.capacity), mode: row.coverage.mode, areaAttendings: row.coverage.ownAttendings,
                idle: extenderCapacityForTeam(on, PPH, area, team, h) })
            }
          }
        }
      })
      return items
    }
    const proposedItems = unsupervised(after.week, proposedFor, teams)
    const baselineItems = unsupervised(before.week, currentFor, [])
    // INVARIANT (resident supervision is a hard rule): no resident may be left
    // on a team with no attending in a Staffing Planner solution.
    const residentItems = proposedItems.filter(i => i.hasResident)
    expect(residentItems).toEqual([])
    const baselineKey = new Set(baselineItems.map(i => `${i.day}|${i.hour}|${i.area}|${i.team}`))

    const maxPerArea = areaMaxAttendings(coverage)
    const rows = intervals(proposedItems, i => `${i.area}|${i.team}|${i.hasResident ? 'R' : 'P'}`).map(iv => {
      const [area, team, who] = iv.key.split('|')
      const day = iv.day
      const hours = iv.hours
      const staffById = new Map()
      for (const it of iv.items) for (const s of it.staff) staffById.set(s.id, s)
      const staff = [...staffById.values()].map(s => ({
        role: s.role_type, detail: s.role_detail, level: s.resident_level, recordedTeam: s.sourceTeam ?? s.team,
        time: `${t(s.startMins)}–${t(s.endMins)}`, routed: !!s.sourceTeam,
      }))
      const baseOn = h => effectiveShifts(currentFor(day), coverage, day, h)
      const baselineTeamAtt = hours.map(h => attendingCountForTeam(baseOn(h), team, h))
      const baselineAreaAtt = hours.map(h => attendingsInArea(currentFor(day), [], area, h))
      const modes = [...new Set(hours.map(h => resolveCoverage(coverage, area, day, h).mode))]
      const alsoBaseline = hours.filter(h => baselineKey.has(`${day}|${h}|${area}|${team}`)).length

      // Ways to put an attending on this team for the whole interval, using
      // only menu shifts and the planner's own limits (area rules, area max,
      // one attending at a time per existing team):
      //   add    — a new menu shift on the team (extra attending-hours);
      //   retime — replace one of the team's planned attending shifts that day
      //            with a menu shift that also covers the interval.
      // Effect = change in the day's modeled unmet demand (all areas).
      const list = proposedFor(day)
      const pHoursOf = p => Array.from({ length: p.length }, (_, k) => (p.start + k) % 24)
      const covers = p => hours.every(h => pHoursOf(p).includes(h))
      const baseUnmet = dayUnmet(day, list, teams)
      const blockAt = (h, others) => {
        const mode = resolveCoverage(coverage, area, day, h).mode
        if (mode === COVERAGE_MODE.CLOSED) return `${hh(h)} ${AREA_LABEL[area]} closed`
        if (mode === COVERAGE_MODE.CROSS_COVERED) return `${hh(h)} ${AREA_LABEL[area]} cross-covered`
        if (maxPerArea[area] != null && attendingsInArea(others, teams, area, h) + 1 > maxPerArea[area]) return `${hh(h)} ${AREA_LABEL[area]} at its maximum`
        if (attendingCountForTeam(others, team, h) + 1 > DEFAULT_MAX_PER_TEAM) return `${hh(h)} ${team} already has an attending`
        return null
      }
      const mk = p => ({ id: 'audit-cover', day, team, role_type: 'Attending', role_detail: 'Attending', startMins: p.start * 60, endMins: (p.start + p.length) * 60 })
      const options = []
      const blocked = []
      for (const p of patterns.filter(covers)) {
        const b = pHoursOf(p).map(h => blockAt(h, list)).filter(Boolean)
        if (b.length) { blocked.push({ kind: 'add', p, why: b }); continue }
        const reduction = baseUnmet - dayUnmet(day, [...list, mk(p)], teams)
        options.push({ kind: 'add', p, addedHours: p.length, reduction })
      }
      for (const a of list.filter(x => x.role_type === 'Attending' && x.team === team)) {
        const others = list.filter(x => x !== a)
        for (const p of patterns.filter(covers)) {
          const b = pHoursOf(p).map(h => blockAt(h, others)).filter(Boolean)
          if (b.length) { blocked.push({ kind: 'retime', p, from: a, why: b }); continue }
          const reduction = baseUnmet - dayUnmet(day, [...others, mk(p)], teams)
          options.push({ kind: 'retime', p, from: a, addedHours: p.length - (a.endMins - a.startMins) / 60, reduction })
        }
      }
      const describe = o => o.kind === 'add'
        ? `add ${hh(o.p.start)}+${o.p.length} h on ${team} (+${f(o.addedHours, 0)} attending-h; modeled unmet ${o.reduction >= 0 ? '−' : '+'}${f(Math.abs(o.reduction), 2)} patient-h)`
        : `move ${team}'s ${t(o.from.startMins)}–${t(o.from.endMins)} attending to ${hh(o.p.start)}+${o.p.length} h (${o.addedHours >= 0 ? '+' : ''}${f(o.addedHours, 0)} attending-h; modeled unmet ${o.reduction >= 0 ? '−' : '+'}${f(Math.abs(o.reduction), 2)} patient-h)`
      // Best within today's hours (retime, no extra hours) and cheapest add.
      const noExtra = options.filter(o => o.addedHours <= 0).sort((a, b) => b.reduction - a.reduction)[0] ?? null
      const adds = options.filter(o => o.addedHours > 0).sort((a, b) => b.reduction / b.addedHours - a.reduction / a.addedHours)
      const bestAdd = adds[0] ?? null
      const demandSum = iv.items.reduce((x, i) => x + i.demand, 0)
      const unmetSum = iv.items.reduce((x, i) => x + i.unmet, 0)
      const idleSum = iv.items.reduce((x, i) => x + i.idle, 0)

      // Classification (descriptive, with the evidence that drove it).
      let cls, why
      const closed = modes.includes(COVERAGE_MODE.CLOSED)
      const perHour = o => o.reduction / o.addedHours
      if (closed) {
        cls = 'operational-rule issue'
        why = `${AREA_LABEL[area]} is CLOSED at these hours, so no ${AREA_LABEL[area]} attending may be placed; these staff are recorded on ${team} and no staff-routing rule places them elsewhere.`
      } else if (alsoBaseline === hours.length) {
        cls = 'schedule-data artifact'
        why = "Already unsupervised in today's schedule at every one of these hours (the recorded resident/PA shift runs outside the team's attending shifts); the plan did not create it."
      } else if (!options.length) {
        cls = 'operational-rule issue'
        why = `No permitted menu shift puts an attending on ${team} for these hours${blocked.length ? ` (e.g. ${blocked[0].why.slice(0, 2).join('; ')})` : ' (no menu shift covers them)'}.`
      } else if (noExtra && noExtra.reduction > 0.01) {
        cls = 'possible search limitation'
        why = `Within the same hours the interval could be covered and modeled unmet would still fall: ${describe(noExtra)}. The solver's objective is tiered (severe shortfalls weigh more, then excess), so raw unmet is not its exact criterion — worth a Thorough re-run before concluding.`
      } else if (noExtra) {
        cls = 'optimizer tradeoff'
        why = `Covering it within the same hours means moving the team's attending, which costs coverage elsewhere: ${describe(noExtra)}.` + (bestAdd ? ` Adding hours instead: ${describe(bestAdd)} = ${f(perHour(bestAdd), 3)}/attending-h, vs the plan's least valuable shift ${f(minKeptPerHour, 3)}/h.` : '')
      } else if (bestAdd && perHour(bestAdd) < (minKeptPerHour ?? Infinity)) {
        cls = 'optimizer tradeoff'
        why = `Only possible with extra hours: ${describe(bestAdd)} = ${f(perHour(bestAdd), 3)}/attending-h, less than every shift the plan kept (least valuable ${f(minKeptPerHour, 3)}/h; median ${f(medianKeptPerHour, 3)}/h). Under the fixed budget those hours do more modeled good elsewhere.`
      } else {
        cls = 'possible search limitation'
        why = `${describe(bestAdd)} = ${f(perHour(bestAdd), 3)}/attending-h, more than the plan's least valuable shift (${f(minKeptPerHour, 3)}/h). Tiered objective caveat as above.`
      }
      const covering = { noExtra: noExtra && describe(noExtra), bestAdd: bestAdd && describe(bestAdd), bestAddPerHour: bestAdd && perHour(bestAdd),
        extraHoursNeeded: bestAdd?.addedHours ?? null, blockedExamples: blocked.slice(0, 2).map(b => `${b.kind === 'add' ? 'add' : 'move'} ${hh(b.p.start)}+${b.p.length} h: ${b.why[0]}`) }
      return {
        day, area, team, hours, from: hh(hours[0]), to: hh(hours.at(-1) + 1), staff, residentsPresent: who === 'R',
        staffCount: staff.length, residents: staff.filter(s => s.role === 'Resident').length, pas: staff.filter(s => s.role === 'PA').length,
        demand: demandSum, proposedCapacity: iv.items.reduce((x, i) => x + i.capacity, 0), unmet: unmetSum, idle: idleSum,
        proposedAreaAttendings: iv.items.map(i => i.areaAttendings), proposedTeamAttendings: 0,
        baselineTeamAtt, baselineAreaAtt, modes, routing: staff.some(s => s.routed), alsoBaseline,
        covering, cls, why,
      }
    })

    // ── Expected demand, no attending in the area (planner metric definition) ─
    function unattended(week, shiftsForDay, tms) {
      const items = []
      week.days.forEach(({ day, analysis }) => {
        const att = shiftsForDay(day).filter(s => s.role_type === 'Attending')
        for (let h = 0; h < 24; h++) for (const area of week.areas) {
          const row = analysis.hours[h].byArea[area]
          const on = att.filter(s => teamArea(s.team, tms) === area && shiftCoversHour(s, h)).length
          if (row.demand >= UNATTENDED_DEMAND_PPH && on === 0 && !row.coverage?.crossCovered) {
            items.push({ day, hour: h, area, demand: row.demand, capacity: row.capacity, mode: row.coverage?.mode })
          }
        }
      })
      return items
    }
    const unattP = unattended(after.week, proposedFor, teams)
    const unattB = unattended(before.week, currentFor, [])
    const unattBKey = new Set(unattB.map(i => `${i.day}|${i.hour}|${i.area}`))
    const unattRows = intervals(unattP, i => i.area).map(iv => ({
      day: iv.day, area: iv.key, from: hh(iv.hours[0]), to: hh(iv.hours.at(-1) + 1), hours: iv.hours.length,
      demand: iv.items.reduce((x, i) => x + i.demand, 0), capacity: iv.items.reduce((x, i) => x + i.capacity, 0),
      modes: [...new Set(iv.items.map(i => i.mode))], newInPlan: iv.hours.filter(h => !unattBKey.has(`${iv.day}|${h}|${iv.key}`)).length,
    }))

    // ── Report ──────────────────────────────────────────────────────────────
    const L = []
    const st = solverStatus(plan.result.status, plan.result.stats?.relativeGap)
    const opB = before.operational, opA = after.operational
    L.push('# Unsupervised resident/APP audit — Staffing Planner default Whole-ED plan', '')
    L.push('> **Resident supervision is now a hard rule** (confirmed): a resident on a clinical team works only while that team has a supervising attending, evaluated on the operating team after staff routing (explicitly cross-covered hours: supervised by the covering area). This report checks that no resident is left unsupervised and lists PA/APP-only intervals separately under the existing APP rules.', '')
    L.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`analysis/unsupervisedStaffAudit.analysis.js\`. **Descriptive only**: this report does not judge whether any interval is clinically acceptable, and no constraint has been added. It exists so a person can decide whether a hard "resident/PA present → attending required" rule is needed.`, '')
    L.push('## Run reproduced', '')
    L.push(`- Data: ${source}.`)
    L.push(`- Planner settings (the v3 UI defaults): Fixed attending hours = today's ${f(weekly, 0)} h/week; scope Whole ED; mean demand; current start times × 8/10/12 h; default operational coverage (Main dedicated 24/7; ERU dedicated Mon–Fri 09:00–01:00, Sat–Sun 11:00–19:00, cross-covered by Main otherwise, max 1; FastTrack closed 01:00–07:00, flexible otherwise; conservative cross-cover credit; default staff routing); up to ${DEFAULT_MAX_FLEX} new-team attendings per area; ${DEFAULT_MAX_PER_TEAM} attending at a time per existing team; Standard search.`)
    L.push(`- Solver: ${st.label} — ${st.detail}; ${f(plan.result.stats?.solveSeconds, 1)} s.`)
    L.push(`- Modeled unmet demand: ${f(before.componentUncoveredPphHours)} → ${f(after.componentUncoveredPphHours)} patient-h/week (summed per area). Attending hours ${f(plan.result.hours.total, 0)}.`)
    L.push(`- "Unsupervised resident/PA h" (area-hours): ${AREAS.map(a => `${AREA_LABEL[a]} ${opB[a].unsupervisedExtenderHours} → ${opA[a].unsupervisedExtenderHours}`).join('; ')}.`)
    L.push(`- "No attending, demand" hours: ${AREAS.map(a => `${AREA_LABEL[a]} ${before.byArea[a].unattendedDemandHours} → ${after.byArea[a].unattendedDemandHours}`).join('; ')}.`)
    L.push(`- Definition (the planner's own, \`operationalCoverageSummary\`): an area-hour where residents/PAs operate (after staff routing) on a team with no attending on, and the area is not being cross-covered. Their modeled capacity is then zero. One area-hour can involve more than one team.`, '')
    L.push('## How the "why" column was worked out', '')
    L.push(`- **Covering options**: every way to put an attending on that team for the whole interval using only current-menu shifts and the planner's own limits (area rules, area maximum, one attending at a time per existing team) — either *re-time* one of the team's planned attending shifts that day to a menu shift that also covers the interval, or *add* a menu shift. Each option's effect is the change in the day's modeled unmet demand (all areas, operational view), holding the rest of the plan fixed.`)
    L.push(`- **Value of the plan's own shifts**: for each of the ${kept.length} attending shifts in the proposed plan, the modeled unmet increase if it were removed. Least valuable ${f(minKeptPerHour, 3)}, median ${f(medianKeptPerHour, 3)} patient-h per attending-hour.`)
    L.push(`- **Going rate**: 8 more budgeted hours (${f(weekly + 8, 0)} h, same settings, warm-started) reduce modeled unmet by ${goingRate == null ? '— (no plan)' : `${f(goingRate * 8, 2)} patient-h (${f(goingRate, 3)} per hour)`}.`)
    L.push(`- **Classification** (what it *appears* to be): *operational-rule issue* — a closure or hard limit leaves no permitted way to put an attending there; *schedule-data artifact* — already unsupervised in today's schedule; *optimizer tradeoff* — covering it within today's hours raises modeled unmet elsewhere, and extra hours there are worth less than the plan's least valuable shift; *possible search limitation* — a permitted option looks better by raw unmet (the solver's tiered objective is not raw unmet, so this is not proof of a worse plan).`, '')

    const byCls = {}
    for (const r of rows) byCls[r.cls] = (byCls[r.cls] ?? 0) + r.hours.length
    L.push('## Summary', '')
    const prevRes = baselineItems.filter(i => i.hasResident).length
    L.push(`**Resident team-hours without a supervising attending in the plan: ${residentItems.length}** (invariant: must be 0 — checked). Today's schedule: ${prevRes}. Before the rule was added, the same default plan created 46 Main + 18 FastTrack unsupervised resident/PA team-hours (previous audit).`, '')
    L.push(`**PA/APP-only team-hours with no attending on the team:** ${proposedItems.filter(i => !i.hasResident).length} (${AREAS.map(a => `${AREA_LABEL[a]} ${proposedItems.filter(i => !i.hasResident && i.area === a).length}`).join(', ')}). Under the existing APP rules this is permitted: a PA with no attending on the team adds no supervised capacity (FastTrack PAs keep their solo rate), so these hours only lose modeled capacity. Whether APPs also need an attending on their team has not been confirmed as a hard rule.`, '')
    L.push(`${rows.length} intervals, ${proposedItems.length} team-hours (${AREAS.map(a => `${AREA_LABEL[a]} ${proposedItems.filter(i => i.area === a).length}`).join(', ')}); ${proposedItems.filter(i => baselineKey.has(`${i.day}|${i.hour}|${i.area}|${i.team}`)).length} of them are already unsupervised in today's schedule.`, '')
    L.push('| Appears to be | Team-hours |', '| --- | ---: |')
    for (const [k, v] of Object.entries(byCls).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
    L.push('')
    L.push(`Idle (unsupervised) resident/PA capacity in these intervals: ${f(rows.reduce((x, r) => x + r.idle, 0))} patient-h/week that would count if an attending were on the team (capped by that attending's ceiling).`, '')

    L.push('## PA/APP-only intervals', '')
    if (!rows.length) L.push('None: every resident and PA/APP in the plan works on a team with an attending on (or in explicitly cross-covered hours).', '')
    L.push('Hours are on the 24-hour day template. Demand, capacity and unmet are summed over the interval (patient-hours). Area attendings are per hour.', '')
    rows.forEach((r, i) => {
      L.push(`### ${i + 1}. ${r.day} ${r.from}–${r.to} · ${AREA_LABEL[r.area]} · team ${r.team} · ${r.residentsPresent ? '**RESIDENTS — invariant violation**' : 'PA/APP only'} — *${r.cls}*`, '')
      L.push(`- Staff present (${r.residents} resident${r.residents === 1 ? '' : 's'}, ${r.pas} PA${r.pas === 1 ? '' : 's'}): ${r.staff.map(s => `${s.role} ${s.detail}${s.level ? ` (${s.level})` : ''}, recorded team ${s.recordedTeam}, ${s.time}${s.routed ? ' — routed here by staff routing' : ''}`).join('; ')}.`)
      L.push(`- Modeled demand ${f(r.demand, 2)}; proposed modeled capacity ${f(r.proposedCapacity, 2)}; proposed unmet ${f(r.unmet, 2)}; idle resident/PA capacity ${f(r.idle, 2)}.`)
      L.push(`- Attendings — proposed: team 0, area ${r.proposedAreaAttendings.join('/')}; today: team ${r.baselineTeamAtt.join('/')}, area ${r.baselineAreaAtt.join('/')}.`)
      L.push(`- Area rule: ${r.modes.map(m => m.toLowerCase().replace('_', ' ')).join(', ')}. Staff routing applies: ${r.routing ? 'yes' : 'no'}. Unsupervised in today's schedule too: ${r.alsoBaseline}/${r.hours.length} h.`)
      L.push(`- Attending cover within today's hours (re-time an existing ${r.team} shift): ${r.covering.noExtra ?? 'no permitted menu shift'}.`)
      L.push(`- With extra hours: ${r.covering.bestAdd ? `${r.covering.bestAdd} → about +${f(r.covering.extraHoursNeeded, 0)} attending-h/week` : 'no permitted menu shift can be added'}${r.covering.blockedExamples.length ? `; not permitted, e.g. ${r.covering.blockedExamples.join('; ')}` : ''}.`)
      L.push(`- Why: ${r.why}`, '')
    })

    L.push('## Expected demand with no attending in the area', '')
    L.push(`Planner definition: demand ≥ ${UNATTENDED_DEMAND_PPH} patients/hr, no attending of that area on, and not cross-covered. ${unattP.length} area-hours in the plan vs ${unattB.length} today.`, '')
    L.push('| Day | Area | Hours | Area rule | Demand (patient-h) | Capacity (patient-h) | New vs today |', '| --- | --- | --- | --- | ---: | ---: | ---: |')
    for (const u of unattRows) L.push(`| ${u.day} | ${AREA_LABEL[u.area]} | ${u.from}–${u.to} | ${u.modes.map(m => m.toLowerCase().replace('_', ' ')).join(', ')} | ${f(u.demand, 2)} | ${f(u.capacity, 2)} | ${u.newInPlan}/${u.hours} h |`)
    L.push('')
    L.push('## Notes and limits', '')
    L.push('- Everything here is the model: assumed rates, historical mean roomed patients per hour, operational view. It does not show where these staff actually work or who supervises them in practice.')
    L.push('- In the model residents/PAs are supervised only by an attending on their own team (capacity.js). An attending the planner adds on a *new* team adds its own solo capacity but never supervises these staff, and each existing team takes at most one attending at a time — so the only way to cover a team\'s residents at the edge of its attending shift is to re-time that shift.')
    L.push('- Staff routing (FastTrack -Green/-Red overnight staff → Main Green/Red while FastTrack is closed) is a confirmed operational rule; routed staff are evaluated on their operating team.')
    L.push('- Covering options change one shift in the finished plan and hold everything else fixed; they do not re-optimize. An "add" option would also have to be paid for by dropping hours elsewhere to stay within budget.')
    L.push('')

    mkdirSync(path.dirname(OUT), { recursive: true })
    writeFileSync(`${OUT}.md`, L.join('\n'))
    writeFileSync(`${OUT}.json`, JSON.stringify({ source, weekly, status: plan.result.status, gap: plan.result.stats?.relativeGap,
      unmet: { before: before.componentUncoveredPphHours, after: after.componentUncoveredPphHours }, goingRate, minKeptPerHour, medianKeptPerHour,
      rows, unattRows }, null, 2))
    console.log(`wrote ${OUT}.md — ${rows.length} intervals`)
  })
})
