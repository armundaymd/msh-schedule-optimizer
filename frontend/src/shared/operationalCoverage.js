// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { AREAS, AREA_BASE_TEAMS, AREA_LABEL } from './areas'
import {
  attendingCapacity, attendingCountForTeam, extenderCapacity, shiftCoversHour, teamArea,
} from './capacity'

// Operational attending coverage — the rules that come BEFORE throughput
// optimisation. For every area, day and hour the configuration says one of:
//
//   REQUIRED_DEDICATED  at least `minAttendings` attendings must be assigned
//                       to THIS area — a HARD constraint in the allocator. The
//                       rule's `basis` says where it comes from: 'policy' (a
//                       true operational minimum) or 'current-schedule' (kept
//                       because today's schedule has it — NOT a statement that
//                       the model has established clinical necessity).
//   CROSS_COVERED       no dedicated attending is placed here; the
//                       `coveredBy` area's attendings are responsible. The
//                       area's demand and residents/PAs stay the area's own
//                       (see crossCoverCredit for the capacity rule).
//   CLOSED              the area is not independently operating: no
//                       dedicated attending is required or placed. Its
//                       historical demand is NOT removed — any demand still
//                       recorded in these hours stays the area's, and counts
//                       as unmet if nothing covers it.
//   FLEXIBLE            no hard requirement; the allocator may place
//                       attendings if that improves the objective. With an
//                       optional `coveredBy`, the named area is responsible
//                       whenever the allocator leaves the area without its
//                       own attending.
//
// Config shape (plain JSON — stored in scenarios as-is):
//   { version: 1,
//     areas: { [areaKey]: {
//       default: Rule, rules: [Rule & { days?, fromHour, toHour, label?, basis? }],
//       maxAttendings?,      // most dedicated attendings on at once (all hours)
//       crossCoverCredit?,   // throughput credited when this area is cross-covered
//     } },
//     staffRouting?: [RoutingRule],
//     notes?: string[] }
//   Rule = { mode, minAttendings? (REQUIRED_DEDICATED, default 1), coveredBy? }
//   RoutingRule = { days?, fromHour, toHour,
//                   match: { team, roleDetailSuffix?, roleTypes? },
//                   to: { area, team }, label?, basis?, confirmed? }
//
// STAFF ROUTING separates a resident/PA's TEAM IDENTITY (the schedule record:
// team, times, level — never edited) from where they OPERATIONALLY work at a
// given day/hour. A matching shift is treated as a member of `to.team` (in
// `to.area`) for capacity and supervision during the rule's window: it adds
// capacity there, under that team's attending supervision ceiling, and none
// to its recorded team. Attendings are never routed (they are what the
// allocator places). Patients never move: demand is always the area's own.
// Closing an area moves nobody by itself — only an explicit rule does.
//
// Three separate things (never conflated):
//   1. coverage RESPONSIBILITY — mode + coveredBy: who answers for the area;
//   2. resident/PA SUPERVISION — under cross-coverage the covering area's
//      attendings supervise the area's residents/PAs (they are never counted
//      as unsupervised);
//   3. THROUGHPUT CREDIT — how much modeled capacity that supervision adds.
//      Uncertain, so it is an explicit per-area assumption (crossCoverCredit):
//        CONSERVATIVE   no credit (default)
//        CURRENT_RATIO  the earlier behaviour: covering headroom × covered
//                       ceiling / covering ceiling (0.8 / 2.1 for ERU under
//                       Main) — an UNVALIDATED conversion, analysis only
//        CUSTOM         { residentCreditFraction, headroomFactor } as set
// Resolution: the LAST rule whose days and hour window match wins; else the
// area's default; an area missing from the config is FLEXIBLE.
// Hour windows are [fromHour, toHour) on the app's circular 24-hour day
// template (from === to = all day; 19→7 wraps midnight): a window 09→01 on
// Monday covers Monday's 09:00–23:59 and Monday's 00:00–00:59, exactly the
// hours a Monday 17:00–01:00 shift covers (shared/capacity.js shiftCoversHour).

export const COVERAGE_MODE = {
  REQUIRED_DEDICATED: 'REQUIRED_DEDICATED',
  CROSS_COVERED: 'CROSS_COVERED',
  CLOSED: 'CLOSED',
  FLEXIBLE: 'FLEXIBLE',
}
export const COVERAGE_MODES = Object.values(COVERAGE_MODE)
export const COVERAGE_MODE_LABEL = {
  REQUIRED_DEDICATED: 'Dedicated (hard)',
  CROSS_COVERED: 'Cross-covered',
  CLOSED: 'Closed',
  FLEXIBLE: 'Flexible',
}

export const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const WEEKDAYS = WEEK_DAYS.slice(0, 5)
const WEEKEND = WEEK_DAYS.slice(5)
const pad = h => `${String(h).padStart(2, '0')}:00`

// Structural limits that hold in EVERY scenario, independent of the coverage
// rules: ERU never needs more than one dedicated attending at the same time.
// A config may set a lower limit, never a higher one.
export const STRUCTURAL_MAX_ATTENDINGS = Object.freeze({ eru: 1 })

export const CROSS_COVER_CREDIT = {
  CONSERVATIVE: 'CONSERVATIVE',
  CURRENT_RATIO: 'CURRENT_RATIO',
  CUSTOM: 'CUSTOM',
}
export const CROSS_COVER_CREDIT_MODES = Object.values(CROSS_COVER_CREDIT)
export const CROSS_COVER_CREDIT_LABEL = {
  CONSERVATIVE: 'Conservative — no throughput credit',
  CURRENT_RATIO: 'Ceiling ratio (unvalidated, analysis only)',
  CUSTOM: 'Custom assumption',
}

