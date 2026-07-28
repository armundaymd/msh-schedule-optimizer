// In dev, Vite proxies '/api' to the local Flask server (see vite.config.js).
// In production the frontend and backend are separate Render services, so
// requests need the backend's absolute URL. Override with VITE_API_BASE at
// build time if the backend URL ever changes.
const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV ? '' : 'https://msh-schedule-optimizer.onrender.com')

export async function fetchDemand() {
  const r = await fetch(`${API_BASE}/api/demand`)
  if (!r.ok) throw new Error('demand fetch failed')
  return r.json()
}

export async function fetchSchedule() {
  const r = await fetch(`${API_BASE}/api/schedule`)
  if (!r.ok) throw new Error('schedule fetch failed')
  return r.json()
}

export async function fetchSummary() {
  const r = await fetch(`${API_BASE}/api/summary`)
  if (!r.ok) throw new Error('summary fetch failed')
  return r.json()
}

export async function postRefresh() {
  const r = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' })
  if (!r.ok) throw new Error('refresh failed')
  return r.json()
}

export async function fetchDemandCI() {
  const r = await fetch(`${API_BASE}/api/demand-ci`)
  if (!r.ok) return null
  const data = await r.json()
  return data?.status === 'not_run' ? null : data
}

export async function fetchValidation() {
  const r = await fetch(`${API_BASE}/api/validation`)
  if (!r.ok) return null
  const data = await r.json()
  return data?.status === 'not_run' ? null : data
}
