export async function fetchDemand() {
  const r = await fetch('/api/demand')
  if (!r.ok) throw new Error('demand fetch failed')
  return r.json()
}

export async function fetchSchedule() {
  const r = await fetch('/api/schedule')
  if (!r.ok) throw new Error('schedule fetch failed')
  return r.json()
}

export async function fetchSummary() {
  const r = await fetch('/api/summary')
  if (!r.ok) throw new Error('summary fetch failed')
  return r.json()
}

export async function postRefresh() {
  const r = await fetch('/api/refresh', { method: 'POST' })
  if (!r.ok) throw new Error('refresh failed')
  return r.json()
}