// Initial configuration. Every window below is read off the committed
// current schedule (data/Current_Schedule_Block.csv) or observed demand
// (data/processed/demand.json) — none is a clinical rule invented here.
// They are CONFIGURATION: confirm with the department and edit per scenario.
export const DEFAULT_OPERATIONAL_COVERAGE = Object.freeze({
  version: 1,
  areas: {
    main: {
      // Main needs an attending 24/7. Minimum 1: no existing setting
      // defines a higher minimum (the current schedule has 2+ at all hours,
      // but that is the schedule, not a rule).
      default: { mode: COVERAGE_MODE.REQUIRED_DEDICATED, minAttendings: 1 },
      rules: [],
    },
    eru: {
      // Outside the dedicated window Main cross-covers ERU.
      default: { mode: COVERAGE_MODE.CROSS_COVERED, coveredBy: 'main' },
      rules: [
        // Current schedule: ERU attending 09:00–17:00 + 17:00–01:00 Mon–Fri.
        { days: WEEKDAYS, fromHour: 9, toHour: 1, mode: COVERAGE_MODE.REQUIRED_DEDICATED, minAttendings: 1, label: 'Current ERU dedicated coverage (weekdays)', basis: 'current-schedule' },
        // Current schedule: ERU attending 11:00–19:00 Sat–Sun.
        { days: WEEKEND, fromHour: 11, toHour: 19, mode: COVERAGE_MODE.REQUIRED_DEDICATED, minAttendings: 1, label: 'Current ERU dedicated coverage (weekend)', basis: 'current-schedule' },
      ],
      maxAttendings: 1,
      crossCoverCredit: { mode: CROSS_COVER_CREDIT.CONSERVATIVE },
    },
    fasttrack: {
      // No stated requirement for a FastTrack attending while open.
      default: { mode: COVERAGE_MODE.FLEXIBLE },
      rules: [
        // Historical FastTrack arrivals are < 0.5/hr at every hour 01:00–06:59
        // (mean, all days) and no FastTrack attending is scheduled then.
        { fromHour: 1, toHour: 7, mode: COVERAGE_MODE.CLOSED, label: 'FastTrack closed overnight' },
      ],
    },
  },
  // FastTrack-team residents/PAs working overnight carry a Main-team suffix
  // in the schedule's role_detail ("EM3/4-Green", "PA-Red", "OS-Green", ...);
  // FastTrack's own day staff ("PA-Prim", "Mid-Level") carry none. The
  // suffix gives the destination Main team; the timing (FastTrack's closed
  // hours) comes from the closure rule. Marked unconfirmed until the
  // department confirms these staff work Main while FastTrack is closed.
  staffRouting: [
    { fromHour: 1, toHour: 7, match: { team: 'FastTrack', roleDetailSuffix: '-Green' }, to: { area: 'main', team: 'Green' },
      label: 'FastTrack "-Green" overnight staff work Main Green while FastTrack is closed', basis: 'role-detail-suffix', confirmed: false },
    { fromHour: 1, toHour: 7, match: { team: 'FastTrack', roleDetailSuffix: '-Red' }, to: { area: 'main', team: 'Red' },
      label: 'FastTrack "-Red" overnight staff work Main Red while FastTrack is closed', basis: 'role-detail-suffix', confirmed: false },
  ],
  notes: [
    'Staff routing: FastTrack-team residents/PAs whose role_detail ends in -Green/-Red work that Main team while FastTrack is closed (01:00–07:00). Inferred from the schedule\'s role_detail suffix — to be confirmed.',
    'ERU dedicated windows = the CURRENT ERU dedicated coverage (Mon–Fri 09:00–01:00, Sat–Sun 11:00–19:00), kept as a hard rule so alternatives can be compared against it — not a clinically established minimum.',
    'ERU: at most one dedicated attending at a time (structural).',
    'Cross-cover throughput credit for ERU: conservative (none) unless a scenario sets another assumption.',
    'FastTrack closed 01:00–07:00 = hours with near-zero historical FastTrack arrivals and no FastTrack attending today.',
    'Main minimum = 1 attending at all hours.',
  ],
})

export function inWindow(h, fromHour, toHour) {
  if (fromHour === toHour) return true
  return fromHour < toHour ? h >= fromHour && h < toHour : h >= fromHour || h < toHour
}

function ruleApplies(rule, day, hour) {
  if (rule.days && rule.days.length && !rule.days.includes(day)) return false
  return inWindow(hour, rule.fromHour ?? 0, rule.toHour ?? 0)
}

function normalizeRule(r = {}) {
  const mode = COVERAGE_MODES.includes(r.mode) ? r.mode : COVERAGE_MODE.FLEXIBLE
  const out = { mode }
  if (mode === COVERAGE_MODE.REQUIRED_DEDICATED) out.minAttendings = Math.max(1, Math.round(Number(r.minAttendings ?? 1)) || 1)
  if ((mode === COVERAGE_MODE.CROSS_COVERED || mode === COVERAGE_MODE.FLEXIBLE) && r.coveredBy) out.coveredBy = r.coveredBy
  return out
}

// Resolved rule for one area/day/hour:
// { mode, minAttendings (0 unless REQUIRED_DEDICATED), coveredBy (or null), label }
export function resolveCoverage(config, area, day, hour) {
  const ac = config?.areas?.[area]
  let rule = null
  if (ac) {
    for (const r of ac.rules ?? []) if (ruleApplies(r, day, hour)) rule = r
  }
  const base = normalizeRule(rule ?? ac?.default ?? { mode: COVERAGE_MODE.FLEXIBLE })
  return {
    mode: base.mode,
    minAttendings: base.minAttendings ?? 0,
    coveredBy: base.coveredBy ?? null,
    label: rule?.label ?? null,
  }
}

