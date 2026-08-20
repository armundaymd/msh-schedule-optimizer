// In dev, Vite proxies '/api' to the local FastAPI server (see vite.config.js).
// In production the frontend and backend are separate Coolify services, so
// requests need the backend's absolute URL, supplied at build time via
// VITE_API_BASE (set this in the Coolify frontend service's build args/env).
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

if (!import.meta.env.DEV && !import.meta.env.VITE_API_BASE) {
  console.warn(
    'VITE_API_BASE is not set — API requests will be relative to the frontend origin.'
  )
}

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
