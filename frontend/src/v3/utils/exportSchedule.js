const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

const COLUMNS = ['day_type', 'team', 'role_type', 'role_detail', 'resident_level', 'start_time', 'end_time']

// Flat rows across all 7 days, in the same column convention as
// data/Current_Schedule_Block.csv / schema.sql — internal-only fields
// (id, startMins, endMins) are dropped.
export function buildExportRows(schedState) {
  const rows = []
  for (const day of DAYS) {
    for (const s of schedState.getShiftsForDay(day)) {
      rows.push({
        day_type: day,
        team: s.team,
        role_type: s.role_type,
        role_detail: s.role_detail ?? '',
        resident_level: s.resident_level ?? '',
        start_time: s.start_time,
        end_time: s.end_time,
      })
    }
  }
  return rows
}

function csvEscape(val) {
  const str = String(val ?? '')
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

export function toCSV(rows) {
  const lines = [COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(COLUMNS.map(c => csvEscape(row[c])).join(','))
  }
  return lines.join('\n')
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function exportScheduleAs(schedState, format) {
  const rows = buildExportRows(schedState)
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === 'csv') {
    downloadFile(`schedule-${stamp}.csv`, toCSV(rows), 'text/csv')
  } else {
    downloadFile(`schedule-${stamp}.json`, JSON.stringify(rows, null, 2), 'application/json')
  }
}