// [dayIndex][hour] of resolved rules for one area.
export function coverageGrid(config, area, days) {
  return days.map(day => Array.from({ length: 24 }, (_, h) => resolveCoverage(config, area, day, h)))
}

// True when the rule makes `coveredBy` responsible for the area this hour,
// given how many of the area's own attendings are on.
export function crossCoverApplies(rule, ownAttendings) {
  if (!rule.coveredBy || ownAttendings > 0) return false
  return rule.mode === COVERAGE_MODE.CROSS_COVERED || rule.mode === COVERAGE_MODE.FLEXIBLE
}

// Modes where the allocator may not place new dedicated attendings.
export function blocksDedicatedPlacement(mode) {
  return mode === COVERAGE_MODE.CROSS_COVERED || mode === COVERAGE_MODE.CLOSED
}

// Problems that make a config unusable, as human-readable strings ([] = ok).
export function validateCoverageConfig(config, customTeams = []) {
  const errors = []
  if (!config || typeof config !== 'object' || !config.areas) return ['Operational coverage config has no areas.']
  for (const [area, ac] of Object.entries(config.areas)) {
    if (!AREAS.includes(area)) { errors.push(`Unknown area "${area}".`); continue }
    if (ac.maxAttendings != null) {
      if (!Number.isInteger(ac.maxAttendings) || ac.maxAttendings < 1) errors.push(`${AREA_LABEL[area]}: maximum attendings must be a whole number ≥ 1.`)
      else if (STRUCTURAL_MAX_ATTENDINGS[area] != null && ac.maxAttendings > STRUCTURAL_MAX_ATTENDINGS[area]) {
        errors.push(`${AREA_LABEL[area]} never has more than ${STRUCTURAL_MAX_ATTENDINGS[area]} dedicated attending${STRUCTURAL_MAX_ATTENDINGS[area] === 1 ? '' : 's'} at once.`)
      }
    }
    if (ac.crossCoverCredit != null) {
      const c = ac.crossCoverCredit
      if (!CROSS_COVER_CREDIT_MODES.includes(c.mode)) errors.push(`${AREA_LABEL[area]}: unknown cross-cover credit mode "${c.mode}".`)
      if (c.mode === CROSS_COVER_CREDIT.CUSTOM) {
        const f = Number(c.residentCreditFraction ?? 1), k = Number(c.headroomFactor)
        if (!(f >= 0 && f <= 1)) errors.push(`${AREA_LABEL[area]}: resident/PA credit fraction must be between 0 and 1.`)
        if (!(k >= 0)) errors.push(`${AREA_LABEL[area]}: custom cross-cover needs a headroom factor ≥ 0.`)
      }
    }
    const all = [['default', ac.default ?? {}], ...(ac.rules ?? []).map((r, i) => [`rule ${i + 1}`, r])]
    for (const [where, r] of all) {
      const tag = `${AREA_LABEL[area]} ${where}`
      if (!COVERAGE_MODES.includes(r.mode)) errors.push(`${tag}: unknown mode "${r.mode}".`)
      if (r.mode === COVERAGE_MODE.CROSS_COVERED && !r.coveredBy) errors.push(`${tag}: cross-covered needs a covering area.`)
      if (r.coveredBy && !AREAS.includes(r.coveredBy)) errors.push(`${tag}: unknown covering area "${r.coveredBy}".`)
      if (r.coveredBy === area) errors.push(`${tag}: an area cannot cross-cover itself.`)
      if (r.mode === COVERAGE_MODE.REQUIRED_DEDICATED && !(Number(r.minAttendings ?? 1) >= 1)) errors.push(`${tag}: minimum attendings must be at least 1.`)
      const max = effectiveMaxAttendings(config, area)
      if (r.mode === COVERAGE_MODE.REQUIRED_DEDICATED && max != null && Number(r.minAttendings ?? 1) > max) {
        errors.push(`${tag}: requires ${r.minAttendings} attendings but ${AREA_LABEL[area]} allows at most ${max} at once.`)
      }
      if (where !== 'default') {
        for (const k of ['fromHour', 'toHour']) {
          if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 23) errors.push(`${tag}: ${k} must be a whole hour 0–23.`)
        }
        if (r.days && r.days.some(d => !WEEK_DAYS.includes(d))) errors.push(`${tag}: unknown day in ${r.days.join(', ')}.`)
      }
    }
  }
  for (const [i, r] of (config.staffRouting ?? []).entries()) {
    const tag = `Staff routing rule ${i + 1}`
    if (!r.match?.team) errors.push(`${tag}: needs a source team.`)
    if (!AREAS.includes(r.to?.area)) errors.push(`${tag}: unknown destination area "${r.to?.area}".`)
    else if (!r.to?.team) errors.push(`${tag}: needs a destination team (supervision is per team).`)
    else if (!(AREA_BASE_TEAMS[r.to.area] ?? []).includes(r.to.team) && !(customTeams ?? []).some(t => t.name === r.to.team && t.area === AREA_LABEL[r.to.area])) {
      errors.push(`${tag}: team "${r.to.team}" is not a ${AREA_LABEL[r.to.area]} team.`)
    }
    for (const k of ['fromHour', 'toHour']) {
      if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 23) errors.push(`${tag}: ${k} must be a whole hour 0–23.`)
    }
    if (r.days && r.days.some(d => !WEEK_DAYS.includes(d))) errors.push(`${tag}: unknown day in ${r.days.join(', ')}.`)
  }
  // A covering area must itself be staffed when it covers. Checked per
  // day-hour so a window-specific chain (A covers B while A is closed) is
  // caught, not only a config-wide one.
  for (const area of Object.keys(config.areas)) {
    if (!AREAS.includes(area)) continue
    for (const day of WEEK_DAYS) {
      for (let h = 0; h < 24; h++) {
        const r = resolveCoverage(config, area, day, h)
        if (!r.coveredBy || !AREAS.includes(r.coveredBy)) continue
        const cover = resolveCoverage(config, r.coveredBy, day, h)
        if (cover.mode === COVERAGE_MODE.CROSS_COVERED || cover.mode === COVERAGE_MODE.CLOSED || cover.coveredBy) {
          const state = cover.coveredBy && cover.mode === COVERAGE_MODE.FLEXIBLE ? 'itself cross-covered then' : `${COVERAGE_MODE_LABEL[cover.mode].toLowerCase()} then`
          errors.push(`${AREA_LABEL[area]} is covered by ${AREA_LABEL[r.coveredBy]} on ${day} ${pad(h)}, but ${AREA_LABEL[r.coveredBy]} is ${state}.`)
          return errors
        }
      }
    }
  }
  return errors
}

