// Committed real-data snapshot used by validation and analysis runs:
// the schedule CSV the database is loaded from (it carries resident_level)
// and the pipeline's processed demand.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { normalizeShifts } from '../src/shared/hooks/useScheduleState'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SCHEDULE_CSV = 'data/Current_Schedule_Block.csv'
export const DEMAND_JSON = 'data/processed/demand.json'

// Simple CSV: no quoted fields.
export function loadCurrentSchedule() {
  const [header, ...rows] = readFileSync(path.join(REPO_ROOT, SCHEDULE_CSV), 'utf8').trim().split(/\r?\n/)
  const cols = header.split(',')
  return normalizeShifts(rows.map(line => {
    const v = Object.fromEntries(line.split(',').map((x, i) => [cols[i], x]))
    return { day: v.day_type, team: v.team, role_type: v.role_type, role_detail: v.role_detail,
      resident_level: v.resident_level || null, start_time: v.start_time, end_time: v.end_time }
  }))
}

export function loadDemand() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, DEMAND_JSON), 'utf8'))
}
