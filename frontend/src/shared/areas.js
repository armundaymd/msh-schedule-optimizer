// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

// Clinical areas and analysis scopes — the single place these are defined.
//
// An AREA is a real clinical area with its own teams, demand series, and
// PPH settings. Two spellings exist and both are load-bearing:
//   key   ('main'/'fasttrack'/'eru') — capacity.js and the pph object keys
//   label ('Main'/'FastTrack'/'ERU') — demand/CI JSON keys and customTeams[].area
//
// A SCOPE is a named collection of one or more areas to analyze/optimize
// together. Combined scopes (Main + ERU, Whole ED) are NOT areas: they own no
// teams, demand, or schedule data — every scope-level number is derived by
// aggregating its component areas. Single-area scope keys are identical to
// the area keys, so any existing area key is already a valid scope.

export const STATIC_MAIN = ['Green', 'Red', 'Blue']

export const AREAS = ['main', 'fasttrack', 'eru']
export const AREA_LABEL = { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }
export const AREA_KEY = { Main: 'main', FastTrack: 'fasttrack', ERU: 'eru' }
export const AREA_BASE_TEAMS = { main: STATIC_MAIN, fasttrack: ['FastTrack'], eru: ['ERU'] }

export const SCOPES = {
  main: ['main'],
  fasttrack: ['fasttrack'],
  eru: ['eru'],
  mainEru: ['main', 'eru'],
  wholeEd: ['main', 'fasttrack', 'eru'],
}
export const SCOPE_ORDER = ['main', 'fasttrack', 'eru', 'mainEru', 'wholeEd']
export const SCOPE_LABEL = {
  main: 'Main', fasttrack: 'FastTrack', eru: 'ERU',
  mainEru: 'Main + ERU', wholeEd: 'Whole ED',
}

// Resolve a scope key, an area key, or an explicit array of area keys to the
// list of component area keys. Unknown keys fall back to Main, matching the
// `?? 'main'` fallback used everywhere an area was previously resolved.
export function scopeAreas(scope) {
  if (Array.isArray(scope)) return scope
  return SCOPES[scope] ?? SCOPES.main
}

export function isCombinedScope(scope) {
  return scopeAreas(scope).length > 1
}

// Named teams (static + custom) that belong to one area.
export function teamsInArea(area, customTeams = []) {
  return [
    ...(AREA_BASE_TEAMS[area] ?? []),
    ...customTeams.filter(t => t.area === AREA_LABEL[area]).map(t => t.name),
  ]
}