// Canonical JSON form for scenario storage: known keys only, defaults filled.
// Round-trips: normalizeCoverageConfig(JSON.parse(JSON.stringify(c))) deep-equals normalizeCoverageConfig(c).
export function normalizeCoverageConfig(config) {
  const src = config ?? DEFAULT_OPERATIONAL_COVERAGE
  const areas = {}
  for (const area of AREAS) {
    const ac = src.areas?.[area]
    if (!ac) continue
    areas[area] = {
      default: normalizeRule(ac.default),
      rules: (ac.rules ?? []).map(r => ({
        ...(r.days && r.days.length && r.days.length < 7 ? { days: WEEK_DAYS.filter(d => r.days.includes(d)) } : {}),
        fromHour: r.fromHour ?? 0,
        toHour: r.toHour ?? 0,
        ...normalizeRule(r),
        ...(r.label ? { label: r.label } : {}),
        ...(r.basis ? { basis: r.basis } : {}),
      })),
    }
    // Structural limits are always written out, so a restored scenario
    // carries them even if it was saved without.
    const max = ac.maxAttendings ?? STRUCTURAL_MAX_ATTENDINGS[area]
    if (max != null) areas[area].maxAttendings = max
    if (ac.crossCoverCredit) areas[area].crossCoverCredit = normalizeCredit(ac.crossCoverCredit)
  }
  for (const [area, max] of Object.entries(STRUCTURAL_MAX_ATTENDINGS)) {
    if (!areas[area]) areas[area] = { default: { mode: COVERAGE_MODE.FLEXIBLE }, rules: [], maxAttendings: max }
  }
  const staffRouting = (src.staffRouting ?? []).map(r => ({
    ...(r.days && r.days.length && r.days.length < 7 ? { days: WEEK_DAYS.filter(d => r.days.includes(d)) } : {}),
    fromHour: r.fromHour ?? 0,
    toHour: r.toHour ?? 0,
    match: {
      team: r.match?.team,
      ...(r.match?.roleDetailSuffix ? { roleDetailSuffix: r.match.roleDetailSuffix } : {}),
      ...(r.match?.roleTypes?.length ? { roleTypes: [...r.match.roleTypes] } : {}),
    },
    to: { area: r.to?.area, team: r.to?.team },
    ...(r.label ? { label: r.label } : {}),
    ...(r.basis ? { basis: r.basis } : {}),
    confirmed: !!r.confirmed,
  }))
  return {
    version: 1, areas,
    ...(staffRouting.length ? { staffRouting } : {}),
    ...(src.notes?.length ? { notes: [...src.notes] } : {}),
  }
}

function normalizeCredit(c) {
  const mode = CROSS_COVER_CREDIT_MODES.includes(c?.mode) ? c.mode : CROSS_COVER_CREDIT.CONSERVATIVE
  if (mode !== CROSS_COVER_CREDIT.CUSTOM) return { mode }
  return { mode, residentCreditFraction: Number(c.residentCreditFraction ?? 1), headroomFactor: Number(c.headroomFactor ?? 0) }
}

// Most dedicated attendings an area may have on at once, or null (no
// limit): the config's value, never above the structural limit.
export function effectiveMaxAttendings(config, area) {
  const configured = config?.areas?.[area]?.maxAttendings
  const structural = STRUCTURAL_MAX_ATTENDINGS[area]
  if (configured == null) return structural ?? null
  return structural == null ? configured : Math.min(configured, structural)
}

// { [area]: max } for every area with a limit (structural limits apply even
// with no config at all).
export function areaMaxAttendings(config) {
  const out = {}
  for (const area of AREAS) {
    const max = effectiveMaxAttendings(config, area)
    if (max != null) out[area] = max
  }
  return out
}

// The throughput-credit assumption for a cross-covered area, as the two
// numbers the capacity rule uses:
//   residentCreditFraction  share of the covered area's supervised
//                           resident/PA capacity that can be credited
//   headroomFactor          covered-area patients/hr credited per 1 patient/hr
//                           of the covering attendings' supervision headroom
// credit = min(fraction × resident/PA capacity, factor × headroom).
export function crossCoverCreditParams(config, area, coveringArea, pph) {
  const c = normalizeCredit(config?.areas?.[area]?.crossCoverCredit)
  if (c.mode === CROSS_COVER_CREDIT.CONSERVATIVE) return { mode: c.mode, residentCreditFraction: 0, headroomFactor: 0 }
  if (c.mode === CROSS_COVER_CREDIT.CURRENT_RATIO) {
    const covering = pph[coveringArea] ?? 0
    return { mode: c.mode, residentCreditFraction: 1, headroomFactor: covering > 0 ? (pph[area] ?? 0) / covering : 0 }
  }
  return { mode: c.mode, residentCreditFraction: c.residentCreditFraction, headroomFactor: c.headroomFactor }
}

