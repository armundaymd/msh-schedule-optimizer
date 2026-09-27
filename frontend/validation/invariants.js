// Invariants checked on EVERY generated schedule, independent of scenario.
// Each check returns { group, name, pass, detail }:
//   pass === true   invariant holds
//   pass === false  invariant violated (the run FAILS)
//   pass === null   informational measurement (never fails a run)

import { scopeAreas } from '../src/shared/areas'
import { shiftCoversHour, teamArea, teamCapacity, teamCapacityForTeam } from '../src/shared/capacity'
import { EXCESS_MIN_FRACTION, EXCESS_MIN_PPH } from '../src/shared/coverageInsights'
import { getDemandSeries } from '../src/shared/demandSeries'
import { AREA_LABEL } from '../src/shared/areas'
import { oracleAreaCapacity, oracleHours, oracleTeamCapacity } from './oracle'

const EPS = 1e-9
const fmt = (n, d = 2) => Number(n).toFixed(d)
const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`

export function excessTolerance(d) {
  return Math.max(EXCESS_MIN_PPH, EXCESS_MIN_FRACTION * d)
}

// Per area x day x hour numbers for a schedule, from the APP's capacity code.
export function measure(sc, schedule, customTeams) {
  const out = {}
  for (const area of scopeAreas(sc.scope)) {
    out[area] = sc.days.map(day => Array.from({ length: 24 }, (_, h) => {
      const d = sc.demandSeries[area]?.[h] ?? 0
      const cap = teamCapacity(schedule[day], sc.pph, customTeams, area, h)
      return { d, cap, deficit: Math.max(0, d - cap), surplus: Math.max(0, cap - d), excess: Math.max(0, cap - d - excessTolerance(d)) }
    }))
  }
  return out
}

export function totals(m) {
  const t = { demand: 0, served: 0, deficit: 0, deficitHours: 0, surplus: 0, excess: 0, excessHours: 0, worst: null }
  for (const [area, days] of Object.entries(m)) {
    days.forEach((hours, di) => hours.forEach((x, h) => {
      t.demand += x.d; t.served += Math.min(x.d, x.cap); t.deficit += x.deficit; t.surplus += x.surplus; t.excess += x.excess
      if (x.deficit > EPS) t.deficitHours++
      if (x.excess > EPS) t.excessHours++
      if (x.deficit > EPS && (!t.worst || x.deficit > t.worst.deficit)) t.worst = { area, day: di, hour: h, deficit: x.deficit }
    }))
  }
  t.coveragePct = t.demand > 0 ? (100 * t.served) / t.demand : 100
  return t
}

function check(group, name, pass, detail = '') {
  return { group, name, pass, detail }
}

function allShifts(byDay, days) {
  return days.flatMap(d => (byDay[d] ?? []).map(s => ({ ...s, day: d })))
}

export function checkInvariants(sc, run) {
  const out = []
  const areas = scopeAreas(sc.scope)
  const gen = allShifts(run.generated, sc.days)
  const allowed = new Set(sc.patterns.map(p => `${p.start}/${p.length}`))
  const lengths = new Set(sc.patterns.map(p => p.length))

  // ── Total staffing hours ────────────────────────────────────────────────
  const genHours = gen.reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)
  out.push(check('hours', 'Engine-reported hours equal the hours of the shifts it returned',
    Math.abs(genHours - run.reported.hours) < EPS, `shifts ${fmt(genHours, 1)} h vs reported ${fmt(run.reported.hours, 1)} h`))
  if (run.reported.lockedHours != null) {
    const locked = allShifts(run.locked, sc.days).reduce((t, s) => t + (s.endMins - s.startMins) / 60, 0)
    out.push(check('hours', 'Reported locked hours equal the locked shifts\' hours',
      Math.abs(locked - run.reported.lockedHours) < EPS, `${fmt(locked, 1)} h vs ${fmt(run.reported.lockedHours, 1)} h`))
  }

  // ── Shift shape: lengths, starts/ends, overnight ─────────────────────────
  const badLen = gen.filter(s => !lengths.has((s.endMins - s.startMins) / 60))
  out.push(check('shape', 'Every shift length is an allowed length', badLen.length === 0,
    badLen.length ? `disallowed: ${badLen.map(s => `${s.team} ${hhmm(s.startMins)}+${(s.endMins - s.startMins) / 60}h`).join(', ')}` : `allowed: ${[...lengths].join('/')} h`))
  const badPat = gen.filter(s => !allowed.has(`${s.startMins / 60}/${(s.endMins - s.startMins) / 60}`))
  out.push(check('shape', 'Every shift is an allowed (start, length) pattern', badPat.length === 0,
    badPat.length ? `not in menu: ${badPat.map(s => `${hhmm(s.startMins)}+${(s.endMins - s.startMins) / 60}h`).join(', ')}` : `${sc.patterns.length} allowed patterns`))
  const badTimes = gen.filter(s => s.startMins % 60 !== 0 || s.startMins < 0 || s.startMins >= 1440 || s.endMins <= s.startMins
    || s.endMins - s.startMins > 1440 || s.start_time !== hhmm(s.startMins) || s.end_time !== hhmm(s.endMins))
  out.push(check('shape', 'Starts on the hour within the day; end = start + length; time labels match', badTimes.length === 0,
    badTimes.map(s => `${s.start_time}-${s.end_time} (${s.startMins}-${s.endMins})`).join(', ')))

  // ── Overnight handling: app hour coverage == oracle minute walk ─────────
  const scheduleShifts = allShifts(run.schedule, sc.days)
  const coverMismatch = scheduleShifts.filter(s => {
    const hrs = oracleHours(s)
    return Array.from({ length: 24 }, (_, h) => shiftCoversHour(s, h) !== hrs.has(h)).some(Boolean)
  })
  const overnight = gen.filter(s => s.endMins > 1440)
  out.push(check('overnight', 'Hours each shift covers agree with an independent minute-by-minute walk (incl. past midnight)',
    coverMismatch.length === 0,
    coverMismatch.length ? coverMismatch.map(s => `${s.team} ${s.start_time}-${s.end_time}`).join(', ') : `${overnight.length} generated shift(s) cross midnight`))

  // ── Coverage: app capacity == independent oracle, per area-hour and team-hour
  let maxTeamDiff = 0, maxAreaDiff = 0, supervisionBad = []
  for (const day of sc.days) {
    const shifts = run.schedule[day]
    const teams = [...new Set(shifts.map(s => s.team))]
    for (let h = 0; h < 24; h++) {
      for (const team of teams) {
        const area = teamArea(team, run.customTeams)
        const o = oracleTeamCapacity(shifts, sc.pph, area, team, h)
        maxTeamDiff = Math.max(maxTeamDiff, Math.abs(o.cap - teamCapacityForTeam(shifts, sc.pph, area, team, h)))
        if (o.cap > o.ceiling + o.solo + EPS || (o.nAtt === 0 && Math.abs(o.cap - o.solo) > EPS)) {
          supervisionBad.push(`${day} ${team} ${h}:00`)
        }
      }
      for (const area of areas) {
        maxAreaDiff = Math.max(maxAreaDiff,
          Math.abs(oracleAreaCapacity(shifts, sc.pph, run.customTeams, area, h) - teamCapacity(shifts, sc.pph, run.customTeams, area, h)))
      }
    }
  }
  out.push(check('coverage', 'App team capacity (capacity.js) equals the independent oracle at every team-hour',
    maxTeamDiff < 1e-9, `max |diff| ${maxTeamDiff.toExponential(1)}`))
  out.push(check('coverage', 'App area capacity equals the oracle at every area-hour', maxAreaDiff < 1e-9, `max |diff| ${maxAreaDiff.toExponential(1)}`))
  out.push(check('supervision', 'No team exceeds nAttendings x ceiling + solo; with no attending only solo PA capacity counts',
    supervisionBad.length === 0, supervisionBad.slice(0, 5).join(', ')))

  // ── Per-team concurrency (supervision structure) ─────────────────────────
  const overlapBad = []
  for (const day of sc.days) {
    const byTeam = {}
    for (const s of (run.generated[day] ?? [])) (byTeam[s.team] ??= []).push(s)
    for (const [team, list] of Object.entries(byTeam)) {
      const lockedOn = (run.locked[day] ?? []).filter(s => s.team === team)
      for (let h = 0; h < 24; h++) {
        const n = list.filter(s => shiftCoversHour(s, h)).length
        const nLocked = lockedOn.filter(s => shiftCoversHour(s, h)).length
        if (n + nLocked > Math.max(run.maxPerTeam, nLocked)) overlapBad.push(`${day} ${team} ${h}:00 (${n + nLocked})`)
      }
    }
  }
  out.push(check('supervision', `At most ${run.maxPerTeam} generated attending per team at a time (a team = one attending's group)`,
    overlapBad.length === 0, overlapBad.slice(0, 5).join(', ')))

  // ── Deficit / excess / demand conservation ───────────────────────────────
  const m = measure(sc, run.schedule, run.customTeams)
  const t = totals(m)
  let conservationBad = 0
  for (const days of Object.values(m)) for (const hours of days) {
    const d = hours.reduce((a, x) => a + x.d, 0)
    const served = hours.reduce((a, x) => a + Math.min(x.d, x.cap), 0)
    const unmet = hours.reduce((a, x) => a + x.deficit, 0)
    if (Math.abs(served + unmet - d) > 1e-6) conservationBad++
  }
  out.push(check('demand', 'Per area-day: served + unmet demand = demand', conservationBad === 0, `demand ${fmt(t.demand, 1)} = served ${fmt(t.served, 1)} + unmet ${fmt(t.deficit, 1)} patient-hours`))
  const demandMismatch = areas.filter(a => sc.days.some(day =>
    getDemandSeries(sc.demandJson, AREA_LABEL[a], day, 'mean').some((v, h) => Math.abs(v - (sc.demandSeries[a]?.[h] ?? 0)) > EPS)))
  out.push(check('demand', 'Demand the engines read equals the scenario\'s demand (no silent fallback)', demandMismatch.length === 0, demandMismatch.join(', ')))
  if (run.instance) {
    const instMismatch = run.instance.areas.filter(a => a.demand.some(row => row.some((v, h) => Math.abs(v - (sc.demandSeries[a.key]?.[h] ?? 0)) > EPS)))
    out.push(check('demand', 'Solver instance demand equals the scenario demand', instMismatch.length === 0, instMismatch.map(a => a.key).join(', ')))
  }

  if (run.engine === 'allocator') {
    let maxCapDiff = 0
    for (const area of areas) m[area].forEach((hours, di) => hours.forEach((x, h) => {
      maxCapDiff = Math.max(maxCapDiff, Math.abs((run.claimed.capacity[area]?.[di]?.[h] ?? 0) - x.cap))
    }))
    const tol = 0.03
    out.push(check('coverage', 'Solver\'s modelled capacity equals app capacity (0.01 PPH scaling)', maxCapDiff <= tol, `max |diff| ${fmt(maxCapDiff, 4)} PPH`))
    const n = areas.length * sc.days.length * 24
    out.push(check('deficit', 'Solver-reported deficit equals recomputed deficit', Math.abs(run.claimed.deficitPphHours - t.deficit) <= 0.02 * n,
      `solver ${fmt(run.claimed.deficitPphHours)} vs app ${fmt(t.deficit)} patient-hours`))
    out.push(check('excess', 'Solver-reported excess equals recomputed excess (beyond tolerance)', Math.abs(run.claimed.excessPphHours - t.excess) <= 0.02 * n,
      `solver ${fmt(run.claimed.excessPphHours)} vs app ${fmt(t.excess)} patient-hours`))
  } else {
    // The generator's OWN arithmetic (attendings x ceiling) must be right...
    let maxUnc = 0, claimedDeficit = 0
    for (const area of areas) run.claimed.uncovered[area].forEach((row, di) => row.forEach((u, h) => {
      const own = Math.max(0, (sc.demandSeries[area]?.[h] ?? 0) - run.claimed.capacity[area][di][h])
      maxUnc = Math.max(maxUnc, Math.abs(own - u))
      claimedDeficit += u
    }))
    out.push(check('deficit', 'Generator\'s reported uncovered demand matches its own model (attendings x ceiling)', maxUnc < 0.001, `max |diff| ${fmt(maxUnc, 4)}`))
    // ...and the gap between its model and the app's capacity is MEASURED, not failed:
    // it sizes attendings at their supervision ceiling by design (see GeneratorResult).
    out.push(check('model', 'Generator-assumed vs app-computed unmet demand (informational)', null,
      `generator assumes ${fmt(claimedDeficit)} unmet; app capacity after applying it gives ${fmt(t.deficit)} unmet patient-hours`))
  }

  // ── Locked shifts, untouched shifts, budget ──────────────────────────────
  const key = s => `${s.team}|${s.role_type}|${s.resident_level ?? ''}|${s.startMins}|${s.endMins}`
  const lockedMissing = sc.days.flatMap(day => (run.locked[day] ?? []).filter(l => !run.schedule[day].some(s => key(s) === key(l))).map(l => `${day} ${key(l)}`))
  out.push(check('locked', 'Every locked shift is present unchanged', lockedMissing.length === 0, lockedMissing.join(', ') || `${allShifts(run.locked, sc.days).length} locked`))

  // Before: the scenario's teams. After: the run's teams, which include any
  // new teams the engine created (their area comes from that list).
  const outsideOf = teams => s => !areas.includes(teamArea(s.team, teams))
  const outsideChanged = sc.days.filter(day => {
    const before = sc.currentFor(day).filter(outsideOf(sc.customTeams)).map(key).sort().join()
    const after = run.schedule[day].filter(outsideOf(run.customTeams)).map(key).sort().join()
    return before !== after
  })
  out.push(check('scope', 'Shifts outside the scope are untouched', outsideChanged.length === 0, outsideChanged.join(', ')))

  const inScopeExt = teams => s => s.role_type !== 'Attending' && !outsideOf(teams)(s)
  const extendersChanged = sc.days.filter(day =>
    sc.currentFor(day).filter(inScopeExt(sc.customTeams)).map(key).sort().join()
      !== run.schedule[day].filter(inScopeExt(run.customTeams)).map(key).sort().join())
  out.push(check('scope', 'Residents/PAs in scope are kept as scheduled, same team/times/level (only attendings are planned)',
    extendersChanged.length === 0, extendersChanged.join(', ')))

  if (run.budget != null) {
    const lockedHours = run.reported.lockedHours ?? 0
    out.push(check('budget', 'Generated + locked hours never exceed the budget', genHours + lockedHours <= run.budget + EPS,
      `${fmt(genHours + lockedHours, 1)} h used of ${fmt(run.budget, 2)} h`))
  }

  return { checks: out, metrics: t, measured: m }
}
