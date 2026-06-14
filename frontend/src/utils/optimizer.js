const SNAP = 30
const CUSTOM_COLORS = ['#0d9488','#ec4899','#f59e0b','#6366f1','#84cc16','#06b6d4','#f43f5e','#64748b']
const STATIC_MAIN = ['Green', 'Red', 'Blue']

function snap(m) { return Math.round(m / SNAP) * SNAP }

function minsToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2,'0')}:${String(norm % 60).padStart(2,'0')}`
}

function shiftCoversHour(s, h) {
  const hStart = h * 60, hEnd = hStart + 60
  if (s.endMins <= 1440) return s.startMins < hEnd && s.endMins > hStart
  const wrapEnd = s.endMins - 1440
  return s.startMins < hEnd || hStart < wrapEnd
}

function teamArea(teamName, customTeams = []) {
  if (STATIC_MAIN.includes(teamName)) return 'main'
  if (teamName === 'FastTrack') return 'fasttrack'
  if (teamName === 'ERU') return 'eru'
  const ct = customTeams.find(t => t.name === teamName)
  if (!ct) return 'main'
  return ct.area === 'FastTrack' ? 'fasttrack' : ct.area === 'ERU' ? 'eru' : 'main'
}

function capAt(shifts, pph, customTeams, h) {
  let main = 0, ft = 0, eru = 0
  for (const s of shifts) {
    if (s.role_type !== 'Attending') continue
    if (!shiftCoversHour(s, h)) continue
    const area = teamArea(s.team, customTeams)
    if (area === 'main') main++
    else if (area === 'fasttrack') ft++
    else if (area === 'eru') eru++
  }
  return main * pph.main + ft * pph.fasttrack + eru * pph.eru
}

function groupConsecutive(hours) {
  if (!hours.length) return []
  const groups = [[hours[0]]]
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === hours[i - 1] + 1) groups[groups.length - 1].push(hours[i])
    else groups.push([hours[i]])
  }
  return groups
}

export function getOverflowHours(shifts, demand, pph, day, customTeams) {
  const series = demand ? (demand.Main?.by_dow?.[day] ?? demand.Main?.overall ?? []) : Array(24).fill(0)
  return Array.from({ length: 24 }, (_, h) => h)
    .filter(h => (series[h] ?? 0) > capAt(shifts, pph, customTeams, h))
}

export function runOptimizer(shifts, demand, pph, day, customTeams) {
  const series = demand ? (demand.Main?.by_dow?.[day] ?? demand.Main?.overall ?? []) : Array(24).fill(0)

  const work = shifts.map(s => ({ ...s }))
  const allCustom = [...customTeams]
  const changes = []
  const newTeams = []

  function overflowAt(h) { return Math.max(0, (series[h] ?? 0) - capAt(work, pph, allCustom, h)) }
  function overflowHours() { return Array.from({ length: 24 }, (_, h) => h).filter(h => overflowAt(h) > 0) }

  const totalOverflow = overflowHours().length

  // Step 1 — extend end times of attending shifts ending within 2h before overflow
  let dirty = true
  while (dirty) {
    dirty = false
    for (const h of overflowHours()) {
      if (overflowAt(h) <= 0) continue
      const hMins = h * 60
      const candidates = work
        .filter(s => s.role_type === 'Attending' && s.endMins > hMins - 120 && s.endMins <= hMins)
        .sort((a, b) => b.endMins - a.endMins)
      for (const shift of candidates) {
        if (overflowAt(h) <= 0) break
        const origEnd = shift._origEnd ?? shift.endMins
        const target = Math.min(hMins + 60, origEnd + 4 * 60)
        if (target > shift.endMins) {
          const oldTime = minsToTime(shift.endMins)
          if (!shift._origEnd) shift._origEnd = shift.endMins
          shift.endMins = target
          shift.end_time = minsToTime(target)
          changes.push(`Extended ${shift.team} attending shift end from ${oldTime} to ${shift.end_time}`)
          dirty = true
        }
      }
    }
  }

  // Step 2 — pull start times of attending shifts starting within 2h after overflow
  dirty = true
  while (dirty) {
    dirty = false
    for (const h of overflowHours()) {
      if (overflowAt(h) <= 0) continue
      const hMins = h * 60
      const candidates = work
        .filter(s => s.role_type === 'Attending' && s.startMins >= hMins + 60 && s.startMins < hMins + 180)
        .sort((a, b) => a.startMins - b.startMins)
      for (const shift of candidates) {
        if (overflowAt(h) <= 0) break
        const origStart = shift._origStart ?? shift.startMins
        const target = snap(Math.max(hMins, origStart - 2 * 60))
        if (target < shift.startMins) {
          const oldTime = minsToTime(shift.startMins)
          if (!shift._origStart) shift._origStart = shift.startMins
          shift.startMins = target
          shift.start_time = minsToTime(target)
          changes.push(`Moved ${shift.team} attending shift start from ${oldTime} to ${shift.start_time}`)
          dirty = true
        }
      }
    }
  }

  // Step 3 — add shifts to existing teams for remaining overflow windows
  const mainTeams = [
    ...STATIC_MAIN,
    ...allCustom.filter(t => t.area === 'Main').map(t => t.name),
  ]

  for (const window of groupConsecutive(overflowHours())) {
    if (window.every(h => overflowAt(h) <= 0)) continue
    const wStart = window[0] * 60
    const wEnd   = (window[window.length - 1] + 1) * 60
    const sStart = snap(Math.max(0, wStart - 60))
    const sEnd   = Math.max(snap(Math.min(1440, wEnd + 60)), sStart + 4 * 60)

    // pick team with fewest attending coverage in the window
    let bestTeam = mainTeams[0] ?? 'Green'
    let minCov = Infinity
    for (const name of mainTeams) {
      const cov = work.filter(s => s.team === name && s.role_type === 'Attending' && window.some(h => shiftCoversHour(s, h))).length
      if (cov < minCov) { minCov = cov; bestTeam = name }
    }

    const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    work.push({ id, day, team: bestTeam, role_type: 'Attending', role_detail: 'Attending',
      start_time: minsToTime(sStart), end_time: minsToTime(sEnd), startMins: sStart, endMins: sEnd })
    changes.push(`Added attending shift to ${bestTeam}: ${minsToTime(sStart)}–${minsToTime(sEnd)}`)
  }

  // Step 4 — add a new optimized team for any remaining overflow
  const stillOverflow = overflowHours()
  if (stillOverflow.length > 0) {
    const usedColors = new Set(allCustom.map(t => t.color))
    const color = CUSTOM_COLORS.find(c => !usedColors.has(c)) ?? CUSTOM_COLORS[0]
    const optN = allCustom.filter(t => t.name.startsWith('Optimized Team')).length + 1
    const teamName = `Optimized Team ${optN}`
    const team = { name: teamName, color, area: 'Main' }
    allCustom.push(team)
    newTeams.push(team)

    for (const window of groupConsecutive(stillOverflow)) {
      const wStart = window[0] * 60
      const wEnd   = (window[window.length - 1] + 1) * 60
      const sStart = snap(Math.max(0, wStart - 60))
      const sEnd   = Math.max(snap(Math.min(1440, wEnd + 60)), sStart + 4 * 60)
      const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      work.push({ id, day, team: teamName, role_type: 'Attending', role_detail: 'Attending',
        start_time: minsToTime(sStart), end_time: minsToTime(sEnd), startMins: sStart, endMins: sEnd })
      changes.push(`Added new team ${teamName} with attending coverage ${minsToTime(sStart)}–${minsToTime(sEnd)}`)
    }
  }

  const resolvedCount = totalOverflow - overflowHours().length

  // strip internal tracking fields
  work.forEach(s => { delete s._origEnd; delete s._origStart })

  return { newShifts: work, newTeams, changes, resolvedCount, totalOverflow }
}