// A copy of `config` with every area's cross-cover credit set to `credit`.
export function withCrossCoverCredit(config, credit) {
  const c = cloneCoverageConfig(config)
  for (const ac of Object.values(c.areas)) ac.crossCoverCredit = normalizeCredit(credit)
  return c
}

export function describeCrossCoverCredit(credit, pph = null, area = 'eru', coveringArea = 'main') {
  const c = normalizeCredit(credit)
  if (c.mode === CROSS_COVER_CREDIT.CONSERVATIVE) return 'no throughput credit from cross-coverage'
  if (c.mode === CROSS_COVER_CREDIT.CURRENT_RATIO) {
    const ratio = pph ? ` (${pph[area]} / ${pph[coveringArea]} = ${(pph[area] / pph[coveringArea]).toFixed(3)})` : ''
    return `headroom × ${AREA_LABEL[area]} ceiling / ${AREA_LABEL[coveringArea]} ceiling${ratio}, all resident/PA capacity eligible — unvalidated`
  }
  return `${Math.round(c.residentCreditFraction * 100)}% of resident/PA capacity eligible, ${c.headroomFactor} ${AREA_LABEL[area]} patients/hr per unit of headroom`
}

export function cloneCoverageConfig(config) {
  return JSON.parse(JSON.stringify(normalizeCoverageConfig(config)))
}

// ── Human-readable descriptions ──────────────────────────────────────────────

const SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' }

export function describeDays(days) {
  if (!days || !days.length || days.length === 7) return 'every day'
  const idx = days.map(d => WEEK_DAYS.indexOf(d)).sort((a, b) => a - b)
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)
  if (contiguous && idx.length > 2) return `${SHORT[WEEK_DAYS[idx[0]]]}–${SHORT[WEEK_DAYS[idx.at(-1)]]}`
  return idx.map(i => SHORT[WEEK_DAYS[i]]).join(', ')
}

export function describeRule(area, r) {
  const hours = r.fromHour === r.toHour ? '24 h' : `${pad(r.fromHour)}–${pad(r.toHour)}`
  const what = r.mode === COVERAGE_MODE.REQUIRED_DEDICATED
    ? `≥ ${r.minAttendings ?? 1} dedicated attending${(r.minAttendings ?? 1) === 1 ? '' : 's'}${r.basis === 'current-schedule' ? ' (kept from the current schedule)' : ''}`
    : r.mode === COVERAGE_MODE.CROSS_COVERED ? `cross-covered by ${AREA_LABEL[r.coveredBy] ?? r.coveredBy}`
      : r.mode === COVERAGE_MODE.CLOSED ? 'closed'
        : `flexible${r.coveredBy ? ` (else ${AREA_LABEL[r.coveredBy]} covers)` : ''}`
  return `${AREA_LABEL[area]} ${describeDays(r.days)} ${hours}: ${what}`
}

// One line per hard requirement in an area, for solver messages.
export function requirementLabels(config, area) {
  const ac = config?.areas?.[area]
  if (!ac) return []
  const out = []
  if (ac.default?.mode === COVERAGE_MODE.REQUIRED_DEDICATED) {
    out.push(`${AREA_LABEL[area]} ≥ ${ac.default.minAttendings ?? 1} dedicated attending outside other rules`)
  }
  for (const r of ac.rules ?? []) {
    if (r.mode === COVERAGE_MODE.REQUIRED_DEDICATED) out.push(r.label ? `${r.label} — ${describeRule(area, r)}` : describeRule(area, r))
  }
  return out
}

// ── Staff routing ────────────────────────────────────────────────────────────

const EXTENDER_ROLES = ['Resident', 'PA']

// The routing rule that applies to one resident/PA shift at (day, hour), or
// null. Later rules win, like coverage rules.
export function routingRuleFor(shift, config, day, hour) {
  if (!EXTENDER_ROLES.includes(shift.role_type)) return null
  let found = null
  for (const r of config?.staffRouting ?? []) {
    if (r.match?.team !== shift.team) continue
    if (r.match.roleTypes?.length && !r.match.roleTypes.includes(shift.role_type)) continue
    if (r.match.roleDetailSuffix && !String(shift.role_detail ?? '').endsWith(r.match.roleDetailSuffix)) continue
    if (r.days?.length && !r.days.includes(day)) continue
    if (!inWindow(hour, r.fromHour ?? 0, r.toHour ?? 0)) continue
    found = r
  }
  return found
}

// The day's shifts as they OPERATE at `hour`: a routed resident/PA appears
// with its destination team (and `sourceTeam` kept for display/audit);
// everything else is returned unchanged. The input shifts are not modified.
// With no routing rules this returns the same array.
export function effectiveShifts(shifts, config, day, hour) {
  if (!config?.staffRouting?.length) return shifts
  let changed = false
  const out = shifts.map(s => {
    if (!shiftCoversHour(s, hour)) return s
    const r = routingRuleFor(s, config, day, hour)
    if (!r || r.to.team === s.team) return s
    changed = true
    return { ...s, team: r.to.team, sourceTeam: s.team, routedArea: r.to.area }
  })
  return changed ? out : shifts
}

// Every resident/PA shift a routing rule moves, with the hours moved — for
// display and confirmation. [{ day, shift, rule, hours }]
export function routedShifts(config, days, shiftsForDay) {
  const out = []
  for (const day of days) {
    for (const s of shiftsForDay(day)) {
      const hours = []
      let rule = null
      for (let h = 0; h < 24; h++) {
        if (!shiftCoversHour(s, h)) continue
        const r = routingRuleFor(s, config, day, h)
        if (r) { hours.push(h); rule = r }
      }
      if (hours.length) out.push({ day, shift: s, rule, hours })
    }
  }
  return out
}

