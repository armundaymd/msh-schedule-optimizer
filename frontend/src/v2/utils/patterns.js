// Default shift pattern menu — the patterns actually in use today, so a
// generated schedule is implementable without inventing new shift times.
export const DEFAULT_PATTERNS = [
  { start: 7,  length: 8 },
  { start: 9,  length: 8 },
  { start: 11, length: 8 },
  { start: 15, length: 8 },
  { start: 17, length: 8 },
  { start: 23, length: 8 },
]

export const ALLOWED_LENGTHS = [8, 9, 10, 12]

// "Any start hour, N-hour only" — the comparison against DEFAULT_PATTERNS is
// the value of shift-structure flexibility.
export function anyStartPatterns(length = 8) {
  return Array.from({ length: 24 }, (_, h) => ({ start: h, length }))
}

export function patternLabel(p) {
  const endHour = (p.start + p.length) % 24
  const fmt = h => `${String(h).padStart(2, '0')}:00`
  return `${fmt(p.start)}-${fmt(endHour)}`
}
