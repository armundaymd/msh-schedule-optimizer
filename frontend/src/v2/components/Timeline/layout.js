export const LANE_HEIGHT = 24
export const ROW_HEADER_W = 96

// True if two shifts share at least one minute on the 24-h clock.
function overlaps(a, b) {
  const aON = a.endMins > 1440
  const bON = b.endMins > 1440
  if (!aON && !bON) return a.startMins < b.endMins && a.endMins > b.startMins
  if (aON && bON) return true
  const [on, off] = aON ? [a, b] : [b, a]
  const wrapEnd = on.endMins - 1440
  return on.startMins < off.endMins || wrapEnd > off.startMins
}

// Greedy interval-graph colouring: sort by startMins, assign minimum lane
// that doesn't conflict with already-placed shifts. Transfers unchanged
// from the vertical layout's TeamColumn.jsx — only the geometry it feeds
// (horizontal lanes-in-a-column -> vertical lanes-in-a-row) changed
// (PHASE 5, 5.1).
export function assignLanes(shifts) {
  if (!shifts.length) return { lanes: {}, numLanes: 1 }
  const sorted = [...shifts].sort((a, b) => a.startMins - b.startMins)
  const lanes = {}
  for (const s of sorted) {
    const usedLanes = new Set(
      sorted.filter(o => o.id !== s.id && lanes[o.id] !== undefined && overlaps(s, o)).map(o => lanes[o.id])
    )
    let lane = 0
    while (usedLanes.has(lane)) lane++
    lanes[s.id] = lane
  }
  const numLanes = Math.max(...Object.values(lanes)) + 1
  return { lanes, numLanes }
}