// Resident/PA shifts on duty while their recorded team's area is CLOSED
// and no routing rule places them anywhere: they would be credited nothing.
// These are the shifts that need the department to say where they work.
export function unroutedClosedAreaShifts(config, days, shiftsForDay, customTeams = []) {
  const out = []
  for (const day of days) {
    for (const s of shiftsForDay(day)) {
      if (!EXTENDER_ROLES.includes(s.role_type)) continue
      const area = teamArea(s.team, customTeams)
      const hours = []
      for (let h = 0; h < 24; h++) {
        if (!shiftCoversHour(s, h)) continue
        if (resolveCoverage(config, area, day, h).mode !== COVERAGE_MODE.CLOSED) continue
        if (!routingRuleFor(s, config, day, h)) hours.push(h)
      }
      if (hours.length) out.push({ day, shift: s, hours })
    }
  }
  return out
}

// ── Cross-coverage capacity ──────────────────────────────────────────────────
// capacity.js credits residents/PAs only through an attending ON THEIR TEAM;
// with no attending they count for nothing (solo FastTrack PAs aside).
// Under cross-coverage the covering area's attendings are RESPONSIBLE for
// the area and SUPERVISE its residents/PAs (so they are never reported as
// unsupervised). Whether that supervision adds modeled THROUGHPUT, and how
// much, is an explicit assumption (crossCoverCreditParams):
//
//   headroom = max(0, Σ covering attendings × covering ceiling − covering area's expected demand)
//   credit   = min(fraction × covered area's supervised resident/PA capacity,
//                  factor × headroom)
//
// The covering area's own expected demand is counted first (an accounting
// rule so one supervision ceiling is not counted twice — not a triage
// priority); only the ceiling left over can be credited to the covered area.
// `factor` converts covering-area headroom into covered-area patients: that
// conversion has NOT been established clinically, which is why the default
// (CONSERVATIVE) credits nothing, and the earlier ceiling-ratio conversion
// (CURRENT_RATIO, 0.8/2.1 for ERU) is kept only as an analysis scenario.
// Several areas covered by the same area at the same hour draw on the
// headroom in AREAS order. The covered area's demand stays its own; nothing
// is merged. Mirrored exactly by the solver (staffing/cpsat.py, crossCover).

function attendingsInArea(shifts, customTeams, area, hour) {
  let n = 0
  for (const s of shifts) {
    if (s.role_type === 'Attending' && shiftCoversHour(s, hour) && teamArea(s.team, customTeams) === area) n++
  }
  return n
}

export { attendingsInArea }

export function coveringHeadroom({ shifts, pph, customTeams = [], coveringArea, hour, coveringDemand }) {
  const ceiling = attendingCapacity(shifts, pph, customTeams, coveringArea, hour)
  return { ceiling, load: coveringDemand, headroom: Math.max(0, ceiling - coveringDemand) }
}

// Per-hour cross-coverage for every covered area in `areas`, sharing each
// covering area's headroom in AREAS order. demandFor(area) -> 24-array.
// Returns { [area]: { rule, ownAttendings, active, supervised, credit, headroomBefore } }.
export function crossCoverHour({ shifts, pph, customTeams = [], config, day, hour, areas, demandFor }) {
  const out = {}
  const remaining = {}
  for (const area of AREAS.filter(a => areas.includes(a))) {
    const rule = resolveCoverage(config, area, day, hour)
    const own = attendingsInArea(shifts, customTeams, area, hour)
    const active = crossCoverApplies(rule, own)
    const entry = { rule, ownAttendings: own, active, supervised: 0, credit: 0, headroomBefore: 0, creditMode: null }
    if (active) {
      entry.supervised = extenderCapacity(shifts, pph, customTeams, area, hour)
      if (remaining[rule.coveredBy] == null) {
        remaining[rule.coveredBy] = coveringHeadroom({
          shifts, pph, customTeams, coveringArea: rule.coveredBy, hour,
          coveringDemand: demandFor(rule.coveredBy)[hour] ?? 0,
        }).headroom
      }
      const { mode, residentCreditFraction, headroomFactor } = crossCoverCreditParams(config, area, rule.coveredBy, pph)
      entry.creditMode = mode
      entry.headroomBefore = remaining[rule.coveredBy]
      entry.credit = Math.min(residentCreditFraction * entry.supervised, headroomFactor * remaining[rule.coveredBy])
      if (headroomFactor > 0) remaining[rule.coveredBy] = Math.max(0, remaining[rule.coveredBy] - entry.credit / headroomFactor)
    }
    out[area] = entry
  }
  return out
}

// Residents/PAs on duty in an area-hour whose work nobody supervises: no
// attending on their team and no cross-coverage. Returns their capacity
// (patients/hr) that the model credits as zero — reported, never hidden.
export function unsupervisedExtenderCapacity(shifts, pph, customTeams, area, hour) {
  const teams = new Set()
  for (const s of shifts) {
    if ((s.role_type === 'Resident' || s.role_type === 'PA') && shiftCoversHour(s, hour) && teamArea(s.team, customTeams) === area) teams.add(s.team)
  }
  let total = 0
  for (const team of teams) {
    if (attendingCountForTeam(shifts, team, hour) > 0) continue
    const teamShifts = shifts.filter(s => s.team === team)
    total += extenderCapacity(teamShifts, pph, customTeams, area, hour)
  }
  return total
}

// ── Reporting ────────────────────────────────────────────────────────────────

// Hours of `shift` inside clock hour h (0..1), on the circular day template.
function overlapHours(s, h) {
  const a = h * 60, b = a + 60
  const segs = s.endMins <= 1440 ? [[s.startMins, s.endMins]] : [[s.startMins, 1440], [0, s.endMins - 1440]]
  return segs.reduce((t, [x, y]) => t + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0) / 60
}

