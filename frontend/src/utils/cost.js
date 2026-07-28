// Shift cost modeling — Attending and PA only (no resident rate, per product
// decision). Optional/toggle-able: callers gate this behind costModeEnabled.

const RATE_KEY = { Attending: 'attending', PA: 'pa' }

export function computeShiftCost(shifts, costRates) {
  let total = 0
  for (const s of shifts) {
    const key = RATE_KEY[s.role_type]
    if (!key) continue
    const hours = (s.endMins - s.startMins) / 60
    total += hours * (costRates[key] ?? 0)
  }
  return total
}
