// Visual language for coverage statuses (see shared/coverageInsights.js),
// shared by the timeline coverage ribbon, the scope breakdown readout, and
// the coverage-issues list so one colour means one thing everywhere.

const MAX_MAGNITUDE = 6 // deviation (patients/hr) at which color saturates

export const STATUS_TEXT = {
  deficit: 'short',
  adequate: 'covered',
  excess: 'excess capacity',
  masked: 'total covered, but an area is short',
}

// Tailwind text colour per status, for numbers and icons.
export const STATUS_TEXT_CLASS = {
  deficit: 'text-red-400',
  masked: 'text-red-400',
  adequate: 'text-green-400',
  excess: 'text-sky-400',
}

// Solid swatch per status, for legend dots.
export const STATUS_SWATCH = {
  deficit: 'rgba(239,68,68,0.75)',
  adequate: 'rgba(34,197,94,0.45)',
  excess: 'rgba(56,189,248,0.6)',
  masked: 'repeating-linear-gradient(135deg, rgba(239,68,68,0.9) 0 2px, rgba(34,197,94,0.35) 2px 4px)',
}

// Cell background for a status + net. Deficit and excess deepen with
// magnitude; adequate is flat. 'masked' (aggregate rows only) is red-striped
// over the adequate colour: the total is fine, but an area underneath isn't.
export function statusBackground(status, net) {
  const mag = Math.min(Math.abs(net), MAX_MAGNITUDE) / MAX_MAGNITUDE
  const alpha = 0.2 + mag * 0.55
  if (status === 'deficit') return `rgba(239,68,68,${alpha})`
  if (status === 'excess') return `rgba(56,189,248,${alpha})`
  if (status === 'masked') return 'repeating-linear-gradient(135deg, rgba(239,68,68,0.85) 0 3px, rgba(34,197,94,0.22) 3px 6px)'
  return 'rgba(34,197,94,0.22)'
}