function blankSummary() {
  return {
    attendingHours: 0,
    // Operational rule
    configuredHours: { REQUIRED_DEDICATED: 0, CROSS_COVERED: 0, CLOSED: 0, FLEXIBLE: 0 },
    requiredAttendingHours: 0,   // Σ minAttendings over REQUIRED_DEDICATED hours
    requiredAttendingHoursMet: 0, // Σ min(attendings on, minAttendings) over those hours
    voluntaryAttendingHours: 0,  // attending-hours beyond the rule (optimizer's / schedule's choice)
    requiredShortfallHours: 0,   // REQUIRED_DEDICATED hours with fewer attendings than the rule
    // How each area-hour was actually covered
    hoursDedicated: 0,           // own attending on
    hoursCrossCovered: 0,        // no own attending; covering area responsible
    hoursFlexibleUncovered: 0,   // FLEXIBLE, no own attending, no covering area
    hoursClosedUncovered: 0,     // CLOSED, no own attending
    hoursRequiredUncovered: 0,   // REQUIRED_DEDICATED with NO attending at all
    // Patients (patient-hours / week)
    demand: 0, served: 0, unmet: 0, surplus: 0,
    unmetWhenDedicated: 0,
    crossCovered: { demand: 0, served: 0, unmet: 0, credit: 0 },
    flexibleUncovered: { demand: 0, unmet: 0 },
    closed: { demand: 0, unmet: 0 },
    unsupervisedExtenderPphHours: 0, // resident/PA capacity nobody supervises (credited 0)
    unsupervisedExtenderHours: 0,
    // As a COVERING area: other areas' patients handled under this area's attendings
    coveringLoad: {},            // { [coveredArea]: patient-hours served under cross-coverage }
  }
}

// Per-area operational coverage summary for a week analysed WITH a coverage
// config (analyzeWeek({ ..., coverage })). Attending-hours are exact shift
// overlap (a :30 shift counts half an hour); hour counts are area-hours.
export function operationalCoverageSummary({ week, days, shiftsForDay, customTeams = [] }) {
  const out = Object.fromEntries(week.areas.map(a => [a, blankSummary()]))
  week.days.forEach(({ analysis }, di) => {
    const shifts = shiftsForDay(days[di]).filter(s => s.role_type === 'Attending')
    for (const area of week.areas) {
      const m = out[area]
      const onArea = shifts.filter(s => teamArea(s.team, customTeams) === area)
      for (let h = 0; h < 24; h++) {
        const row = analysis.hours[h].byArea[area]
        const cov = row.coverage
        if (!cov) continue
        const n = onArea.reduce((t, s) => t + overlapHours(s, h), 0)
        const { demand: d, capacity: c } = row
        const unmet = Math.max(0, d - c)
        m.attendingHours += n
        m.configuredHours[cov.mode]++
        m.demand += d; m.served += Math.min(d, c); m.unmet += unmet; m.surplus += Math.max(0, c - d)
        if (cov.mode === COVERAGE_MODE.REQUIRED_DEDICATED) {
          m.requiredAttendingHours += cov.minAttendings
          m.requiredAttendingHoursMet += Math.min(n, cov.minAttendings)
          if (cov.ownAttendings < cov.minAttendings) m.requiredShortfallHours++
        }
        if (cov.ownAttendings > 0) {
          m.hoursDedicated++
          m.unmetWhenDedicated += unmet
        } else if (cov.crossCovered) {
          m.hoursCrossCovered++
          m.crossCovered.demand += d; m.crossCovered.served += Math.min(d, c); m.crossCovered.unmet += unmet
          m.crossCovered.credit += cov.crossCoverCredit
          const load = out[cov.coveredBy] ?? null
          if (load) load.coveringLoad[area] = (load.coveringLoad[area] ?? 0) + Math.min(d, c)
        } else if (cov.mode === COVERAGE_MODE.CLOSED) {
          m.hoursClosedUncovered++
          m.closed.demand += d; m.closed.unmet += unmet
        } else if (cov.mode === COVERAGE_MODE.REQUIRED_DEDICATED) {
          m.hoursRequiredUncovered++
        } else {
          m.hoursFlexibleUncovered++
          m.flexibleUncovered.demand += d; m.flexibleUncovered.unmet += unmet
        }
        if (cov.unsupervisedExtender > 0) {
          m.unsupervisedExtenderPphHours += cov.unsupervisedExtender
          m.unsupervisedExtenderHours++
        }
      }
      m.voluntaryAttendingHours = m.attendingHours - m.requiredAttendingHoursMet
    }
  })
  // (A covering area outside the analysed scope has no entry, so its
  // coveringLoad is not reported; the covered area's crossCovered figures
  // still are.)
  return out
}

// ── ERU dedicated-coverage scenarios ─────────────────────────────────────────
// A scenario is just a rewrite of the ERU rules in the same coverage config
// (no second rule system): a weekday window, a weekend window, optional
// day-specific exceptions, and what happens outside the window.
//   window: { fromHour, toHour } (from === to = 24 h) or null (no dedicated ERU)
//   outside: 'CROSS_COVERED' (default: Main responsible, no dedicated ERU
//            placed) or 'FLEXIBLE' (allocator may add ERU hours; Main covers
//            when it doesn't)
// These presets are ANALYSIS scenarios. Only "current" describes practice,
// and it is today's schedule — not a clinically validated minimum.
export const ERU_SCENARIO_PRESETS = {
  current: {
    label: 'Current ERU coverage', short: 'Current',
    weekday: { fromHour: 9, toHour: 1 }, weekend: { fromHour: 11, toHour: 19 },
    note: "Today's ERU dedicated attending schedule. Not a clinically validated minimum.",
  },
  coreDaytime: {
    label: 'Core daytime (illustrative)', short: 'Core daytime',
    weekday: { fromHour: 9, toHour: 19 }, weekend: { fromHour: 11, toHour: 19 },
    note: 'Analysis scenario only — not clinically required or recommended.',
  },
  extendedEvening: {
    label: 'Extended evening (illustrative)', short: 'Extended evening',
    weekday: { fromHour: 9, toHour: 23 }, weekend: { fromHour: 11, toHour: 19 },
    note: 'Analysis scenario only — not clinically required or recommended.',
  },
  allDay: {
    label: '24/7 dedicated ERU', short: '24/7',
    weekday: { fromHour: 0, toHour: 0 }, weekend: { fromHour: 0, toHour: 0 },
    note: 'Analysis scenario only: one dedicated ERU attending at all hours.',
  },
}

