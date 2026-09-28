// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

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

// Whether this server allows "Refresh data" at all (it needs an ADMIN_TOKEN
// configured server-side). Any failure reads as disabled.
export async function fetchRefreshStatus() {
  try {
    const r = await fetch(`${API_BASE}/api/refresh-status`)
    if (!r.ok) return { enabled: false }
    return await r.json()
  } catch {
    return { enabled: false }
  }
}

// The admin password for Refresh, remembered for this browser session only.
const ADMIN_TOKEN_KEY = 'edso.adminToken'
function storedToken() {
  try { return window.sessionStorage.getItem(ADMIN_TOKEN_KEY) } catch { return null }
}
function rememberToken(t) {
  try { if (t) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, t); else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY) } catch { /* private mode */ }
}

// Throws an Error whose message is the backend's explanation. A 409 means the
// refresh would shrink the stored dataset a lot; the user must confirm first.
// `token`: the admin password (v3 asks for it in a masked field); without
// one, the session's remembered password is used, else the browser prompts.
export async function postRefresh(token = null) {
  let t = token || storedToken()
  if (!t) {
    t = window.prompt('Admin password to refresh the data:')
    if (!t) throw new Error('Refresh cancelled — existing data kept.')
  }
  const headers = { 'X-Admin-Token': t }
  let r = await fetch(`${API_BASE}/api/refresh`, { method: 'POST', headers })
  if (r.status === 401 || r.status === 403) {
    rememberToken(null)
    const body = await r.json().catch(() => ({}))
    throw new Error(body.detail || 'Refresh not allowed')
  }
  rememberToken(t)
  if (r.status === 409) {
    const { detail } = await r.json()
    if (!window.confirm(`${detail}\n\nReplace the existing data anyway?`)) {
      throw new Error('Refresh cancelled — existing data kept.')
    }
    r = await fetch(`${API_BASE}/api/refresh?force=true`, { method: 'POST', headers })
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.detail || 'Refresh failed')
  }
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

// version: 'legacy' | 'v2' — scenarios saved in one version are listed only
// in that version.
export async function fetchScenarios(version) {
  const r = await fetch(`${API_BASE}/api/scenarios?version=${encodeURIComponent(version)}`)
  if (!r.ok) throw new Error('scenarios fetch failed')
  return r.json()
}

export async function createScenario(version, name, payload) {
  const r = await fetch(`${API_BASE}/api/scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, name, payload }),
  })
  if (!r.ok) throw new Error('scenario create failed')
  return r.json()
}

export async function deleteScenario(id) {
  const r = await fetch(`${API_BASE}/api/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!r.ok) throw new Error('scenario delete failed')
}

// Staffing resource allocation (server: staffing/, OR-Tools CP-SAT). The
// instance comes from shared/staffingPlan.js buildPlanInstance. Resolves
// with the solver's result, including infeasible/timeout results (those are
// answers, not errors); rejects only on transport/validation failure.
export async function postStaffingPlan(instance) {
  const r = await fetch(`${API_BASE}/api/staffing-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(instance),
  })
  if (!r.ok) {
    const detail = await r.json().catch(() => null)
    throw new Error(detail?.detail?.[0]?.msg ?? `staffing plan request failed (${r.status})`)
  }
  return r.json()
}
