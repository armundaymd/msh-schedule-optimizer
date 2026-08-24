// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

import { normalizeShifts } from './hooks/useScheduleState'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

// Persisted scenario payload shape:
//   { shifts: { Monday: [...], ... }, pph, costRates, customTeams, target, generatorSettings? }
// Shift rows use the export-row convention (day_type, team, role_type,
// role_detail, resident_level, start_time, end_time) — never the internal
// id/startMins/endMins fields, which are re-derived on load.

function toRow(shift) {
  return {
    day_type: shift.day,
    team: shift.team,
    role_type: shift.role_type,
    role_detail: shift.role_detail ?? '',
    resident_level: shift.resident_level ?? '',
    start_time: shift.start_time,
    end_time: shift.end_time,
  }
}

// Builds the payload to POST when saving a scenario, from live app state.
export function buildScenarioPayload({ schedState, pph, costRates, customTeams, target, generatorSettings }) {
  const shifts = {}
  for (const day of DAYS) {
    shifts[day] = schedState.getShiftsForDay(day).map(toRow)
  }
  const payload = { shifts, pph, costRates, customTeams, target }
  if (generatorSettings) payload.generatorSettings = generatorSettings
  return payload
}

// Converts a loaded payload's row-format shifts back into the internal
// normalized shape (id/startMins/endMins) useScheduleState.loadSnapshot expects.
export function scenarioPayloadToSnapshot(payload) {
  const snap = {}
  const shifts = payload?.shifts ?? {}
  for (const day of Object.keys(shifts)) {
    snap[day] = normalizeShifts(shifts[day].map(row => ({ ...row, day: row.day_type })))
  }
  return snap
}