const WEEKDAY_NAMES = WEEK_DAYS.slice(0, 5)
const WEEKEND_NAMES = WEEK_DAYS.slice(5)

export function windowHours(w) {
  if (!w) return 0
  return w.fromHour === w.toHour ? 24 : (w.toHour - w.fromHour + 24) % 24
}

export function describeWindow(w) {
  if (!w) return 'none'
  return w.fromHour === w.toHour ? '24 h' : `${pad(w.fromHour)}–${pad(w.toHour)}`
}

// config with ERU's rules replaced by the scenario's windows. Everything
// else (Main, FastTrack, routing, credit assumption, ERU maximum) is kept.
export function withEruDedicatedCoverage(config, { weekday, weekend, exceptions = [], outside = COVERAGE_MODE.CROSS_COVERED, name = 'scenario', basis = 'scenario' }) {
  const c = cloneCoverageConfig(config)
  const eru = c.areas.eru ?? (c.areas.eru = { default: {}, rules: [], maxAttendings: STRUCTURAL_MAX_ATTENDINGS.eru })
  eru.default = outside === COVERAGE_MODE.FLEXIBLE
    ? { mode: COVERAGE_MODE.FLEXIBLE, coveredBy: 'main' }
    : { mode: COVERAGE_MODE.CROSS_COVERED, coveredBy: 'main' }
  const rule = (days, w, what) => ({
    days, fromHour: w.fromHour, toHour: w.toHour, mode: COVERAGE_MODE.REQUIRED_DEDICATED, minAttendings: 1,
    label: `ERU dedicated coverage — ${name} (${what})`, basis,
  })
  eru.rules = [
    ...(weekday ? [rule(WEEKDAY_NAMES, weekday, 'weekdays')] : []),
    ...(weekend ? [rule(WEEKEND_NAMES, weekend, 'weekend')] : []),
    // Exceptions come last so they win: a window, or { none: true } for no
    // dedicated ERU on those days (the outside mode applies instead).
    ...exceptions.map(x => (x.none
      ? { days: x.days, fromHour: 0, toHour: 0, ...eru.default, label: `ERU exception — ${name}` }
      : rule(x.days, x, `exception ${x.days.map(d => d.slice(0, 3)).join('/')}`))),
  ]
  return c
}

export function eruScenarioConfig(config, presetKey, overrides = {}) {
  const p = ERU_SCENARIO_PRESETS[presetKey]
  return withEruDedicatedCoverage(config, {
    weekday: p.weekday, weekend: p.weekend, name: p.short,
    basis: presetKey === 'current' ? 'current-schedule' : 'scenario', ...overrides,
  })
}

// Can the shift menu staff an area's dedicated windows with at most
// `maxAttendings` (1) on at once and no dedicated shift reaching into
// blocked (cross-covered/closed) hours? Per day: the fewest attending-hours
// of non-overlapping menu shifts that cover every required hour and stay
// inside allowed hours. Only for areas limited to one attending at a time.
// Returns { feasible, minHours, byDay: [{ day, feasible, hours, shifts, required }] }.
export function dedicatedWindowFeasibility(config, area, days, patterns) {
  if (effectiveMaxAttendings(config, area) !== 1) return null
  const mask = p => Array.from({ length: p.length }, (_, i) => (p.start + i) % 24).reduce((m, h) => m | (1 << h), 0)
  const byDay = days.map(day => {
    let required = 0, allowed = 0
    for (let h = 0; h < 24; h++) {
      const r = resolveCoverage(config, area, day, h)
      if (r.mode === COVERAGE_MODE.REQUIRED_DEDICATED) required |= 1 << h
      if (!blocksDedicatedPlacement(r.mode)) allowed |= 1 << h
    }
    if (!required) return { day, feasible: true, hours: 0, shifts: [], required: 0 }
    const cands = patterns.map(p => ({ p, m: mask(p) })).filter(c => (c.m & ~allowed) === 0 && (c.m & required))
    let best = null
    const dfs = (i, used, covered, hours, chosen) => {
      if ((covered & required) === required) {
        if (!best || hours < best.hours) best = { hours, shifts: [...chosen] }
        return
      }
      if (best && hours >= best.hours) return
      for (let j = i; j < cands.length; j++) {
        const c = cands[j]
        if (c.m & used) continue
        chosen.push(c.p)
        dfs(j + 1, used | c.m, covered | c.m, hours + c.p.length, chosen)
        chosen.pop()
      }
    }
    dfs(0, 0, 0, 0, [])
    const requiredHours = [...Array(24).keys()].filter(h => required & (1 << h)).length
    return best
      ? { day, feasible: true, hours: best.hours, shifts: best.shifts, required: requiredHours }
      : { day, feasible: false, hours: null, shifts: [], required: requiredHours }
  })
  const feasible = byDay.every(d => d.feasible)
  return { feasible, minHours: feasible ? byDay.reduce((t, d) => t + d.hours, 0) : null, byDay }
}
